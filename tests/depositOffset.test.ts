// The 50%-down job, computed from real rows in a real Postgres.
//
// The workflow this pins down: a quote on a job is approved with a deposit,
// which raises its own invoice carrying the job's id. Before this existed,
// drafting the final invoice either refused outright ("already on INV-x",
// because the deposit invoice matched the job) or would have priced the whole
// job again on top of the 50% already billed. Both wrongs end with the client
// doing the arithmetic for you.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO app_settings (id) VALUES (1);
    INSERT INTO orgs (name, kind) VALUES ('UCSF Genomics Core', 'client');
    INSERT INTO instruments (external_id, client, category, model, owner_org_id) VALUES ('U-001', 'UCSF Genomics Core', 'LC-MS', '6495C', 1);
    INSERT INTO work_orders (number, title, instrument_id, org_id, state) VALUES
      ('WO-9001', 'Relocate 6495C to Mission Bay', 1, 1, 'active'),
      ('WO-9002', 'A job with no quote at all',    1, 1, 'open');

    -- The deposit invoice approval raised: $4,500 (50% of $9,000), on the job.
    INSERT INTO invoices (org_id, work_order_id, number, status, issued_on, due_on, note) VALUES
      (1, 1, 'INV-9101', 'sent', '2026-08-20', '2026-08-20', '50% deposit on Q-9001');
    INSERT INTO invoice_lines (invoice_id, kind, description, qty, unit_cents) VALUES
      (1, 'fee_ref', 'Deposit on Q-9001', 1000, 450000);
    INSERT INTO quotes (org_id, work_order_id, number, status, title, deposit_pct, deposit_invoice_id) VALUES
      (1, 1, 'Q-9001', 'approved', 'Instrument relocation', 50, 1);
  `);
});

const offsetsFor = async (woId: number) =>
  (await import("@/lib/invoiceData")).depositOffsetsFor(woId);

describe("the job with an approved 50% quote", () => {
  it("names its deposit invoice so the final bill can skip it as 'existing'", async () => {
    const { depositInvoiceIds } = await offsetsFor(1);
    expect([...depositInvoiceIds]).toEqual([1]);
  });

  it("offsets what the deposit BILLED - $4,500 - regardless of payment", async () => {
    // Nothing has been paid yet, and the offset must not care: the two
    // invoices have to sum to the job's total whatever the payment timing.
    const { offsets } = await offsetsFor(1);
    expect(offsets).toEqual([{ number: "INV-9101", quoteNumber: "Q-9001", cents: 450000 }]);
  });
});

describe("jobs that must not be touched by any of this", () => {
  it("a job with no quote offsets nothing and blocks nothing", async () => {
    const r = await offsetsFor(2);
    expect(r.offsets).toEqual([]);
    expect(r.depositInvoiceIds.size).toBe(0);
  });

  it("a voided deposit invoice stops offsetting", async () => {
    await client.exec(`UPDATE invoices SET status = 'void' WHERE id = 1;`);
    const { offsets, depositInvoiceIds } = await offsetsFor(1);
    expect(offsets).toEqual([]);
    // ...but it still doesn't count as the job's own invoice.
    expect([...depositInvoiceIds]).toEqual([1]);
    await client.exec(`UPDATE invoices SET status = 'sent' WHERE id = 1;`);
  });

  it("an unanswered quote's deposit-to-be offsets nothing", async () => {
    await client.exec(`UPDATE quotes SET status = 'sent' WHERE id = 1;`);
    const r = await offsetsFor(1);
    expect(r.offsets).toEqual([]);
    await client.exec(`UPDATE quotes SET status = 'approved' WHERE id = 1;`);
  });
});
