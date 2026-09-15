// Gate 4: the backfill derives the ledger from history, twice gives once,
// and parity between the old arithmetic and the journal reads zero.
//
// The fixture is the shape of the dev:local seed - an operator with an
// opening balance, invoices in every status, payments, a fee and a waiver, a
// credited dispute, a paid claim and an unpaid one, overhead rows both
// company-paid and owed to a person, a bill with two cycles, a register, a
// received order - plus a second workspace that must not bleed in.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));

const SIERRA = 3, OTHER = 4, LABZEN = 1, COASTAL = 2;
const TODAY = "2026-09-14";

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO app_settings (id) VALUES (1);
    INSERT INTO orgs (name, kind) VALUES ('Lab Zen', 'client'), ('Coastal Analytical', 'client'), ('Sierra Spectra', 'provider'), ('Rival', 'provider');
    UPDATE orgs SET is_operator = true WHERE id IN (3, 4);
    UPDATE orgs SET parent_org_id = 3 WHERE id IN (1, 2);
    UPDATE app_settings SET operator_org_id = 3 WHERE id = 1;
    UPDATE orgs SET cash_opening_cents = 5850000, cash_opening_on = '2026-07-01' WHERE id = 3;
    INSERT INTO work_orders (id, tenant_org_id, org_id, number, title, state) VALUES (1, 3, 1, 'WO-0401', 'Pump', 'closed');

    -- Invoices: paid (unstamped - the platform's own shop wrote it), open,
    -- partial with a fee later waived, one with a credited dispute, a draft,
    -- a void, and a rival's.
    INSERT INTO invoices (id, tenant_org_id, org_id, work_order_id, number, status, issued_on, due_on, title) VALUES
      (10, NULL, 1, NULL, 'INV-0090', 'paid',    '2026-07-15', '2026-08-14', 'July work'),
      (11, 3,    2, 1,    'INV-0091', 'sent',    '2026-08-22', '2026-09-21', 'August work'),
      (12, 3,    1, NULL, 'INV-0092', 'partial', '2026-07-28', '2026-08-27', 'Pump'),
      (13, 3,    2, NULL, 'INV-0093', 'sent',    '2026-08-05', '2026-09-04', 'Board'),
      (14, 3,    1, NULL, 'INV-0094', 'draft',   '',           '',           'Not yet'),
      (15, 3,    1, NULL, 'INV-0095', 'void',    '2026-08-01', '2026-08-31', 'Wrong site'),
      (16, 4,    2, NULL, 'RIV-0001', 'sent',    '2026-09-01', '2026-10-01', 'Theirs');
    INSERT INTO invoice_lines (id, invoice_id, kind, description, qty, unit_cents, covered, source_id, position) VALUES
      (100, 10, 'labor', 'On site',   5000, 17500, false, NULL, 0),
      (101, 10, 'part',  'Nebulizer', 1000, 168000, false, NULL, 1),
      (102, 10, 'tax',   'Sales tax', 1000, 13860, false, NULL, 2),
      (110, 11, 'labor', 'On site', 12000, 17500, false, NULL, 0),
      (111, 11, 'labor', 'Covered', 4000, 17500, true, NULL, 1),
      (120, 12, 'part',  'Pump', 1000, 239700, false, NULL, 0),
      (130, 13, 'part',  'Detector board', 1000, 428000, false, NULL, 0),
      (131, 13, 'labor', 'Fit', 6000, 17500, false, NULL, 1),
      (132, 13, 'fee_ref', 'Credit memo - Detector board', 1000, -428000, false, 130, 2),
      (140, 14, 'labor', 'Draft', 1000, 100, false, NULL, 0),
      (150, 15, 'labor', 'Void', 1000, 100, false, NULL, 0),
      (160, 16, 'labor', 'Rival', 1000, 999999, false, NULL, 0);
    INSERT INTO payments (id, tenant_org_id, invoice_id, method, amount_cents, reference, received_on, recorded_by) VALUES
      (200, NULL, 10, 'check', 269360, '#4471', '2026-08-12', 'joe@sierra.test'),
      (201, 3,    12, 'check', 150000, '#4502', '2026-08-30', 'joe@sierra.test'),
      (202, 4,    16, 'ach',   999999, '',      '2026-09-02', 'sam@rival.test');
    INSERT INTO invoice_fees (id, tenant_org_id, invoice_id, amount_cents, basis, posted_on, posted_by, waived, waived_by, waived_reason) VALUES
      (300, 3, 12, 1346, '1.5%/mo on $897.00, 5 days past due', '2026-09-01', 'auto', false, '', ''),
      (301, 3, 12, 900,  'flat', '2026-08-01', 'auto', true, 'joe@sierra.test', 'goodwill');
    INSERT INTO disputes (id, tenant_org_id, invoice_id, line_id, reason, opened_on, opened_by, resolved_on, resolution, resolved_by) VALUES
      (400, 3, 13, 130, 'OEM warranty', '2026-09-03', 'joe', '2026-09-10', 'credited', 'joe');

    -- Claims and expenses.
    INSERT INTO expense_reports (id, tenant_org_id, person, title, work_order_id, status, submitted_by, paid_on, paid_by) VALUES
      (500, 3, 'Priya', 'Merced trip', 1, 'paid', 'priya', '2026-09-04', 'joe'),
      (501, 3, 'Marcus', 'Ridgecrest', NULL, 'submitted', 'marcus', '', '');
    INSERT INTO expenses (tenant_org_id, work_order_id, kind, description, amount_cents, incurred_on, billable, person, logged_by, report_id) VALUES
      (3, 1,    'Fuel', 'Round trip',      14800, '2026-09-02', true,  'Priya',  'priya', 500),
      (3, NULL, 'Lodging', 'Hotel',        31240, '2026-09-10', true,  'Marcus', 'marcus', 501),
      (3, NULL, 'Software', 'Seat',         7200, '2026-08-01', false, '',       'joe', NULL),
      (3, NULL, 'Other', 'Bill internet',   3500, '2026-08-03', false, 'Bill',   'joe', NULL),
      (3, 1,    'Shipping', 'Crane',       45000, '2026-09-05', true,  '',       'joe', NULL);
    INSERT INTO bills (id, tenant_org_id, name, payee, kind, amount_cents, every_months, day_of_month, starts_on, active, last_on) VALUES
      (600, 3, 'Rent', 'Sierra Commerce Park', 'Rent', 185000, 1, 1, '2026-08-01', true, '2026-09-01');
    INSERT INTO expenses (tenant_org_id, work_order_id, kind, description, amount_cents, incurred_on, billable, person, logged_by, bill_id) VALUES
      (3, NULL, 'Rent', 'Rent - August', 185000, '2026-08-01', false, '', '', 600),
      (3, NULL, 'Rent', 'Rent - September', 185000, '2026-09-01', false, '', '', 600);

    -- The register: two people, one who started in August.
    INSERT INTO payroll (tenant_org_id, org_id, name, kind, amount_cents, effective_on) VALUES
      (3, 3, 'Priya', 'monthly', 800000, '2026-01-01'),
      (3, 3, 'Marcus', 'monthly', 660000, '2026-08-01');

    -- A received order, half paid for by a live receipt already on the ledger.
    INSERT INTO purchase_orders (id, tenant_org_id, number, vendor, status, work_order_id, sent_at, closed_at, created_by) VALUES
      (700, 3, 'PO-0312', 'Agilent', 'received', 1, '2026-09-01', '2026-09-06', 'joe');
    INSERT INTO po_lines (id, po_id, part_number, name, qty_ordered, qty_received, unit_cents) VALUES
      (800, 700, 'G1', 'Seal kit', 2, 2, 57360);
  `);
});

const money = async (id: number) => (await import("@/lib/ledger")).balanceOf(id, SIERRA);

describe("the backfill", () => {
  it("dry-run writes nothing and says what it would", async () => {
    const { backfillLedger } = await import("@/lib/ledger/backfill");
    const dry = await backfillLedger({ today: TODAY, dryRun: true });
    expect(dry.planned.length).toBeGreaterThan(10);
    expect(dry.created).toBe(dry.planned.length);
    expect((await testDb.select().from(schema.ledgerEntries)).length).toBe(0);
    // Every planned entry balances and carries a key.
    for (const p of dry.planned) {
      expect(p.key).not.toBe("");
      const dr = p.lines.reduce((n, l) => n + (l.debitCents ?? 0), 0);
      const cr = p.lines.reduce((n, l) => n + (l.creditCents ?? 0), 0);
      expect(dr).toBe(cr);
    }
    // The unstamped invoice lands with the instance's operator.
    expect(dry.planned.find((p) => p.key === "invoice:10:send")!.tenantOrgId).toBe(SIERRA);
    expect(dry.planned.filter((p) => p.tenantOrgId === OTHER).map((p) => p.key)).toEqual(["invoice:16:send", "invoice:16:payment:202"]);
  });

  it("writes history once; a second run finds everything already posted", async () => {
    const { backfillLedger } = await import("@/lib/ledger/backfill");
    const first = await backfillLedger({ today: TODAY });
    expect(first.skipped).toEqual([]);
    expect(first.created).toBeGreaterThan(10);
    expect(first.existing).toBe(0);
    const n = (await testDb.select().from(schema.ledgerEntries)).length;
    expect(n).toBe(first.created);
    const again = await backfillLedger({ today: TODAY });
    expect(again.created).toBe(0);
    expect(again.existing).toBe(first.created);
    expect((await testDb.select().from(schema.ledgerEntries)).length).toBe(n);
  });

  it("derives the right figures", async () => {
    const { positions, periodFlow, timelineFor } = await import("@/lib/ledger");
    expect(await money(10)).toBe(0);                                  // paid in full
    expect(await money(11)).toBe(210000);                             // 12 h, the covered 4 h worth nothing
    expect(await money(12)).toBe(239700 - 150000 + 1346);             // partial, live fee, waived fee nets out
    expect(await money(13)).toBe(105000);                             // credit memo posted on its own day
    const credit = (await timelineFor(SIERRA, "invoice", 13)).find((e) => e.memo.startsWith("Credit on"))!;
    expect(credit.postedOn).toBe("2026-09-10");
    expect(await money(14)).toBe(0);
    expect(await money(15)).toBe(0);
    const p = await positions(SIERRA);
    expect(p.receivable).toBe(210000 + 91046 + 105000);
    expect(p.salesTaxOwed).toBe(13860);
    expect(p.payable).toBe(114720);
    // Cash: opening + payments - claim paid - company-paid rows - bills - payroll (July, August ended).
    expect(p.bank).toBe(5850000 + 269360 + 150000 - 14800 - 7200 - 45000 - 370000 - 800000 - 1460000);
    const sep = await periodFlow(SIERRA, "2026-09-01", "2026-09-30");
    expect(sep.cost.overhead).toBe(185000);
    expect(sep.cost.cost_field_expenses).toBe(14800 + 45000);
    expect(sep.cost.payroll).toBe(0);                                  // September has not ended
    expect(sep.revenue.revenue_fees).toBe(1346);
    expect(sep.revenue.revenue_parts).toBe(-428000);                   // the September credit
    const runs = await testDb.select().from(schema.payrollRuns);
    expect(runs.map((r) => [r.ym, r.grossCents]).sort()).toEqual([["2026-07", 800000], ["2026-08", 1460000]]);
    expect((await positions(OTHER)).receivable).toBe(0);
    expect((await positions(OTHER)).bank).toBe(999999);
  });

  it("parity: every figure the old arithmetic can compute agrees with the ledger", async () => {
    const { parityFor } = await import("@/lib/ledger/parity");
    const figures = await parityFor(SIERRA, TODAY);
    const off = figures.filter((f) => f.diffCents !== 0).map((f) => `${f.key}: legacy ${f.legacyCents} ledger ${f.ledgerCents}`);
    // The one known gap: lib/cash never counted the company-paid job
    // expense (the crane) or a paid purchase order; the ledger does.
    expect(off).toEqual(["cash: legacy 3617360 ledger 3572360"]);
    expect(figures.map((f) => f.key)).toEqual(["receivable", "deposits", "tax", "revenue", "collected", "overhead", "field", "payroll", "payable", "cash"]);
  });

  it("a later receipt on the same line is a new remainder, not a repost", async () => {
    const { backfillLedger } = await import("@/lib/ledger/backfill");
    const { positions } = await import("@/lib/ledger");
    await client.exec(`UPDATE po_lines SET qty_received = 3, qty_ordered = 3 WHERE id = 800`);
    const run = await backfillLedger({ today: TODAY, tenantOrgId: SIERRA });
    expect(run.created).toBe(1);
    expect((await positions(SIERRA)).payable).toBe(3 * 57360);
    const again = await backfillLedger({ today: TODAY, tenantOrgId: SIERRA });
    expect(again.created).toBe(0);
  });
});
