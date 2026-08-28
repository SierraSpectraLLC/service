// Booking in a machine, as opposed to booking in a count.
//
// A delivery of seals is a number going up. A delivery of a roughing pump is a
// serial, a service history and work that has to happen before anybody fits
// it, and the two used to run down the same pipe - so the pump either became
// "on hand: 1" or was typed onto the asset list by hand, losing the order and,
// worse, the intake. These hold the third path down: the unit is real, the
// receipt survives, and the checklist fires.
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

const STAFF: Who = {
  email: "bill@sierra.test", name: "Bill Reyes", role: "staff",
  orgId: 3, operatorOrgId: 3, rootOperatorOrgId: 3,
};

const { and, eq } = await import("drizzle-orm");

const PUMP = {
  kind: "Pump", model: "nXDS15i", serial: "P-88117", manufacturer: "Edwards",
  owner: "", asFound: "Crate intact, sight glass empty", location: "Shelf B", note: "",
};

const RESET = `
  DELETE FROM tasks; DELETE FROM asset_events; DELETE FROM assets;
  DELETE FROM po_lines; DELETE FROM purchase_orders; DELETE FROM procedures;
  INSERT INTO purchase_orders (id, number, vendor, status, stockroom_id, tenant_org_id)
    VALUES (1, 'PO-1001', 'Edwards', 'sent', 1, 3);
  SELECT setval('purchase_orders_id_seq', 100);
  INSERT INTO po_lines (id, po_id, part_number, name, qty_ordered)
    VALUES (1, 1, 'A736-01-983', 'nXDS15i roughing pump', 2);
  SELECT setval('po_lines_id_seq', 100);
`;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES
      (3, 'Sierra Spectra', 'provider', true),
      -- A second service company on the instance. Staff of one are not staff of
      -- the other, and a stockroom is one company's shelf.
      (5, 'Cascade Analytical', 'provider', true);
    SELECT setval('orgs_id_seq', 100);
    INSERT INTO stockrooms (id, name, tenant_org_id) VALUES (1, 'Main', 3);
    SELECT setval('stockrooms_id_seq', 100);
  `);
});

beforeEach(async () => { who = STAFF; await client.exec(RESET); });

const receive = async (over: Record<string, unknown> = {}) => {
  const { receivePoLineAsUnit } = await import("@/app/actions");
  return receivePoLineAsUnit(1, { ...PUMP, ...over } as never);
};
const assetRows = () => testDb.select().from(schema.assets);

describe("what arrives", () => {
  it("becomes a unit on the asset list, not a number on a shelf", async () => {
    const res = await receive();
    expect(res.error).toBeUndefined();

    const [a] = await assetRows();
    expect(a.kind).toBe("Pump");
    expect(a.serial).toBe("P-88117");
    expect(a.manufacturer).toBe("Edwards");
    // Nobody has fitted it, so it is a spare rather than in service.
    expect(a.instrumentId).toBeNull();
    expect(a.status).toBe("Spare");
    expect(a.location).toBe("Shelf B");
    // And no stock line was invented for it.
    expect(await testDb.select().from(schema.stockItems)).toHaveLength(0);
  });

  it("keeps the condition it came out of the crate in", async () => {
    // Written once, at the only moment anybody can see the crate.
    await receive();
    expect((await assetRows())[0].asFound).toContain("sight glass empty");
  });

  it("remembers the order behind it", async () => {
    /*
     * "Where is the receipt for this pump" is asked two years later, by
     * somebody arguing about a warranty. parts.po_id has answered it for
     * consumables since purchasing existed; this is the same answer for a
     * machine.
     */
    await receive();
    expect((await assetRows())[0].poId).toBe(1);
    const events = await testDb.select().from(schema.assetEvents);
    expect(events.some((e) => e.detail.includes("PO-1001"))).toBe(true);
  });

  it("books one against the line, because one serial is one machine", async () => {
    await receive();
    expect((await testDb.select().from(schema.poLines))[0].qtyReceived).toBe(1);
    // The second of two: same line, its own serial, its own record.
    await receive({ serial: "P-88118" });
    expect((await testDb.select().from(schema.poLines))[0].qtyReceived).toBe(2);
    expect(await assetRows()).toHaveLength(2);
  });

  it("closes the order once the last one is in", async () => {
    await receive();
    expect((await testDb.select().from(schema.purchaseOrders))[0].status).toBe("partial");
    await receive({ serial: "P-88118" });
    expect((await testDb.select().from(schema.purchaseOrders))[0].status).toBe("received");
  });
});

describe("the intake work", () => {
  const oilChange = async (over: Record<string, unknown> = {}) => {
    await testDb.insert(schema.procedures).values({
      tenantOrgId: 3, assetType: "Pump", name: "Fill with oil",
      runsAtIntake: true, position: 1, ...over,
    } as never);
  };

  it("fires for a unit that landed on the shelf", async () => {
    /*
     * THE POINT OF THE WHOLE FEATURE. createAsset runs the checkout for a unit
     * born on a system and deliberately not for a spare - four hundred
     * imported spares must not manufacture four hundred task lists. A unit
     * somebody has just taken delivery of is the opposite case: the box is
     * open, the person is standing there, and the oil is the reason they came.
     */
    await oilChange();
    const res = await receive();
    expect(res.tasks).toBe(1);

    const [t] = await testDb.select().from(schema.tasks);
    expect(t.title).toBe("Fill with oil");
    expect(t.origin).toBe("checkout");
    expect(t.assetId).toBe(res.assetId);
    expect(t.instrumentId).toBeNull();
  });

  it("brings only the work for this type of machine", async () => {
    await oilChange();
    await oilChange({ assetType: "Autosampler", name: "Seat the needle" });
    await receive();
    expect((await testDb.select().from(schema.tasks)).map((t) => t.title)).toEqual(["Fill with oil"]);
  });

  it("does not fire another shop's checklist", async () => {
    await oilChange({ tenantOrgId: 5, name: "Somebody else's intake" });
    await oilChange();
    await receive();
    expect((await testDb.select().from(schema.tasks)).map((t) => t.title)).toEqual(["Fill with oil"]);
  });

  it("says nothing arrived when the type has no intake on file", async () => {
    // An honest zero. A shop with no procedures yet is not a broken receipt.
    const res = await receive();
    expect(res.tasks).toBe(0);
    expect(await testDb.select().from(schema.tasks)).toHaveLength(0);
  });
});

describe("what it refuses", () => {
  it("refuses a unit with neither serial nor model", async () => {
    // That is a quantity wearing a machine's clothes.
    const res = await receive({ serial: "", model: "" });
    expect(res.error).toContain("serial or a model");
    expect(await assetRows()).toHaveLength(0);
  });

  it("refuses against an order that has not gone out", async () => {
    await client.exec(`UPDATE purchase_orders SET status = 'draft' WHERE id = 1;`);
    expect((await receive()).error).toContain("hasn't been sent");
    expect(await assetRows()).toHaveLength(0);
  });

  it("refuses against a cancelled order", async () => {
    await client.exec(`UPDATE purchase_orders SET status = 'cancelled' WHERE id = 1;`);
    expect((await receive()).error).toContain("cancelled");
    expect(await assetRows()).toHaveLength(0);
  });

  it("refuses another service company's staff", async () => {
    /*
     * Their OWN operator is 5; the instance's root is still 3. Getting that
     * second field wrong makes a viewer platform staff (lib/tenants
     * isPlatformStaff: operator === root), who legitimately sees everything -
     * so a fixture that repeats their own id proves nothing.
     */
    who = {
      email: "cass@cascade.test", name: "Cass", role: "staff",
      orgId: 5, operatorOrgId: 5, rootOperatorOrgId: 3,
    };
    expect((await receive()).error).toBeTruthy();
    expect(await assetRows()).toHaveLength(0);
  });

  it("refuses a line that does not exist", async () => {
    const { receivePoLineAsUnit } = await import("@/app/actions");
    expect((await receivePoLineAsUnit(9999, PUMP as never)).error).toBe("Not found");
  });
});

describe("stamping", () => {
  it("puts the unit in the workspace that bought it", async () => {
    await receive();
    const [a] = await assetRows();
    expect(a.tenantOrgId).toBe(3);
  });

  it("stamps the intake tasks the same way", async () => {
    await testDb.insert(schema.procedures).values({
      tenantOrgId: 3, assetType: "Pump", name: "Fill with oil", runsAtIntake: true, position: 1,
    } as never);
    await receive();
    const [t] = await testDb.select().from(schema.tasks);
    expect(t.tenantOrgId).toBe(3);
  });
});
