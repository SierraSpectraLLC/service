// The other three numbers on a draft line, and the words around the table,
// through the real actions.
//
// "1 h" on a month of onsite availability was the complaint: the unit came off
// the catalog and there was no way to say "mo" without retyping the line. What
// is pinned here: a draft line's quantity, unit and price change in place, a
// sent line does not, the invoice takes a title and a note while it is a
// draft and a PO at any time, and none of it crosses a workspace.
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

const SIERRA = 3, CASCADE = 5, UCSF = 7;
const STAFF: Who = {
  email: "bill@sierra.test", name: "Bill Reyes", role: "staff",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: SIERRA,
};
const OTHER_STAFF: Who = {
  email: "cass@cascade.test", name: "Cass", role: "staff",
  orgId: null, operatorOrgId: CASCADE, rootOperatorOrgId: SIERRA,
};
const INV = 40, LINE = 400;
const SLOW = 30_000;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator, parent_org_id) VALUES
      (${SIERRA}, 'Sierra Spectra', 'provider', true, NULL),
      (${CASCADE}, 'Cascade Analytical', 'provider', true, NULL),
      (${UCSF}, 'UCSF', 'client', false, ${SIERRA});
    SELECT setval('orgs_id_seq', 100);
    INSERT INTO house_members (email, org_id, role, name) VALUES
      ('bill@sierra.test', ${SIERRA}, 'staff', 'Bill Reyes'),
      ('cass@cascade.test', ${CASCADE}, 'staff', 'Cass');
  `);
});

beforeEach(async () => {
  who = STAFF;
  await client.exec(`
    DELETE FROM audit_log; DELETE FROM invoice_lines; DELETE FROM invoices;
    INSERT INTO invoices (id, tenant_org_id, org_id, number, status) VALUES (${INV}, ${SIERRA}, ${UCSF}, 'INV-1042', 'draft');
    INSERT INTO invoice_lines (id, invoice_id, kind, description, part_number, qty, unit, unit_cents)
      VALUES (${LINE}, ${INV}, 'labor', 'Onsite Availability | Full-Time Engineer', 'ONSITE_FTE', 1000, 'h', 2000000);
  `);
});

const line = async () => (await testDb.select().from(schema.invoiceLines))[0];
const invoice = async () => (await testDb.select().from(schema.invoices))[0];

describe("a draft line's terms", () => {
  it("takes a new quantity, unit and price in place, and says so in the log", async () => {
    const { setInvoiceLineTerms } = await import("@/app/actions");
    expect(await setInvoiceLineTerms(LINE, { qty: 1, unit: "mo", unitCents: 2000000 })).toEqual({});
    const l = await line();
    expect([l.qty, l.unit, l.unitCents]).toEqual([1000, "mo", 2000000]);
    const [entry] = await testDb.select().from(schema.auditLog);
    expect(entry.action).toBe("repriced a line on INV-1042: Onsite Availability | Full-Time Engineer - 1 mo × $20,000");
    // Fractions survive in thousandths, and a re-price alone is a change.
    expect(await setInvoiceLineTerms(LINE, { qty: 4.5, unit: "h", unitCents: 18500 })).toEqual({});
    expect((await line()).qty).toBe(4500);
  }, SLOW);

  it("refuses nothing of something, a negative price, and a sent invoice", async () => {
    const { setInvoiceLineTerms } = await import("@/app/actions");
    expect((await setInvoiceLineTerms(LINE, { qty: 0, unit: "mo", unitCents: 1 })).error).toBe("Quantity must be above zero");
    expect((await setInvoiceLineTerms(LINE, { qty: 1, unit: "mo", unitCents: -1 })).error).toBe("The price cannot be negative");
    await client.exec(`UPDATE invoices SET status = 'sent' WHERE id = ${INV}`);
    expect((await setInvoiceLineTerms(LINE, { qty: 1, unit: "mo", unitCents: 1 })).error)
      .toBe("INV-1042 has been sent - its lines stay as sent.");
    expect((await line()).unit).toBe("h");
  }, SLOW);

  it("is one workspace's, and says nothing to another", async () => {
    const { setInvoiceLineTerms } = await import("@/app/actions");
    who = OTHER_STAFF;
    expect((await setInvoiceLineTerms(LINE, { qty: 1, unit: "mo", unitCents: 1 })).error).toBe("Not found");
  }, SLOW);
});

describe("the words around the table", () => {
  it("takes a title and a note on a draft, and the PO at any time", async () => {
    const { updateInvoice } = await import("@/app/actions");
    expect(await updateInvoice(INV, { title: "Onsite engineering, September 2026", note: "Thank you." })).toEqual({});
    expect((await invoice()).title).toBe("Onsite engineering, September 2026");
    await client.exec(`UPDATE invoices SET status = 'sent' WHERE id = ${INV}`);
    expect(await updateInvoice(INV, { poNumber: "PO-4471" })).toEqual({});
    expect((await invoice()).poNumber).toBe("PO-4471");
    expect((await updateInvoice(INV, { title: "Something else" })).error).toBe("INV-1042 has been sent - it reads as sent.");
    expect((await invoice()).title).toBe("Onsite engineering, September 2026");
  }, SLOW);

  it("is one workspace's too", async () => {
    const { updateInvoice } = await import("@/app/actions");
    who = OTHER_STAFF;
    expect((await updateInvoice(INV, { poNumber: "PO-1" })).error).toBe("Not found");
  }, SLOW);
});
