// Putting a system on the books, through the real action.
//
// The registry - the flat list of every system on record - was the one page
// that could not put a system on it. Adding the form there made the action's
// return shape matter: the one thing somebody typing a tag gets wrong is a
// tag already in use, and that used to hit the column's unique constraint and
// reach the browser as a crash. What is pinned here is that it comes back as
// a sentence, and that a refused create leaves nothing behind.
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

const SIERRA = 3;
const STAFF: Who = {
  email: "bill@sierra.test", name: "Bill Reyes", role: "staff",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: SIERRA,
};
const LABZEN = 4, RIVAL = 5, CASCADE = 6;
/** A client's own editor: may add their systems, may not say whose they are. */
const THEIRS: Who = {
  email: "ada@labzen.test", name: "Ada Park", role: "client_editor",
  orgId: LABZEN, operatorOrgId: null, rootOperatorOrgId: SIERRA,
};
/**
 * Another service company's staff. Sierra runs the instance, so ITS staff are
 * platform staff and see every workspace by design - the cross-workspace
 * boundary only exists to be crossed from somewhere else.
 */
const OTHER_SHOP: Who = {
  email: "sam@cascade.test", name: "Sam Ortiz", role: "staff",
  orgId: null, operatorOrgId: CASCADE, rootOperatorOrgId: SIERRA,
};

