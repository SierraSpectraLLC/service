// Deleting an order, and the one case that must be refused.
//
// A purchase order raised by mistake should be destroyable - a duplicate, a
// test, a typo nobody wants to read past for the next year. An order somebody
// has RECEIVED against must not be, and that is the whole point of this file:
// receiving put parts on a shelf, set that shelf's held cost and closed the
// open requests on a job, none of which deleting the paperwork could undo. The
// stockroom would be left holding goods nothing explains.
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
vi.mock("@/lib/notify", () => ({ notifyTaskAssigned: async () => {}, notifyInvite: async () => {} }));

const OWNER: Who = {
  email: "joe@sierra.test", name: "Joe", role: "owner",
  orgId: null, operatorOrgId: 3, rootOperatorOrgId: 3,
};
const STAFF: Who = { ...OWNER, email: "bill@sierra.test", name: "Bill", role: "staff" };
const RIVAL: Who = { ...OWNER, email: "sam@rival.test", name: "Sam", operatorOrgId: 4 };

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO app_settings (id, client_access_enabled) VALUES (1, true);
    INSERT INTO orgs (name, kind) VALUES
      ('Lab Zen', 'client'), ('Coastal Analytical', 'client'),
      ('Sierra Spectra', 'provider'), ('Rival Instruments', 'provider');
    UPDATE orgs SET is_operator = true WHERE id IN (3, 4);
    UPDATE orgs SET parent_org_id = 3 WHERE id IN (1, 2);
    UPDATE app_settings SET operator_org_id = 3 WHERE id = 1;
    INSERT INTO stockrooms (name, tenant_org_id) VALUES ('Main shelf', 3);
    INSERT INTO house_members (email, org_id, role, name) VALUES
      ('joe@sierra.test', 3, 'owner', 'Joe'),
      ('bill@sierra.test', 3, 'staff', 'Bill');
  `);
});

beforeEach(() => { who = OWNER; });

const actions = await import("@/app/actions");

/** A fresh draft order with one line on it. */
async function anOrder(vendor = "Frit & Ferrule") {
  const made = await actions.createPurchaseOrder({
    vendor, stockroomId: 1, lines: [], allowEmpty: true,
  });
  await actions.addPoLine(made.id!, { partNumber: "G6303-80060", name: "HED supply", qty: "2", price: "450.00" });
  return made.id!;
}

describe("deleting a purchase order", () => {
  it("takes its lines with it, and says why in the audit trail", async () => {
    const id = await anOrder();
    const res = await actions.deletePurchaseOrder(id, "raised against the wrong vendor");
    expect(res.error).toBeUndefined();
    expect((await testDb.select().from(schema.purchaseOrders)).some((p) => p.id === id)).toBe(false);
    expect((await testDb.select().from(schema.poLines)).some((l) => l.poId === id)).toBe(false);
    const line = (await testDb.select().from(schema.auditLog))
      .map((a) => a.action).find((a) => a.includes("deleted PO-"));
    expect(line).toContain("raised against the wrong vendor");
  });

  it("demands a reason, like every other destruction here", async () => {
    const id = await anOrder();
    expect((await actions.deletePurchaseOrder(id, "")).error).toMatch(/reason is required/i);
    expect((await testDb.select().from(schema.purchaseOrders)).some((p) => p.id === id)).toBe(true);
  });

  it("REFUSES an order with anything received against it", async () => {
    const id = await anOrder();
    await actions.sendPurchaseOrder(id);
    const [line] = (await testDb.select().from(schema.poLines)).filter((l) => l.poId === id);
    const got = await actions.receivePoLine(line.id, 1);
    expect(got.error).toBeUndefined();

    const res = await actions.deletePurchaseOrder(id, "changed my mind");
    expect(res.error).toContain("received against");
    expect(res.error).toContain("Cancel it instead");
    // Still there, and so is the stock that arrived on it.
    expect((await testDb.select().from(schema.purchaseOrders)).some((p) => p.id === id)).toBe(true);
    const moves = await testDb.select().from(schema.stockMoves);
    expect(moves.length).toBeGreaterThan(0);
  });

  it("refuses on the status alone, even if no line quantity says so", async () => {
    // Belt and braces: the two signals can disagree - a row imported, or a
    // status set by hand - and the one that says goods arrived wins.
    const id = await anOrder("Status Only Co");
    const { eq } = await import("drizzle-orm");
    await testDb.update(schema.purchaseOrders).set({ status: "received" })
      .where(eq(schema.purchaseOrders.id, id));
    const res = await actions.deletePurchaseOrder(id, "tidying up");
    expect(res.error).toContain("received against");
    expect((await testDb.select().from(schema.purchaseOrders)).some((p) => p.id === id)).toBe(true);
  });

  it("is an owner's move, not any staff member's", async () => {
    const id = await anOrder();
    who = STAFF;
    await expect(actions.deletePurchaseOrder(id, "tidying up")).rejects.toThrow();
    who = OWNER;
    expect((await testDb.select().from(schema.purchaseOrders)).some((p) => p.id === id)).toBe(true);
  });

  it("is not reachable from another operator's workspace", async () => {
    const id = await anOrder();
    who = RIVAL;
    expect((await actions.deletePurchaseOrder(id, "not mine to delete")).error).toBe("Not found");
    who = OWNER;
    expect((await testDb.select().from(schema.purchaseOrders)).some((p) => p.id === id)).toBe(true);
  });
});

describe("deleting a client's order from the store", () => {
  /** What placePartsOrder leaves behind: a draft invoice for the priced half. */
  async function anOrderFromAClient() {
    const [inv] = await testDb.insert(schema.invoices).values({
      tenantOrgId: 3, orgId: 1, number: "INV-9001", status: "draft",
      note: "Parts order from the portal", createdBy: "maria@labzen.test",
    }).returning();
    await testDb.insert(schema.invoiceLines).values({
      invoiceId: inv.id, kind: "part", description: "Nebulizer", qty: 1000, unitCents: 42000, position: 0,
    });
    return inv.id;
  }

  it("goes, and its lines go with it", async () => {
    const id = await anOrderFromAClient();
    const res = await actions.deleteInvoice(id, "test order placed while trying the store");
    expect(res.error).toBeUndefined();
    expect((await testDb.select().from(schema.invoices)).some((i) => i.id === id)).toBe(false);
    expect((await testDb.select().from(schema.invoiceLines)).some((l) => l.invoiceId === id)).toBe(false);
  });

  it("says out loud when it is destroying a payment record too", async () => {
    const id = await anOrderFromAClient();
    await testDb.insert(schema.payments).values({
      tenantOrgId: 3, invoiceId: id, amountCents: 42000, receivedOn: "2026-08-20", method: "card",
    });
    await actions.deleteInvoice(id, "duplicate of INV-9002");
    const line = (await testDb.select().from(schema.auditLog))
      .map((a) => a.action).find((a) => a.includes("INV-9001") && a.includes("payments"));
    expect(line).toContain("$420");
  });

  it("is an owner's move here too", async () => {
    const id = await anOrderFromAClient();
    who = STAFF;
    await expect(actions.deleteInvoice(id, "tidying")).rejects.toThrow();
  });
});
