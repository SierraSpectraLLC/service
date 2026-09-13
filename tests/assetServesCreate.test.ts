// Plumbing a stack as it is entered, through the real actions.
//
// "I should be able to add three assets at once: Mass Spec, Roughing Pump A
// and Roughing Pump B - both pumps serve the Mass Spec. Making that
// connection needs fewer steps." One Save, and the pumps point at the spec;
// the single form does the same for a unit joining a stack that exists.
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
const SYSTEM = 21;

const unit = (kind: string, model: string, over: Record<string, unknown> = {}) => ({
  kind, model, serial: "", manufacturer: "", owner: "", asFound: "", location: "", note: "", ...over,
});

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES (${SIERRA}, 'Sierra Spectra', 'provider', true);
    SELECT setval('orgs_id_seq', 100);
    INSERT INTO house_members (email, org_id, role, name) VALUES ('bill@sierra.test', ${SIERRA}, 'staff', 'Bill Reyes');
    INSERT INTO instruments (id, tenant_org_id, external_id, client, model) VALUES (${SYSTEM}, ${SIERRA}, 'G-010', 'GMI', '');
    SELECT setval('instruments_id_seq', 100);
  `);
});

beforeEach(async () => {
  who = STAFF;
  await client.exec("DELETE FROM tasks; DELETE FROM asset_events; DELETE FROM assets;");
});

const rows = async () => (await testDb.select().from(schema.assets)).sort((a, b) => a.id - b.id);

describe("a stack entered in one go", () => {
  it("plumbs the pumps to the mass spec by its row", async () => {
    const { createAssets } = await import("@/app/actions");
    const res = await createAssets(SYSTEM, [
      unit("Mass Spec", "LCMS-8050"),
      unit("Pump", "nXDS15i", { servesRow: 1, servesRole: "fore-line" }),
      unit("Pump", "nXDS15i", { servesRow: 1, servesRole: "interface" }),
    ]);
    expect(res.error).toBeUndefined();
    expect(res.created).toBe(3);
    expect(res.linkFailures).toEqual([]);
    const [spec, a, b] = await rows();
    expect(spec.servesAssetId).toBeNull();
    expect(a.servesAssetId).toBe(spec.id);
    expect(a.servesRole).toBe("fore-line");
    expect(b.servesAssetId).toBe(spec.id);
    expect(b.servesRole).toBe("interface");
  });

  it("names the row whose module did not save, and keeps the pump", async () => {
    const { createAssets } = await import("@/app/actions");
    const res = await createAssets(SYSTEM, [
      // No model and no serial: not saved.
      unit("Mass Spec", ""),
      unit("Pump", "nXDS15i", { servesRow: 1 }),
    ]);
    // The spec never made it into the batch at all (createAssets drops it as
    // unusable), so the pump's row 1 IS the pump - which is refused as itself.
    expect(res.created).toBe(1);
    expect(res.linkFailures).toEqual([{ row: 1, error: "A unit can't serve itself." }]);
    const [pump] = await rows();
    expect(pump.servesAssetId).toBeNull();
  });

  it("keeps depth at one when the batch tries a chain", async () => {
    const { createAssets } = await import("@/app/actions");
    const res = await createAssets(SYSTEM, [
      unit("Mass Spec", "LCMS-8050"),
      unit("Pump", "nXDS15i", { servesRow: 1 }),
      unit("Oil mist filter", "EMF10", { servesRow: 2 }),
    ]);
    expect(res.created).toBe(3);
    expect(res.linkFailures).toEqual([
      { row: 3, error: "That module already serves something else - a support unit can't have one of its own." },
    ]);
  });

  it("does nothing about serving for shelf stock", async () => {
    const { createAssets } = await import("@/app/actions");
    const res = await createAssets(null, [unit("Mass Spec", "LCMS-8050"), unit("Pump", "nXDS15i", { servesRow: 1 })]);
    expect(res.created).toBe(2);
    expect(res.linkFailures).toEqual([]);
    expect((await rows()).every((a) => a.servesAssetId === null)).toBe(true);
  });
});

describe("one unit joining a stack", () => {
  it("serves the module it named, as it is added", async () => {
    const { createAsset } = await import("@/app/actions");
    const spec = await createAsset(SYSTEM, unit("Mass Spec", "LCMS-8050"));
    const res = await createAsset(SYSTEM, unit("Pump", "nXDS15i", { servesAssetId: spec.id, servesRole: "fore-line" }));
    expect(res.error).toBeUndefined();
    const pump = (await rows()).find((a) => a.id === res.id)!;
    expect(pump.servesAssetId).toBe(spec.id);
    expect(pump.servesRole).toBe("fore-line");
  });

  it("refuses the whole add when the link would be refused, so nothing is half-entered", async () => {
    const { createAsset } = await import("@/app/actions");
    const spec = await createAsset(SYSTEM, unit("Mass Spec", "LCMS-8050"));
    const pump = await createAsset(SYSTEM, unit("Pump", "nXDS15i", { servesAssetId: spec.id }));
    const res = await createAsset(SYSTEM, unit("Filter", "EMF10", { servesAssetId: pump.id }));
    expect(res.error).toMatch(/already serves something else/);
    expect(await rows()).toHaveLength(2);
    // And a module that is not on this system at all.
    expect((await createAsset(SYSTEM, unit("Filter", "EMF10", { servesAssetId: 9999 }))).error)
      .toBe("That module isn't on this system.");
  });
});
