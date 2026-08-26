// The other half of tests/invoiceIsolation.test.ts.
//
// That file guards the CLIENT door: a share token reaches only its own org's
// money. This one guards the door between two service companies, which is the
// one that opens the day a second operator exists on the instance - and stayed
// shut only because there had never been one.
//
// The readers below feed /money/invoices, /money/quotes, /money/collections,
// /money/costing, the dashboard's money card, the billing CSV export and the
// internal digest's money section. Every one of them used to be
// `db.select().from(invoices)` with no predicate and an `isStaffRole` gate, so
// any operator's staff could read - and export - every other operator's book.
//
// Real Postgres, in-process, seeded from the same DDL every deploy applies:
// the guarantee is in the WHERE clause, so a mocked database would be checking
// the mock rather than the query.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });

vi.mock("@/db", () => ({ db: testDb }));

const TODAY = "2026-08-26";

// Two service companies, a client each, and one of everything the money
// surfaces read. Ids are deterministic: orgs 1 and 2 are the operators, 3 and 4
// their clients.
beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO app_settings (id) VALUES (1);
    INSERT INTO orgs (name, kind, is_operator, parent_org_id) VALUES
      ('Sierra Spectra', 'provider', true,  NULL),
      ('Cascade Instrument', 'provider', true, NULL),
      ('Lab Zen', 'client', false, 1),
      ('Ellison BioLabs', 'client', false, 2);

    INSERT INTO invoices (tenant_org_id, org_id, number, status, issued_on, due_on) VALUES
      (1, 3, 'SIERRA-1', 'sent', '2026-06-01', '2026-06-30'),
      (2, 4, 'CASCADE-1', 'sent', '2026-06-02', '2026-07-02');
    INSERT INTO invoice_lines (invoice_id, kind, description, qty, unit_cents) VALUES
      (1, 'labor', 'Real work for a real client', 4000, 18500),
      (2, 'labor', 'Invented work for an invented one', 4000, 14500);

    INSERT INTO quotes (tenant_org_id, org_id, number, status) VALUES
      (1, 3, 'SIERRA-Q1', 'sent'),
      (2, 4, 'CASCADE-Q1', 'sent');

    INSERT INTO work_orders (tenant_org_id, number, org_id, title, state, opened_on) VALUES
      (1, 'SIERRA-WO', 3, 'Closed and unbilled', 'closed', '2026-08-01'),
      (2, 'CASCADE-WO', 4, 'Closed and unbilled', 'closed', '2026-08-01');
    UPDATE work_orders SET closed_at = '2026-08-20T12:00:00Z';
  `);
});

const numbers = (rows: { row: { number: string } }[]) => rows.map((r) => r.row.number).sort();

describe("one operator's staff cannot read another's money", () => {
  it("allInvoices returns only the asking workspace's invoices", async () => {
    const { allInvoices } = await import("@/lib/invoiceData");
    expect(numbers(await allInvoices(1))).toEqual(["SIERRA-1"]);
    expect(numbers(await allInvoices(2))).toEqual(["CASCADE-1"]);
  });

  it("allQuotes returns only the asking workspace's quotes", async () => {
    const { allQuotes } = await import("@/lib/invoiceData");
    expect(numbers(await allQuotes(1))).toEqual(["SIERRA-Q1"]);
    expect(numbers(await allQuotes(2))).toEqual(["CASCADE-Q1"]);
  });

  it("unbilledJobs returns only the asking workspace's closed jobs", async () => {
    const { unbilledJobs } = await import("@/lib/invoiceData");
    const mine = await unbilledJobs(1);
    const theirs = await unbilledJobs(2);
    expect(mine.every((j) => j.number === "SIERRA-WO")).toBe(true);
    expect(theirs.every((j) => j.number === "CASCADE-WO")).toBe(true);
    expect(mine.some((j) => j.number === "CASCADE-WO")).toBe(false);
  });

  it("collectionsBoard - what the dunning ladder and the money digest read", async () => {
    const { collectionsBoard } = await import("@/lib/invoiceData");
    const mine = await collectionsBoard(TODAY, 1);
    expect(mine.map((r) => r.invoice.row.number)).toEqual(["SIERRA-1"]);
    const theirs = await collectionsBoard(TODAY, 2);
    expect(theirs.map((r) => r.invoice.row.number)).toEqual(["CASCADE-1"]);
  });

  it("the money digest carries only its own edition's receivables", async () => {
    // The leak with teeth: composeDigest is per-workspace, but its money section
    // was not, so one operator's morning mail listed every other operator's
    // clients and balances - and a preview showed the same thing to anybody
    // holding a login on the newer workspace.
    const { moneyDigest } = await import("@/lib/invoiceData");
    const mine = JSON.stringify(await moneyDigest(TODAY, 1));
    expect(mine).toContain("Lab Zen");
    expect(mine).not.toContain("Ellison BioLabs");
  });
});

describe("platform staff still see the whole instance", () => {
  // readTenant() resolves to null for the operator that runs the instance, and
  // null has to keep meaning "no restriction" - somebody has to be able to
  // support every tenant, which is the whole reason that rule exists.
  it("null reads across every workspace", async () => {
    const { allInvoices, allQuotes } = await import("@/lib/invoiceData");
    expect(numbers(await allInvoices(null))).toEqual(["CASCADE-1", "SIERRA-1"]);
    expect(numbers(await allQuotes(null))).toEqual(["CASCADE-Q1", "SIERRA-Q1"]);
  });
});
