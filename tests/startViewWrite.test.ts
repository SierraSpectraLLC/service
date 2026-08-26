// Forcing a starting view, and refusing one the company does not have.
//
// The picker is only drawn for a reselling organization, but a picker is
// decoration: the rule has to hold at the write. Two things can outlive the
// screen that set them - a request made against a stale page, and a stored
// answer whose organization has since stopped reselling - and only one of them
// is fixed here. This file covers the write; lib/viewMode clamps the read, and
// BOTH are needed, because turning resale off does not walk the rows that were
// legitimately written while it was on.
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

const OWNER: Who = {
  email: "dev@sierra.test", name: "Dev", role: "owner",
  orgId: 3, operatorOrgId: 3, rootOperatorOrgId: 3,
};

/* Org 1 is a plain lab. Org 2 resells. One person at each. */
const RESET = `
  DELETE FROM client_allowlist; DELETE FROM users; DELETE FROM audit_log;
  UPDATE orgs SET resale_enabled = false WHERE id = 1;
  UPDATE orgs SET resale_enabled = true WHERE id = 2;
  INSERT INTO client_allowlist (id, entry, org_id) VALUES
    (1, 'thomas@labzen.test', 1),
    (2, 'accounts@coastal.test', 2);
`;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator, parent_org_id) VALUES
      (1, 'Lab Zen', 'client', false, 3), (2, 'Coastal Analytical', 'client', false, 3),
      (3, 'Sierra Spectra', 'provider', true, NULL),
      (99, 'Rival Instruments', 'provider', true, 3);
    SELECT setval('orgs_id_seq', 200);
  `);
});

beforeEach(async () => {
  who = null;
  await client.exec(RESET);
});

const startOf = async (id: number) =>
  (await client.query<{ start_view: string }>(
    `SELECT start_view FROM client_allowlist WHERE id = $1`, [id])).rows[0]?.start_view;

describe("starting a person somewhere on purpose", () => {
  it("STARTS A COO ON EQUIPMENT AT A RESELLING COMPANY", async () => {
    // The reported case: he runs the instruments, his company sells them, and
    // he should not have to find a menu on his first morning to stop being
    // shown a pipeline of stock.
    who = OWNER;
    const { setStartView } = await import("@/app/actions");
    expect(await setStartView(2, "lab")).toEqual({});
    expect(await startOf(2)).toBe("lab");
  });

  it("clears back to the company's default", async () => {
    who = OWNER;
    const { setStartView } = await import("@/app/actions");
    await setStartView(2, "lab");
    expect(await setStartView(2, "")).toEqual({});
    expect(await startOf(2)).toBe("");
  });

  it("writes an audit line naming the view in words", async () => {
    // "start_view = lab" is a column. The log is read by somebody asking why
    // a person's screen changed, and the answer has to be a sentence.
    who = OWNER;
    const { setStartView } = await import("@/app/actions");
    await setStartView(2, "lab");
    const log = (await client.query<{ action: string; field: string }>(
      `SELECT action, field FROM audit_log ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(log?.field).toBe("start_view");
    expect(log?.action).toMatch(/accounts@coastal\.test .*equipment/i);
  });
});

describe("a standard client cannot be started on a reseller screen", () => {
  it("REFUSES THE PIPELINE FOR A COMPANY THAT DOES NOT SELL", async () => {
    /* The picker is not drawn for org 1 at all, so this can only arrive from a
       stale page or a hand-made request - which is exactly why the refusal
       lives here and not only in the markup. */
    who = OWNER;
    const { setStartView } = await import("@/app/actions");
    expect((await setStartView(1, "reseller")).error).toMatch(/isn't a view this organization has/);
    expect(await startOf(1)).toBe("");
  });

  it("still lets that company's people be started on the equipment view", async () => {
    // The refusal is about the view the company lacks, not about the setting.
    who = OWNER;
    const { setStartView } = await import("@/app/actions");
    expect(await setStartView(1, "lab")).toEqual({});
    expect(await startOf(1)).toBe("lab");
  });

  it("lets a start view be CLEARED even where it could not be set", async () => {
    /* If resale is turned off while somebody carries a pipeline start view,
       the clear must not be refused by the same rule that now rejects the
       value - that would strand the row with no way back through the UI. */
    who = OWNER;
    const { setStartView } = await import("@/app/actions");
    await setStartView(2, "reseller");
    await client.exec(`UPDATE orgs SET resale_enabled = false WHERE id = 2`);
    expect(await setStartView(2, "")).toEqual({});
    expect(await startOf(2)).toBe("");
  });

  it("refuses a mode that is not a view at all", async () => {
    who = OWNER;
    const { setStartView } = await import("@/app/actions");
    expect((await setStartView(2, "engineer")).error).toMatch(/Unknown view/);
    expect(await startOf(2)).toBe("");
  });
});

describe("who may set it", () => {
  it("refuses somebody with no admin hold on that organization", async () => {
    // Same gate as every other per-person setting on that page.
    /* A sub-operator on the same instance: their own workspace is org 99, but
       the platform above them is still Sierra Spectra. Giving them
       rootOperatorOrgId 99 instead would make them PLATFORM staff, who may
       administer everybody by design - and the test would pass for the wrong
       reason. */
    who = { ...OWNER, email: "other@rival.test", role: "staff",
      orgId: 99, operatorOrgId: 99, rootOperatorOrgId: 3 };
    const { setStartView } = await import("@/app/actions");
    expect((await setStartView(2, "lab")).error).toBe("Not found");
    expect(await startOf(2)).toBe("");
  });

  it("refuses a row that does not exist", async () => {
    who = OWNER;
    const { setStartView } = await import("@/app/actions");
    expect((await setStartView(9999, "lab")).error).toBe("Not found");
  });
});

describe("the tour that teaches the switch", () => {
  it("is stamped once, and the stamp is what stops it coming back", async () => {
    await client.exec(
      `INSERT INTO users (id, email, name, role)
         VALUES ('u-dana', 'accounts@coastal.test', 'Dana', 'client_editor')`);
    who = { email: "accounts@coastal.test", name: "Dana", role: "client_editor",
      orgId: 2, operatorOrgId: 3, rootOperatorOrgId: 3 };
    const { dismissViewTour } = await import("@/app/actions");
    expect(await dismissViewTour()).toEqual({});
    const seen = (await client.query<{ view_tour_at: string | null }>(
      `SELECT view_tour_at FROM users WHERE email = 'accounts@coastal.test'`)).rows[0];
    expect(seen?.view_tour_at).toBeTruthy();
  });
});
