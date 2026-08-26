// Importing a parts sheet, against a real catalog.
//
// The rule worth a real table is BLANK LEAVES WHAT IS ON FILE ALONE. A sheet
// of nothing but this quarter's prices must not wipe the descriptions somebody
// spent a fortnight writing, and there is no undo for that - the import would
// look like it worked.
//
// The other one is that a repeated part number ADDS A VENDOR rather than
// colliding, which is what makes a quote comparison importable at all.
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

const { blankRow, exportGrid, readGrid } = await import("@/lib/partImport");

const STAFF: Who = {
  email: "bill@sierra.test", name: "Bill", role: "staff",
  orgId: 3, operatorOrgId: 3, rootOperatorOrgId: 3,
};

const row = (over: Record<string, string> = {}) => ({ ...blankRow(), ...over });

const catalog = async () => (await client.query<{
  part_number: string; name: string; manufacturer: string; kind: string;
  asset_types: string[]; models: string[]; note: string;
}>(`SELECT part_number, name, manufacturer, kind, asset_types, models, note
    FROM part_catalog ORDER BY part_number`)).rows;

const prices = async () => (await client.query<{
  part_number: string; vendor: string; price_cents: number; is_oem: boolean; lead_days: number | null;
}>(`SELECT part_number, vendor, price_cents, is_oem, lead_days FROM part_prices
    ORDER BY part_number, vendor`)).rows;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES (3, 'Sierra Spectra', 'provider', true);
    SELECT setval('orgs_id_seq', 100);
  `);
});

beforeEach(async () => {
  who = STAFF;
  await client.exec(`DELETE FROM part_prices; DELETE FROM part_catalog;`);
});

describe("a sheet of new parts", () => {
  it("catalogues each one and prices it in the same pass", async () => {
    const { importParts } = await import("@/app/actions");
    const res = await importParts([
      row({
        partNumber: "228-35145-91", name: "Plunger seal", manufacturer: "Shimadzu",
        kind: "consumable", fits: "Pump; Autosampler", models: "LC-20AD",
        vendor: "Shimadzu", price: "48.50", oem: "y", leadDays: "5",
      }),
    ]);
    expect(res.error).toBeUndefined();
    expect(res).toMatchObject({ parts: 1, created: 1, prices: 1 });
    const [c] = await catalog();
    expect(c).toMatchObject({
      part_number: "228-35145-91", name: "Plunger seal", kind: "consumable",
      asset_types: ["Pump", "Autosampler"], models: ["LC-20AD"],
    });
    expect((await prices())[0]).toMatchObject({ vendor: "Shimadzu", price_cents: 4850, lead_days: 5 });
  });

  it("A REPEATED PART NUMBER ADDS A VENDOR, it does not collide", async () => {
    // What a real quote comparison looks like: one part, three sellers.
    const { importParts } = await import("@/app/actions");
    const res = await importParts([
      row({ partNumber: "PN-1", name: "A seal", vendor: "Shimadzu", price: "48.50", oem: "y" }),
      row({ partNumber: "PN-1", vendor: "Acme", price: "31.00" }),
      row({ partNumber: "PN-1", vendor: "Restek", price: "35.25" }),
    ]);
    expect(res).toMatchObject({ parts: 1, created: 1, prices: 3 });
    expect(await catalog()).toHaveLength(1);
    expect((await prices()).map((p) => p.vendor)).toEqual(["Acme", "Restek", "Shimadzu"]);
  });

  it("takes a part nobody has priced", async () => {
    const { importParts } = await import("@/app/actions");
    expect(await importParts([row({ partNumber: "PN-1", name: "A seal" })]))
      .toMatchObject({ created: 1, prices: 0 });
    expect(await prices()).toEqual([]);
  });
});

describe("importing over what is already there", () => {
  const seed = async () => {
    const { importParts } = await import("@/app/actions");
    await importParts([row({
      partNumber: "PN-1", name: "Plunger seal, 10 mL", manufacturer: "Shimadzu",
      kind: "consumable", fits: "Pump", models: "LC-20AD", note: "Change with the wash seal",
      vendor: "Shimadzu", price: "48.50",
    })]);
  };

  it("LEAVES A BLANK CELL'S FIELD EXACTLY AS IT WAS", async () => {
    // The rule with no undo. A quarterly price sheet carries a part number and
    // a price and nothing else; if that wiped the descriptions, the import
    // would look like it had worked.
    await seed();
    const { importParts } = await import("@/app/actions");
    await importParts([row({ partNumber: "PN-1", vendor: "Acme", price: "31.00" })]);
    const [c] = await catalog();
    expect(c).toMatchObject({
      name: "Plunger seal, 10 mL", manufacturer: "Shimadzu", kind: "consumable",
      asset_types: ["Pump"], models: ["LC-20AD"], note: "Change with the wash seal",
    });
  });

  it("updates the fields the sheet does fill in", async () => {
    await seed();
    const { importParts } = await import("@/app/actions");
    const res = await importParts([row({ partNumber: "PN-1", name: "Plunger seal, 20 mL" })]);
    expect(res).toMatchObject({ created: 0, updated: 1 });
    const [c] = await catalog();
    expect(c.name).toBe("Plunger seal, 20 mL");
    expect(c.manufacturer).toBe("Shimadzu");   // untouched
  });

  it("re-prices a vendor already on file rather than doubling it", async () => {
    await seed();
    const { importParts } = await import("@/app/actions");
    await importParts([row({ partNumber: "PN-1", vendor: "Shimadzu", price: "52.00" })]);
    const rows = await prices();
    expect(rows).toHaveLength(1);
    expect(rows[0].price_cents).toBe(5200);
  });

  it("matches an existing part however the number was typed", async () => {
    await seed();
    const { importParts } = await import("@/app/actions");
    // Case and internal spaces are noise; dashes are not. See lib/priceBook.
    await importParts([row({ partNumber: " pn-1 ", note: "Second thoughts" })]);
    const rows = await catalog();
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("Second thoughts");
  });
});

describe("what it refuses", () => {
  it("says so rather than importing a sheet with nothing on it", async () => {
    const { importParts } = await import("@/app/actions");
    expect((await importParts([row({ name: "orphan" })])).error).toMatch(/Nothing on that sheet/);
    expect(await catalog()).toEqual([]);
  });

  it("skips the broken lines and imports the rest, naming what it skipped", async () => {
    const { importParts } = await import("@/app/actions");
    const res = await importParts([
      row({ partNumber: "PN-1", name: "A seal" }),
      row({ name: "no number" }),
      row({ partNumber: "PN-2", vendor: "Acme" }),
    ]);
    expect(res).toMatchObject({ parts: 1, created: 1 });
    expect(res.problems?.map((p) => p.problem))
      .toEqual(["No part number", "A vendor with no price"]);
    expect((await catalog()).map((c) => c.part_number)).toEqual(["PN-1"]);
  });

  it("keeps a client out of the catalog entirely", async () => {
    // requireStaff, same as every other write on this page: a shop's catalog
    // is its own accumulated knowledge of what its numbers mean.
    who = { email: "maria@labzen.test", name: "Maria", role: "client_editor", orgId: 1, operatorOrgId: 3, rootOperatorOrgId: 3 };
    const { importParts } = await import("@/app/actions");
    await expect(importParts([row({ partNumber: "PN-1", name: "A seal" })])).rejects.toThrow();
    expect(await catalog()).toEqual([]);
  });
});

describe("the round trip, against the real thing", () => {
  // The regression. The first run of this feature exported five parts, imported
  // the file straight back, and reported "5 new" - because the lookup was
  // scoped wider than the insert stamp, so every part was visible, unfindable,
  // and duplicated. The unique index could not catch it either: the two rows
  // differed by tenant. One scope for both, and the file re-imports as a no-op.

  const load = async () => {
    const { importParts } = await import("@/app/actions");
    return importParts([
      row({ partNumber: "PN-1", name: "Plunger seal", manufacturer: "Shimadzu",
        kind: "consumable", fits: "Pump", models: "LC-20AD",
        vendor: "Shimadzu", price: "48.50", oem: "y", leadDays: "5" }),
      row({ partNumber: "PN-1", vendor: "Acme", price: "31.00" }),
      row({ partNumber: "PN-2", name: "Oil mist filter", manufacturer: "Agilent" }),
    ]);
  };

  /** Everything on file, through the export, as the importer would read it. */
  const asSheet = async () => {
    const parts = (await client.query<Record<string, never>>(
      `SELECT part_number as "partNumber", name, manufacturer,
              mfr_part_number as "mfrPartNumber", kind,
              asset_types as "assetTypes", models, note
       FROM part_catalog ORDER BY part_number`)).rows;
    const px = (await client.query<Record<string, never>>(
      `SELECT part_number as "partNumber", vendor, price_cents as "priceCents",
              is_oem as "isOem", lead_days as "leadDays", drop_ships as "dropShips",
              expedite_ok as "expediteOk", url FROM part_prices`)).rows;
    return readGrid(exportGrid(parts as never, px as never));
  };

  it("RE-IMPORTS ITS OWN EXPORT AS A NO-OP, not as a second copy", async () => {
    await load();
    const before = await catalog();
    const { importParts } = await import("@/app/actions");

    const res = await importParts(await asSheet());
    expect(res.created).toBe(0);
    expect(await catalog()).toEqual(before);
    expect(await prices()).toHaveLength(2);
  });

  it("carries every field back unchanged", async () => {
    await load();
    const { importParts } = await import("@/app/actions");
    await importParts(await asSheet());
    const [c] = await catalog();
    expect(c).toMatchObject({
      part_number: "PN-1", name: "Plunger seal", manufacturer: "Shimadzu",
      kind: "consumable", asset_types: ["Pump"], models: ["LC-20AD"],
    });
    expect((await prices()).find((p) => p.vendor === "Shimadzu"))
      .toMatchObject({ price_cents: 4850, is_oem: true, lead_days: 5 });
  });

  it("finds a part by the manufacturer's number too, rather than filing a twin", async () => {
    // allNumbers, not just the primary: two entries answering to one number
    // would resolve to whichever came first.
    const { importParts } = await import("@/app/actions");
    await importParts([row({ partNumber: "PN-1", name: "A seal", mfrPartNumber: "SHM-99" })]);
    const res = await importParts([row({ partNumber: "SHM-99", note: "Same part, their number" })]);
    expect(res.created).toBe(0);
    expect(await catalog()).toHaveLength(1);
  });
});
