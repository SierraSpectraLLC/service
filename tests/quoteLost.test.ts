// The shop's own way out of a quote, and what it must not be allowed to do.
//
// Until this existed, the only door out of "awaiting client" that was not a yes
// belonged to the client: they pressed Decline on the share page, or they let
// the quote lapse. What actually happens is a phone call - "we went with the
// OEM", "the capital request was pulled" - and the quote then sat in the
// pipeline's quoted figure and on the morning chase list until its expiry date
// quietly rescued it, at which point it read as "expired", which records that
// nobody answered rather than what happened.
//
// Three things are worth a real database rather than a stub, and they are what
// this file is about:
//
//   THE TWO LOSSES STAY APART. Rejected is somebody reading the price and
//   saying no; not awarded is the work going elsewhere. A shop that files both
//   under one word can never tell whether it is losing on price.
//
//   IT DOES NOT SIGN FOR THE CLIENT. answered_by is who at the client told us;
//   closed_by is which of us was told. Collapsing those would turn "we heard on
//   a call" into "the client declined this in writing", forever.
//
//   IT CANNOT REACH ANOTHER WORKSPACE, and it cannot unwind an approval that
//   may have raised a deposit invoice and opened a job.
//
// Same in-process PGlite as quoteApproval.test.ts, seeded from the same
// drizzle/schema-sync.sql every deploy applies - the guarantees under test are
// in WHERE clauses and in a role check, and a stubbed database would only prove
// that my mock refuses.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });

type Who = {
  email: string; name: string; role: string;
  orgId: number | null; operatorOrgId: number | null; rootOperatorOrgId: number | null;
} | null;
let who: Who = null;

