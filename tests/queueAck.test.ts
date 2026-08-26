// Who may dismiss a handback, and what a dismissal is worth.
//
// The queue used to announce every system it held as a chore on the holder's
// list, so a shop that finished a job and handed a system back told the client
// "Sierra Spectra is waiting on you" about work that was done. Gating the chore
// on something-being-pending fixed that and opened a gap: a system parked with
// a written reason and nothing open raises nothing at all.
//
// A dismissible notification is what closes it. The line gets to say its piece
// once, the holder closes it, and the closing is RECORDED - which is the only
// signal the shop has ever had that a handback reached a human. That last part
// is why this runs against a real Postgres: the guarantee is in the WHERE
// clause and in who the door lets through, and a stubbed database would only
// prove that my mock refuses.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });

/** Only the SESSION is faked, so the real requireEditor runs against it. */
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
vi.mock("@/lib/notify", () => ({
  notifyTaskAssigned: async () => {}, notifyInvite: async () => {}, notifyQueueKick: async () => {},
}));

const HOLDER: Who = {
  email: "maria@labzen.test", name: "Maria Chen", role: "client_editor",
  orgId: 1, operatorOrgId: null, rootOperatorOrgId: null,
};
const HOLDER_VIEWER: Who = {
  email: "tech@labzen.test", name: "A Tech", role: "client_viewer",
  orgId: 1, operatorOrgId: null, rootOperatorOrgId: null,
};
const OTHER_CLIENT: Who = {
  email: "dana@coastal.test", name: "Dana", role: "client_editor",
  orgId: 2, operatorOrgId: null, rootOperatorOrgId: null,
};
const STAFF: Who = {
  email: "bill@sierra.test", name: "Bill", role: "staff",
  orgId: 3, operatorOrgId: 3, rootOperatorOrgId: 3,
};

/* LZ-001 is parked with Lab Zen, the way a finished job leaves the shop's
   board. LZ-002 stays in the house queue, for the case where nobody outside
   has been handed anything. Both are shared with Lab Zen, because client
   visibility comes from a share and not from ownership. */
const RESET = `
  DELETE FROM queue_events; DELETE FROM system_shares; DELETE FROM instruments;
  INSERT INTO instruments (id, external_id, client, model, owner_org_id, tenant_org_id, queue_org_id, queue_reason, queue_since)
    VALUES (1, 'LZ-001', 'Lab Zen', '6495C', 1, 3, 1, 'Back with you - annual PM finished', now()),
           (2, 'LZ-002', 'Lab Zen', 'ISQ 7000', 1, 3, NULL, '', now());
  INSERT INTO system_shares (instrument_id, org_id, access)
    VALUES (1, 1, 'edit'), (2, 1, 'edit');
`;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind) VALUES
      (1, 'Lab Zen', 'client'), (2, 'Coastal Analytical', 'client'), (3, 'Sierra Spectra', 'provider');
  `);
});

beforeEach(async () => {
  who = null;
  await client.exec(RESET);
});

const ackOf = async (id: number) =>
  (await client.query<{ queue_ack_at: Date | null; queue_ack_by: string }>(
    `SELECT queue_ack_at, queue_ack_by FROM instruments WHERE id = ${id}`)).rows[0];

describe("dismissing a handback", () => {
  it("lets the organization holding it say they have seen it", async () => {
    who = HOLDER;
    const { ackQueueHandback } = await import("@/app/actions");
    expect((await ackQueueHandback(1)).error).toBeUndefined();
    const row = await ackOf(1);
    expect(row.queue_ack_at).not.toBeNull();
    // Recorded, not hidden in a browser: the name is the whole point, because
    // it is the shop's only evidence the handback reached a person.
    expect(row.queue_ack_by).toBe("maria@labzen.test");
  });

  it("REFUSES an organization that is not holding it", async () => {
    // Coastal cannot even see LZ-001, so this must read as absent rather than
    // as forbidden - a refusal that confirms the record exists is a leak.
    who = OTHER_CLIENT;
    const { ackQueueHandback } = await import("@/app/actions");
    expect((await ackQueueHandback(1)).error).toMatch(/not found/i);
    expect((await ackOf(1)).queue_ack_at).toBeNull();
  });

  it("REFUSES the shop for a queue the client is holding", async () => {
    /* canKick deliberately also admits the operator and the owner, so gating
       this on "may you move it" would have let the shop mark its own message
       as read. The audience is whoever it was said TO. */
    who = STAFF;
    const { ackQueueHandback } = await import("@/app/actions");
    expect((await ackQueueHandback(1)).error).toMatch(/holding/i);
    expect((await ackOf(1)).queue_ack_at).toBeNull();
  });

  it("lets the shop dismiss its own queue's line", async () => {
    // The house queue is queue_org_id NULL. Nothing offers this in the UI
    // today, but the rule is "whoever holds it", and staff hold that one.
    who = STAFF;
    const { ackQueueHandback } = await import("@/app/actions");
    expect((await ackQueueHandback(2)).error).toBeUndefined();
    expect((await ackOf(2)).queue_ack_at).not.toBeNull();
  });

  it("REFUSES a read-only account at the holding organization", async () => {
    /* It is a write on the shared record, seen by the shop and by their own
       colleagues, so it takes the same role every other write does. The page
       does not offer them the button either - see `dismissible`, which is
       gated on canEdit - so this is the door behind the door. */
    who = HOLDER_VIEWER;
    const { ackQueueHandback } = await import("@/app/actions");
    await expect(ackQueueHandback(1)).rejects.toThrow(/read-only/i);
    expect((await ackOf(1)).queue_ack_at).toBeNull();
  });

  it("refuses a signed-out caller", async () => {
    who = null;
    const { ackQueueHandback } = await import("@/app/actions");
    await expect(ackQueueHandback(1)).rejects.toThrow();
  });

  it("keeps the first name when a colleague dismisses it again", async () => {
    who = HOLDER;
    const { ackQueueHandback } = await import("@/app/actions");
    await ackQueueHandback(1);
    const first = await ackOf(1);
    who = { ...HOLDER, email: "sam@labzen.test", name: "Sam" };
    // Not an error: the line is gone either way, and re-reading a notice is
    // not a second event.
    expect((await ackQueueHandback(1)).error).toBeUndefined();
    expect(await ackOf(1)).toEqual(first);
  });
});

describe("a dismissal belongs to the leg that earned it", () => {
  it("clears on the next move, so the NEXT handback still announces itself", async () => {
    /* The failure this prevents is the worst kind: silent. A client who
       dismissed one handback would never be told about any that followed, and
       the shop would see a read receipt from a month ago sitting under a note
       written this morning. */
    who = HOLDER;
    const actions = await import("@/app/actions");
    await actions.ackQueueHandback(1);
    expect((await ackOf(1)).queue_ack_at).not.toBeNull();

    who = STAFF;
    // Back to the shop, then out to the client again with something new to say.
    expect((await actions.kickToQueue(1, null, "Taking it back for the source clean")).error)
      .toBeUndefined();
    expect(await ackOf(1)).toMatchObject({ queue_ack_at: null, queue_ack_by: "" });
    expect((await actions.kickToQueue(1, 1, "Source clean done - back with you")).error)
      .toBeUndefined();
    expect((await ackOf(1)).queue_ack_at).toBeNull();
  });
});
