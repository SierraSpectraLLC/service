// Writes to rows the platform operator owns, which carry no tenant stamp.
//
// Every money action reads a row, checks it is this house's, and then writes
// to it scoped by the tenant it just read. Scoped as `tenant_org_id = <x>`,
// a null stamp became `= NULL`, which is never true: the write touched
// nothing, and the action went on to post the ledger and the audit line as if
// it had. These pin the three writes that matter most - voiding and deleting
// an invoice, and paying a vendor - and the helper all of them now share.
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

const ROOT = 1, CLIENT = 2;
/** The platform's own operator: what they file carries no tenant stamp. */
const PLATFORM_OWNER: Who = {
  email: "owner@ridgeline.test", name: "Root Owner", role: "owner",
  orgId: null, operatorOrgId: ROOT, rootOperatorOrgId: ROOT,
};

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES
      (${ROOT}, 'Ridgeline', 'provider', true),
      (${CLIENT}, 'Lab Zen', 'client', false);
    INSERT INTO app_settings (id, operator_org_id) VALUES (1, ${ROOT});
    INSERT INTO house_members (email, org_id, role, name) VALUES
      ('owner@ridgeline.test', ${ROOT}, 'owner', 'Root Owner');
  `);
});

beforeEach(async () => {
  who = PLATFORM_OWNER;
  await client.exec(`DELETE FROM invoices; DELETE FROM po_lines; DELETE FROM purchase_orders;`);
});

const one = async <T>(sql: string, args: unknown[] = []) => (await client.query<T>(sql, args)).rows[0];

describe("sameTenant", () => {
  it("matches a null stamp as null, never as `= NULL`", async () => {
    const { sameTenant } = await import("@/lib/tenancy");
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const sql = (t: number | null) => new PgDialect().sqlToQuery(sameTenant(schema.invoices.tenantOrgId, t)).sql;
    expect(sql(null)).toBe('"invoices"."tenant_org_id" is null');
    expect(sql(7)).toBe('"invoices"."tenant_org_id" = $1');
  });
});

describe("the platform operator's own money", () => {
  it("voids an unstamped invoice", async () => {
    const inv = await one<{ id: number }>(
      `INSERT INTO invoices (tenant_org_id, org_id, number, status) VALUES (NULL, ${CLIENT}, 'INV-1001', 'sent') RETURNING id`);
    const { voidInvoice } = await import("@/app/money/actions");
    expect((await voidInvoice(inv.id, "billed to the wrong site")).error).toBeUndefined();
    expect((await one<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [inv.id])).status).toBe("void");
  });

  it("deletes an unstamped invoice", async () => {
    const inv = await one<{ id: number }>(
      `INSERT INTO invoices (tenant_org_id, org_id, number, status) VALUES (NULL, ${CLIENT}, 'INV-1002', 'draft') RETURNING id`);
    const { deleteInvoice } = await import("@/app/money/actions");
    expect((await deleteInvoice(inv.id, "duplicate")).error).toBeUndefined();
    expect(await one(`SELECT id FROM invoices WHERE id = $1`, [inv.id])).toBeUndefined();
  });

  it("pays a vendor on an unstamped purchase order", async () => {
    const po = await one<{ id: number }>(
      `INSERT INTO purchase_orders (tenant_org_id, number, vendor, status) VALUES (NULL, 'PO-0001', 'Agilent', 'received') RETURNING id`);
    await client.query(
      `INSERT INTO po_lines (po_id, part_number, unit_cents, qty_ordered, qty_received) VALUES ($1, 'G1311-60001', 12500, 2, 2)`, [po.id]);
    const { payPurchaseOrder } = await import("@/app/money/actions");
    expect((await payPurchaseOrder(po.id, { paidOn: "2026-10-01", reference: "ACH-1" })).error).toBeUndefined();
    expect(await one(`SELECT paid_on, paid_ref FROM purchase_orders WHERE id = $1`, [po.id]))
      .toEqual({ paid_on: "2026-10-01", paid_ref: "ACH-1" });
  });
});
