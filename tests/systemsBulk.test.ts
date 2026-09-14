// Changing several systems at once, through the real action.
//
// The registry's checkboxes set a client, a type, a lead or the archive on a
// batch. Each system goes through its own single-record action, so what is
// pinned here is the batch shape: every system changed, a refusal reported
// by id without stopping the rest, and the audit trail one line per system.
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

const SIERRA = 3, LABZEN = 7;
const STAFF: Who = {
  email: "bill@sierra.test", name: "Bill Reyes", role: "staff",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: SIERRA,
};

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator, parent_org_id) VALUES
      (${SIERRA}, 'Sierra Spectra', 'provider', true, NULL),
      (${LABZEN}, 'LabZen', 'client', false, ${SIERRA});
    SELECT setval('orgs_id_seq', 100);
    INSERT INTO house_members (email, org_id, role, name) VALUES ('bill@sierra.test', ${SIERRA}, 'staff', 'Bill Reyes');
  `);
});

beforeEach(async () => {
  who = STAFF;
  await client.exec(`
    DELETE FROM audit_log; DELETE FROM system_shares; DELETE FROM instruments;
    INSERT INTO instruments (id, tenant_org_id, external_id, client, model, category) VALUES
      (21, ${SIERRA}, 'G-010', 'GMI', '', ''),
      (22, ${SIERRA}, 'G-011', 'GMI', '', ''),
      (23, ${SIERRA}, 'G-012', '', '', 'GC');
  `);
});

// app/actions is a large module and a type change re-applies the catalog's
// procedures per system; the first call pays for both, and PGlite is not
// quick about it.
const SLOW = 30_000;

const systems = async () => (await testDb.select().from(schema.instruments)).sort((a, b) => a.id - b.id);

describe("changing several systems at once", () => {
  it("sets the type and the client on every ticked system, one audit line each", async () => {
    const { updateSystems } = await import("@/app/actions");
    const res = await updateSystems([21, 22, 23], { category: "LC-MS" });
    expect(res).toEqual({ done: 3, failures: [] });
    expect((await systems()).map((s) => s.category)).toEqual(["LC-MS", "LC-MS", "LC-MS"]);
    const lines = await testDb.select().from(schema.auditLog);
    expect(lines.filter((l) => l.field === "category")).toHaveLength(3);

    const again = await updateSystems([22, 23], { client: "LabZen" });
    expect(again.done).toBe(2);
    expect((await systems()).map((s) => s.client)).toEqual(["GMI", "LabZen", "LabZen"]);
  }, SLOW);

  it("archives a batch, and clears a value with an empty string", async () => {
    const { updateSystems } = await import("@/app/actions");
    expect((await updateSystems([21, 22], { archived: true })).done).toBe(2);
    expect((await systems()).map((s) => s.archived)).toEqual([true, true, false]);
    expect((await updateSystems([23], { category: "" })).done).toBe(1);
    expect((await systems())[2].category).toBe("");
  }, SLOW);

  it("reports the system that refused, by id, and still does the rest", async () => {
    const { updateSystems } = await import("@/app/actions");
    // Nobody by that name is assignable, so the lead is refused - on every
    // system, since it is the same lead each time - while nothing else breaks.
    const res = await updateSystems([21, 999], { lead: "Nobody Here" });
    expect(res.done).toBe(0);
    expect(res.failures?.map((f) => f.id).sort()).toEqual([21, 999]);
    expect(res.failures?.every((f) => f.error)).toBe(true);
  }, SLOW);

  it("hands a batch to an organization, sharing it and following the label", async () => {
    const { updateSystems } = await import("@/app/actions");
    // G-010 and G-011 are labelled "GMI", set by hand, so that label stands;
    // G-012's is blank, which was tracking ownership, so it follows.
    const res = await updateSystems([21, 22, 23], { ownerOrgId: LABZEN });
    expect(res).toEqual({ done: 3, failures: [] });
    const after = await systems();
    expect(after.map((s) => s.ownerOrgId)).toEqual([LABZEN, LABZEN, LABZEN]);
    expect(after.map((s) => s.client)).toEqual(["GMI", "GMI", "LabZen"]);
    // An owner who cannot see what they own helps nobody.
    const shares = await testDb.select().from(schema.systemShares);
    expect(shares.filter((s) => s.orgId === LABZEN).map((s) => s.instrumentId).sort()).toEqual([21, 22, 23]);
    expect((await testDb.select().from(schema.auditLog)).filter((l) => l.field === "owner")).toHaveLength(3);
  }, SLOW);

  it("returns a batch to house stewardship, and reports a system that is not there", async () => {
    const { updateSystems } = await import("@/app/actions");
    await updateSystems([21, 22], { ownerOrgId: LABZEN });
    const res = await updateSystems([21, 22, 999], { ownerOrgId: null });
    expect(res.done).toBe(2);
    expect(res.failures).toEqual([{ id: 999, error: "Not found" }]);
    expect((await systems()).map((s) => s.ownerOrgId)).toEqual([null, null, null]);
  }, SLOW);

  it("refuses an empty selection and an empty change", async () => {
    const { updateSystems } = await import("@/app/actions");
    expect((await updateSystems([], { category: "GC" })).error).toBe("Nothing selected");
    expect((await updateSystems([21], {})).error).toBe("Nothing to change");
  }, SLOW);
});
