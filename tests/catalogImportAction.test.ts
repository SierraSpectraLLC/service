// Importing the equipment catalog, against a real database.
//
// lib/catalogImport decides what every line MEANS; this is about what actually
// lands. Two things can only be tested here, and both are the kind that lose a
// whole afternoon's import when they go wrong:
//
//   vocab_term_unique is (kind, asset_type, name) with NO tenant column. A
//   model another workspace on the instance already defined is invisible to a
//   tenant-scoped plan and fatal to a plain insert - one row would throw and
//   take the other 1999 with it.
//
//   The round trip has to be a genuine no-op. Export, import it straight back,
//   nothing changes - otherwise "export to set the format" hands somebody a
//   file that duplicates their catalog the moment they use it.
//
// Real Postgres, in-process, from the same DDL every deploy applies.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));

type Who = {
  email: string; name: string; role: string;
  orgId: number | null; operatorOrgId: number | null; rootOperatorOrgId: number | null;
};
let who: Who;
vi.mock("@/auth", () => ({ auth: async () => ({ user: who }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const ROOT = 1, SIERRA = 2, RIVAL = 3;

const TECH: Who = {
  email: "tech@sierra.test", name: "Steve Jones", role: "staff",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: ROOT,
};

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator, parent_org_id) VALUES
      (${ROOT},   'Ridgeline',      'provider', true, NULL),
      (${SIERRA}, 'Sierra Spectra', 'provider', true, NULL),
      (${RIVAL},  'Cascade Service','provider', true, NULL);
    INSERT INTO app_settings (id, operator_org_id) VALUES (1, ${ROOT});
    INSERT INTO house_members (email, org_id, role, name) VALUES
      ('tech@sierra.test', ${SIERRA}, 'staff', 'Steve Jones');
  `);
});

const row = (moduleType: string, model: string, manufacturer = "", systemTypes = "") =>
  ({ moduleType, model, manufacturer, systemTypes });

beforeEach(async () => {
  who = TECH;
  // schema-sync seeds a starter vocabulary; a clean book makes the counts mean
  // what they say.
  await client.exec(`DELETE FROM vocab_terms; DELETE FROM audit_log;`);
});

const terms = async (kind: string) => {
  const { vocabTerms } = schema;
  const { eq } = await import("drizzle-orm");
  return testDb.select().from(vocabTerms).where(eq(vocabTerms.kind, kind));
};
const models = async () => terms("model");

describe("a sheet lands", () => {
  it("files the models, and the vocabulary they need to be usable", async () => {
    const { importCatalog } = await import("@/app/actions");
    const res = await importCatalog([
      row("Pump", "LC-20AD", "Shimadzu", "HPLC; LC-MS"),
      row("N2 generator", "NM32LA", "Peak Scientific", "GC-MS"),
    ]);
    expect(res.error).toBeUndefined();
    expect(res.models).toBe(2);

    const m = await models();
    expect(m).toHaveLength(2);
    const pump = m.find((x) => x.name === "LC-20AD")!;
    expect(pump.assetType).toBe("Pump");
    expect(pump.manufacturer).toBe("Shimadzu");
    expect(pump.categories).toEqual(["HPLC", "LC-MS"]);
    expect(pump.tenantOrgId).toBe(SIERRA);

    // A model whose module type nothing defines is a model no picker offers,
    // so the sheet's vocabulary is created with it - and counted, because it
    // changes every picker in the app.
    expect((await terms("asset_type")).map((t) => t.name).sort()).toEqual(["N2 generator", "Pump"]);
    expect((await terms("category")).map((t) => t.name).sort()).toEqual(["GC-MS", "HPLC", "LC-MS"]);
    expect((await terms("maker")).map((t) => t.name).sort()).toEqual(["Peak Scientific", "Shimadzu"]);
    expect(res.moduleTypes).toBe(2);
    expect(res.systemTypes).toBe(3);
  });

  it("takes a manufacturer on a line of its own into the book", async () => {
    const { importCatalog } = await import("@/app/actions");
    const res = await importCatalog([{ moduleType: "", model: "", manufacturer: "Waters", systemTypes: "" }]);
    expect(res.makers).toBe(1);
    expect((await terms("maker")).map((t) => t.name)).toEqual(["Waters"]);
    expect(await models()).toEqual([]);
  });

  it("writes an audit row naming what the sheet did", async () => {
    const { importCatalog } = await import("@/app/actions");
    await importCatalog([row("Pump", "LC-20AD", "Shimadzu")]);
    const log = await testDb.select().from(schema.auditLog);
    const line = log.find((l) => l.action.includes("imported a catalog sheet"));
    expect(line).toBeTruthy();
    expect(line!.actor).toBe("tech@sierra.test");
    expect(line!.action).toContain("1 new model");
  });
});

describe("the railing, against what is on file", () => {
  const seed = async () => {
    const { importCatalog } = await import("@/app/actions");
    await importCatalog([row("Pump", "LC-20AD", "Shimadzu", "HPLC")]);
  };

  it("importing the same sheet twice files one model", async () => {
    // The failure this fences off is the one that makes an import feature
    // dangerous: a second run doubling the catalog.
    const { importCatalog } = await import("@/app/actions");
    await seed();
    const again = await importCatalog([row("Pump", "LC-20AD", "Shimadzu", "HPLC")]);
    expect(again.models).toBe(0);
    expect(again.merged).toBe(0);
    expect(await models()).toHaveLength(1);
  });

  it("survives the whole round trip unchanged", async () => {
    /*
     * Export, read it straight back in, save. This is what the shop is going to
     * do with two thousand rows appended, so the untouched half of that file
     * has to be a no-op - including the semicolon list and the OEM-only lines.
     */
    const { importCatalog } = await import("@/app/actions");
    const { exportGrid, readGrid } = await import("@/lib/catalogImport");
    await importCatalog([
      row("Pump", "LC-20AD", "Shimadzu", "HPLC; LC-MS"),
      row("Detector", "SPD-20A", "Shimadzu", "HPLC"),
      { moduleType: "", model: "", manufacturer: "Waters", systemTypes: "" },
    ]);
    const before = await models();

    const { makerNames } = await import("@/lib/makersData");
    const grid = exportGrid(
      before.map((t) => ({
        moduleType: t.assetType, name: t.name, manufacturer: t.manufacturer, categories: t.categories,
      })),
      await makerNames(SIERRA),
    );
    const res = await importCatalog(readGrid(grid));
    expect(res.models).toBe(0);
    expect(res.merged).toBe(0);
    expect(res.makers).toBe(0);
    expect(res.skipped).toEqual([]);
    expect(await models()).toHaveLength(before.length);
    // And the rows themselves are untouched, categories included.
    const after = await models();
    for (const b of before) {
      const a = after.find((x) => x.id === b.id)!;
      expect(a.categories).toEqual(b.categories);
      expect(a.manufacturer).toBe(b.manufacturer);
    }
  });

  it("widens a model rather than duplicating it", async () => {
    const { importCatalog } = await import("@/app/actions");
    await seed();
    const res = await importCatalog([row("Pump", "LC-20AD", "Shimadzu", "LC-MS")]);
    expect(res.merged).toBe(1);
    expect(res.models).toBe(0);
    const [m] = await models();
    expect(m.categories).toEqual(["HPLC", "LC-MS"]);
  });

  it("never overwrites a maker somebody set", async () => {
    // The whole point of the railing: what is on file was put there by a
    // person, and a spreadsheet is not an instruction to replace it.
    const { importCatalog } = await import("@/app/actions");
    await seed();
    const res = await importCatalog([row("Pump", "LC-20AD", "Agilent", "HPLC")]);
    expect(res.merged).toBe(0);
    const [m] = await models();
    expect(m.manufacturer).toBe("Shimadzu");
    expect(res.skipped?.[0].problem).toContain("Shimadzu");
  });

  it("refuses a second spelling of a model already on file", async () => {
    const { importCatalog } = await import("@/app/actions");
    await seed();
    const res = await importCatalog([row("Pump", "LC20AD", "Shimadzu")]);
    expect(res.models).toBe(0);
    expect(await models()).toHaveLength(1);
    expect(res.skipped?.[0].problem).toContain("LC-20AD");
  });

  it("files a repeated line inside one sheet exactly once", async () => {
    const { importCatalog } = await import("@/app/actions");
    const res = await importCatalog([
      row("Pump", "LC-20AD", "Shimadzu", "HPLC"),
      row("Pump", "LC-20AD", "Shimadzu", "LC-MS"),
    ]);
    expect(res.models).toBe(1);
    const [m] = await models();
    // The repeat's system type folded into the one row that was written.
    expect(m.categories).toEqual(["HPLC", "LC-MS"]);
  });
});

describe("the constraint the plan cannot see", () => {
  it("does not lose the sheet to a name another workspace has defined", async () => {
    /*
     * vocab_term_unique has no tenant column. Cascade Service defining
     * "LC-20AD" for a Pump makes that name unavailable instance-wide - and it
     * is not in Sierra's plan, because Sierra cannot read it. Without
     * onConflictDoNothing the insert throws and every other model on the sheet
     * goes with it; the shop loses two thousand rows to one they never saw.
     */
    const { importCatalog } = await import("@/app/actions");
    await client.exec(`
      INSERT INTO vocab_terms (tenant_org_id, kind, asset_type, name, manufacturer)
      VALUES (${RIVAL}, 'model', 'Pump', 'LC-20AD', 'Shimadzu');`);

    const res = await importCatalog([
      row("Pump", "LC-20AD", "Shimadzu", "HPLC"),
      row("Pump", "LC-40D", "Shimadzu", "HPLC"),
      row("Detector", "SPD-20A", "Shimadzu", "HPLC"),
    ]);
    expect(res.error).toBeUndefined();
    // The two that could land, landed.
    expect(res.models).toBe(2);
    const mine = (await models()).filter((m) => m.tenantOrgId === SIERRA);
    expect(mine.map((m) => m.name).sort()).toEqual(["LC-40D", "SPD-20A"]);
    // The one that could not is reported, not silently dropped.
    expect(res.skipped?.some((s) => s.model === "LC-20AD" && /already defined/.test(s.problem))).toBe(true);
  });

  it("never writes to another workspace's row", async () => {
    // The other half of the same fact: a name Sierra cannot see is not a row
    // Sierra may widen.
    const { importCatalog } = await import("@/app/actions");
    await client.exec(`
      INSERT INTO vocab_terms (tenant_org_id, kind, asset_type, name, manufacturer, categories)
      VALUES (${RIVAL}, 'model', 'Pump', 'LC-20AD', '', '{}');`);
    await importCatalog([row("Pump", "LC-20AD", "Agilent", "HPLC")]);
    const [theirs] = (await models()).filter((m) => m.tenantOrgId === RIVAL);
    expect(theirs.manufacturer).toBe("");
    expect(theirs.categories).toEqual([]);
  });
});

describe("who may", () => {
  it("refuses a client", async () => {
    const { importCatalog } = await import("@/app/actions");
    who = { email: "maria@labzen.test", name: "Maria Chen", role: "client", orgId: 9, operatorOrgId: null, rootOperatorOrgId: ROOT };
    await expect(importCatalog([row("Pump", "LC-20AD")])).rejects.toBeTruthy();
    expect(await models()).toEqual([]);
  });

  it("refuses a sheet too big to be a sheet", async () => {
    const { importCatalog } = await import("@/app/actions");
    const many = Array.from({ length: 5001 }, (_, i) => row("Pump", `M-${i}`));
    expect((await importCatalog(many)).error).toContain("5000");
    expect(await models()).toEqual([]);
  });
});

describe("the size the shop actually has", () => {
  it("takes two thousand modules in one go", async () => {
    /*
     * The number in the request. Worth a real test rather than an assumption:
     * addVocabTerm re-reads the whole vocabulary and revalidates four routes
     * per call, which is why its batch sibling caps at 300 - this path reads
     * the book once and inserts in chunks, and that difference is only visible
     * at this size.
     */
    const { importCatalog } = await import("@/app/actions");
    const sheet = Array.from({ length: 2000 }, (_, i) =>
      row(i % 2 ? "Pump" : "Detector", `M-${i}`, i % 3 ? "Shimadzu" : "Agilent", "HPLC"));
    const res = await importCatalog(sheet);
    expect(res.error).toBeUndefined();
    expect(res.models).toBe(2000);
    expect(await models()).toHaveLength(2000);
    // A second run of the same sheet writes nothing at all - the property that
    // makes an import somebody can re-run without fear.
    expect((await importCatalog(sheet)).models).toBe(0);
    expect(await models()).toHaveLength(2000);
  }, 60_000);
});