// app/actions is a large module and a create applies the catalog's procedures
// and gases; PGlite is not quick about it.
const SLOW = 30_000;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator, parent_org_id) VALUES
      (${SIERRA},  'Sierra Spectra',     'provider', true,  NULL),
      (${LABZEN},  'LabZen',             'client',   false, ${SIERRA}),
      (${RIVAL},   'Rival Labs',         'client',   false, ${CASCADE}),
      (${CASCADE}, 'Cascade Instrument', 'provider', true,  NULL);
    SELECT setval('orgs_id_seq', 100);
    INSERT INTO house_members (email, org_id, role, name) VALUES ('bill@sierra.test', ${SIERRA}, 'staff', 'Bill Reyes');
  `);
});

beforeEach(async () => {
  who = STAFF;
  await client.exec("DELETE FROM stage_events; DELETE FROM audit_log; DELETE FROM system_shares; DELETE FROM instruments;");
});

const systems = async () => testDb.select().from(schema.instruments);

describe("adding a system", () => {
  it("returns the new id, and the row is on the books", async () => {
    const { createInstrument } = await import("@/app/actions");
    const res = await createInstrument({ externalId: "G-012", client: "GMI", category: "GC-MS", priority: 11 });
    expect(res.error).toBeUndefined();
    expect(typeof res.id).toBe("number");
    const [made] = await systems();
    expect(made.externalId).toBe("G-012");
    expect(made.client).toBe("GMI");
    expect(made.category).toBe("GC-MS");
    expect(made.priority).toBe(11);
    // It starts where a system starts, so the board has somewhere to show it.
    expect(made.stages).toEqual(["Intake"]);
  }, SLOW);

  it("refuses a tag already on the books - as a sentence, not a crash", async () => {
    const { createInstrument } = await import("@/app/actions");
    await createInstrument({ externalId: "G-012", client: "GMI", priority: 99 });
    const again = await createInstrument({ externalId: "G-012", client: "Someone else", priority: 99 });
    expect(again.id).toBeUndefined();
    expect(again.error).toBe("G-012 is already used by another system");
    // And the near-miss, which is the same machine to everybody who reads it.
    const cased = await createInstrument({ externalId: " g-012 ", client: "", priority: 99 });
    expect(cased.error).toBe("G-012 is already used by another system");
    expect(await systems()).toHaveLength(1);
  }, SLOW);

  it("refuses a blank tag and an overlong one, writing nothing", async () => {
    const { createInstrument } = await import("@/app/actions");
    expect((await createInstrument({ externalId: "   ", client: "GMI", priority: 99 })).error)
      .toBe("System ID required");
    expect((await createInstrument({ externalId: "G".repeat(41), client: "", priority: 99 })).error)
      .toBe("System ID must be 40 characters or fewer");
    expect(await systems()).toHaveLength(0);
  }, SLOW);

  it("trims the tag it stores, so a pasted one does not carry its spaces", async () => {
    const { createInstrument } = await import("@/app/actions");
    const res = await createInstrument({ externalId: "  T-004  ", client: "  MID  ", priority: 0 });
    expect(res.error).toBeUndefined();
    const [made] = await systems();
    expect(made.externalId).toBe("T-004");
    expect(made.client).toBe("MID");
    // No priority given is the default, not a zero.
    expect(made.priority).toBe(99);
  }, SLOW);

  it("drops a lead nobody can be notified at, rather than recording a ghost", async () => {
    const { createInstrument } = await import("@/app/actions");
    await createInstrument({ externalId: "G-013", client: "", priority: 99, lead: "Nobody Here" });
    expect((await systems())[0].lead).toBe("");
    await createInstrument({ externalId: "G-014", client: "", priority: 99, lead: "Bill Reyes" });
    expect((await systems()).find((s) => s.externalId === "G-014")?.lead).toBe("Bill Reyes");
  }, SLOW);
});

/**
 * A system added from a client's own Fleet tab belongs to that client.
 *
 * The tab lists a client's machines and had no way to put one on the list:
 * adding meant the registry, and then coming back to say whose it was - the
 * second step that gets skipped, which is how a fleet page ends up empty
 * beside a client who has six instruments.
 */
describe("a system added for a client", () => {
  it("lands owned by them, shared with them, and named for them", async () => {
    const { createInstrument } = await import("@/app/actions");
    const res = await createInstrument({
      externalId: "T-003", client: "", category: "LC-MS", priority: 11, ownerOrgId: LABZEN,
    });
    expect(res.error).toBeUndefined();
    const [made] = await systems();
    expect(made.ownerOrgId).toBe(LABZEN);
    // A blank label follows ownership, so the registry does not head their
    // own machine "(no client)" - see lib/owner.clientAfterHandoff.
    expect(made.client).toBe("LabZen");
    // An owner who cannot see their own system helps nobody.
    const shares = await testDb.select().from(schema.systemShares);
    expect(shares.some((x) => x.orgId === LABZEN && x.instrumentId === made.id)).toBe(true);
  }, SLOW);

  it("keeps a label somebody typed themselves", async () => {
    const { createInstrument } = await import("@/app/actions");
    await createInstrument({
      externalId: "T-004", client: "Berkeley loan", category: "", priority: 11, ownerOrgId: LABZEN,
    });
    const [made] = await systems();
    expect(made.ownerOrgId).toBe(LABZEN);
    expect(made.client).toBe("Berkeley loan");
  }, SLOW);

  it("refuses an owner outside this workspace, and writes nothing", async () => {
    who = OTHER_SHOP;
    const { createInstrument } = await import("@/app/actions");
    // LabZen is Sierra's client, not Cascade's.
    const res = await createInstrument({
      externalId: "T-005", client: "", category: "", priority: 11, ownerOrgId: LABZEN,
    });
    expect(res.error).toBe("Not found");
    expect(await systems()).toHaveLength(0);
    // Their own client is theirs to name.
    const ok = await createInstrument({
      externalId: "T-005", client: "", category: "", priority: 11, ownerOrgId: RIVAL,
    });
    expect(ok.error).toBeUndefined();
  }, SLOW);

  it("refuses a client editor naming an owner - whose it is, is the shop's to say", async () => {
    who = THEIRS;
    const { createInstrument } = await import("@/app/actions");
    const res = await createInstrument({
      externalId: "T-006", client: "", category: "", priority: 11, ownerOrgId: LABZEN,
    });
    expect(res.error).toMatch(/shop/i);
    expect(await systems()).toHaveLength(0);
  }, SLOW);

  it("is unchanged when no owner is named - the registry's own form", async () => {
    const { createInstrument } = await import("@/app/actions");
    await createInstrument({ externalId: "T-007", client: "GMI", category: "", priority: 11 });
    const [made] = await systems();
    expect(made.ownerOrgId).toBeNull();
    expect(made.client).toBe("GMI");
  }, SLOW);
});