vi.mock("@/db", () => ({ db: testDb }));
vi.mock("@/auth", () => ({ auth: async () => (who ? { user: who } : null) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));
vi.mock("@/lib/notify", () => ({ notifyTaskAssigned: async () => {}, notifyInvite: async () => {} }));

/** Sierra Spectra's own staff. Not platform staff, so reads are scoped to org 3. */
const STAFF: Who = {
  email: "maria@sierra.test", name: "Maria Ortiz", role: "staff",
  orgId: null, operatorOrgId: 3, rootOperatorOrgId: 9,
};
const CLIENT_EDITOR: Who = {
  email: "chen@labzen.test", name: "Dr. Chen", role: "client_editor",
  orgId: 1, operatorOrgId: null, rootOperatorOrgId: null,
};

/*
 * Q-1001 is live and ours. Q-1002 belongs to another operator's workspace.
 * Q-1003 lapsed a long time ago - the tidy-up case. Q-1004 was approved.
 * Q-1005 has never been sent.
 */
const RESET = `
  DELETE FROM work_order_notes; DELETE FROM audit_log;
  DELETE FROM quote_lines; DELETE FROM quotes;
  INSERT INTO quotes (id, org_id, tenant_org_id, work_order_id, number, title, status, sent_on, expires_on, deposit_pct)
    VALUES (10, 1, 3, 1,    'Q-1001', 'Ion source rebuild', 'sent',     '2026-08-01', '2099-12-31', 0),
           (11, 2, 4, NULL, 'Q-1002', 'Column swap',        'sent',     '2026-08-01', '2099-12-31', 0),
           (12, 1, 3, NULL, 'Q-1003', 'Detector service',   'sent',     '2024-01-05', '2024-02-05', 0),
           (13, 1, 3, NULL, 'Q-1004', 'Turbo exchange',     'approved', '2026-08-01', '2099-12-31', 0),
           (14, 1, 3, NULL, 'Q-1005', 'Bench time',         'draft',    '',           '2099-12-31', 0);
  INSERT INTO quote_lines (quote_id, kind, description, qty, unit_cents, covered, position)
    VALUES (10, 'labor', 'Rebuild', 1000, 428000, false, 0);
`;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind) VALUES
      (1, 'Lab Zen', 'client'), (2, 'Coastal Analytical', 'client'),
      (3, 'Sierra Spectra', 'provider'), (4, 'Cascade Instrument', 'provider'),
      (9, 'Platform', 'provider');
    INSERT INTO work_orders (id, org_id, tenant_org_id, number, title, state)
      VALUES (1, 1, 3, 'WO-1', 'Ion source rebuild', 'waiting');
  `);
});

beforeEach(async () => {
  who = STAFF;
  await client.exec(RESET);
});

type Row = {
  status: string; answered_on: string | null; answered_by: string;
  answer_note: string; closed_by: string;
};
const quoteRow = async (id: number) =>
  (await client.query<Row>(
    `SELECT status, answered_on, answered_by, answer_note, closed_by FROM quotes WHERE id = ${id}`,
  )).rows[0];

const jobNotes = async () =>
  (await client.query<{ text: string; author_email: string }>(
    "SELECT text, author_email FROM work_order_notes ORDER BY id")).rows;

const trail = async () =>
  (await client.query<{ action: string; actor: string; old_value: string; new_value: string }>(
    "SELECT action, actor, old_value, new_value FROM audit_log WHERE entity_type = 'quote' ORDER BY id")).rows;

describe("closing a quote as lost", () => {
  it("records a rejection against the quote without signing for the client", async () => {
    const { closeQuoteAsLost } = await import("@/app/actions");
    const res = await closeQuoteAsLost(10, {
      outcome: "declined", reason: "Too expensive against the OEM", heardFrom: "Dr. Chen",
    });
    expect(res.error).toBeUndefined();

    const row = await quoteRow(10);
    expect(row.status).toBe("declined");
    expect(row.answer_note).toBe("Too expensive against the OEM");
    // Who at the client told us, and which of us was told. Two fields, because
    // "Dr. Chen declined this" and "Dr. Chen told Maria" are different claims.
    expect(row.answered_by).toBe("Dr. Chen");
    expect(row.closed_by).toBe("maria@sierra.test");
    expect(row.answered_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("keeps not-awarded apart from rejected", async () => {
    const { closeQuoteAsLost } = await import("@/app/actions");
    await closeQuoteAsLost(10, { outcome: "unawarded", reason: "Went to the OEM on lead time" });
    expect((await quoteRow(10)).status).toBe("unawarded");
    // Nobody named is the ordinary case, and the client's side must not be left
    // holding a staff member's name.
    expect((await quoteRow(10)).answered_by).toBe("the client");
  });

  it("tells the engineer holding the job, and leaves the job's own state alone", async () => {
    const { closeQuoteAsLost } = await import("@/app/actions");
    await closeQuoteAsLost(10, {
      outcome: "unawarded", reason: "Capital request pulled", heardFrom: "Dr. Chen",
    });
    const notes = await jobNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe("Q-1001 was not awarded - Dr. Chen told us: Capital request pulled");
    expect(notes[0].author_email).toBe("maria@sierra.test");
    // What happens to a job whose quote was lost is a decision, made on the job.
    const wo = await client.query<{ state: string }>("SELECT state FROM work_orders WHERE id = 1");
    expect(wo.rows[0].state).toBe("waiting");
  });

  it("writes one audit line naming the staff member, the outcome, and the reason", async () => {
    const { closeQuoteAsLost } = await import("@/app/actions");
    await closeQuoteAsLost(10, { outcome: "unawarded", reason: "Went to the OEM" });
    const rows = await trail();
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe("maria@sierra.test");
    expect(rows[0].action).toContain("Q-1001 was not awarded");
    expect(rows[0].action).toContain("Went to the OEM");
    expect(rows[0].old_value).toBe("sent");
    expect(rows[0].new_value).toBe("unawarded");
  });

  it("closes one that lapsed months ago, which is the whole point of the tidy-up", async () => {
    // "Expired" records that nobody answered in time. It will never record that
    // the job went to the OEM, which is the thing somebody learned afterwards.
    const { closeQuoteAsLost } = await import("@/app/actions");
    const res = await closeQuoteAsLost(12, { outcome: "unawarded", reason: "Awarded to the OEM in March" });
    expect(res.error).toBeUndefined();
    expect((await quoteRow(12)).status).toBe("unawarded");
  });
});

describe("what it refuses", () => {
  it("REFUSES another workspace's quote, and says nothing about it", async () => {
    const { closeQuoteAsLost } = await import("@/app/actions");
    const res = await closeQuoteAsLost(11, { outcome: "declined", reason: "not ours to close" });
    expect(res.error).toBe("Not found");
    expect((await quoteRow(11)).status).toBe("sent");
  });

  it("REFUSES to unwind an approval", async () => {
    // An approved quote may have raised a deposit invoice and put a job into
    // work. Reversing that is a deliberate act, not a status off a menu.
    const { closeQuoteAsLost } = await import("@/app/actions");
    const res = await closeQuoteAsLost(13, { outcome: "declined", reason: "they changed their mind" });
    expect(res.error).toMatch(/approved/i);
    expect((await quoteRow(13)).status).toBe("approved");
  });

  it("refuses a draft, and names the way out", async () => {
    const { closeQuoteAsLost } = await import("@/app/actions");
    const res = await closeQuoteAsLost(14, { outcome: "declined", reason: "never went out" });
    expect(res.error).toMatch(/delete it instead/i);
    expect((await quoteRow(14)).status).toBe("draft");
  });

  it("cannot close the same quote twice - the first answer is the record", async () => {
    const { closeQuoteAsLost } = await import("@/app/actions");
    await closeQuoteAsLost(10, { outcome: "unawarded", reason: "Went to the OEM" });
    const second = await closeQuoteAsLost(10, { outcome: "declined", reason: "changed my mind" });
    expect(second.error).toMatch(/already closed/i);
    const row = await quoteRow(10);
    expect(row.status).toBe("unawarded");
    expect(row.answer_note).toBe("Went to the OEM");
  });

  it("demands a reason - a loss with nothing beside it teaches nobody anything", async () => {
    const { closeQuoteAsLost } = await import("@/app/actions");
    expect((await closeQuoteAsLost(10, { outcome: "declined", reason: "  " })).error).toBeTruthy();
    expect((await quoteRow(10)).status).toBe("sent");
  });

  it("refuses an outcome that is not one of the two losses", async () => {
    // The status column is text. Without this, the one caller that can set it
    // outside the client's own doors could write any word into it - "approved"
    // among them, which would book work nobody agreed to.
    const { closeQuoteAsLost } = await import("@/app/actions");
    for (const outcome of ["approved", "expired", "draft", ""]) {
      const res = await closeQuoteAsLost(10, { outcome, reason: "a good enough reason" });
      expect(res.error).toMatch(/rejected it or it went unawarded/i);
    }
    expect((await quoteRow(10)).status).toBe("sent");
  });

  it("is not a door for the client - this is the shop's own record of a call", async () => {
    who = CLIENT_EDITOR;
    const { closeQuoteAsLost } = await import("@/app/actions");
    await expect(closeQuoteAsLost(10, { outcome: "declined", reason: "we went elsewhere" }))
      .rejects.toThrow();
    expect((await quoteRow(10)).status).toBe("sent");
  });

  it("refuses a signed-out caller", async () => {
    who = null;
    const { closeQuoteAsLost } = await import("@/app/actions");
    await expect(closeQuoteAsLost(10, { outcome: "declined", reason: "nobody at all" }))
      .rejects.toThrow();
    expect((await quoteRow(10)).status).toBe("sent");
  });
});
