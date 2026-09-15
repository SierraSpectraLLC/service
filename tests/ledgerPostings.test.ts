// Gate 3: every money action posts what the brief's table says it posts.
//
// The real actions, against a real Postgres, with only the session faked -
// so the authorization, the row each one writes, the audit line and the
// ledger entry are all the actual code path. Each case asserts the ACCOUNTS
// and AMOUNTS the entry carries, because that table is the contract every
// screen from stage 5 on is built on.
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
};
let who: Who;
vi.mock("@/db", () => ({ db: testDb }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: who }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/notify", () => ({ notifyTaskAssigned: async () => {}, notifyInvite: async () => {} }));

const SIERRA = 3, LABZEN = 1;
const OWNER: Who = {
  email: "joe@sierra.test", name: "Joe", role: "owner",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: SIERRA,
};

const actions = await import("@/app/actions");
const money = await import("@/app/money/actions");
const ledger = await import("@/lib/ledger");

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO app_settings (id, client_access_enabled) VALUES (1, true);
    INSERT INTO orgs (name, kind) VALUES
      ('Lab Zen', 'client'), ('Coastal Analytical', 'client'),
      ('Sierra Spectra', 'provider'), ('Rival Instruments', 'provider');
    UPDATE orgs SET is_operator = true WHERE id IN (3, 4);
    UPDATE orgs SET parent_org_id = 3, terms_days = 30 WHERE id IN (1, 2);
    UPDATE app_settings SET operator_org_id = 3 WHERE id = 1;
    INSERT INTO stockrooms (name, tenant_org_id) VALUES ('Main shelf', 3);
    INSERT INTO house_members (email, org_id, role, name) VALUES
      ('joe@sierra.test', 3, 'owner', 'Joe'),
      ('bill@sierra.test', 3, 'staff', 'Bill');
    INSERT INTO org_sites (org_id, tenant_org_id, name, tax_rate_bps) VALUES (1, 3, 'Fresno lab', 825);
    INSERT INTO work_orders (tenant_org_id, org_id, number, title, state) VALUES (3, 1, 'WO-0401', 'Pump seal', 'active');
  `);
});

beforeEach(() => { who = OWNER; });

/** The accounts and amounts of one entry, as a sorted list of [account, dr, cr]. */
function shape(e: { lines: { account: string; debitCents: number; creditCents: number }[] }) {
  return e.lines.map((l) => [l.account, l.debitCents, l.creditCents] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
}
const invoiceEntries = (id: number) => ledger.timelineFor(SIERRA, "invoice", id);
/** The one entry whose memo starts this way - by name, since dates decide the order. */
async function entryFor(invoiceId: number, memoStart: string) {
  const e = (await invoiceEntries(invoiceId)).find((x) => x.memo.startsWith(memoStart));
  if (!e) throw new Error(`no entry starting "${memoStart}"`);
  return e;
}

async function draftInvoice(orgId: number, number: string, lines: string): Promise<number> {
  const [{ id }] = (await client.query<{ id: number }>(
    `INSERT INTO invoices (tenant_org_id, org_id, number, status, title) VALUES (${SIERRA}, ${orgId}, '${number}', 'draft', 'Test') RETURNING id`)).rows;
  await client.exec(`INSERT INTO invoice_lines (invoice_id, kind, description, qty, unit_cents, covered, position) VALUES ${lines.replace(/\$ID/g, String(id))}`);
  return id;
}

describe("invoices", () => {
  it("markInvoiceSent: receivable up by the total; revenue by line kind; tax to the state; covered lines nothing", async () => {
    const id = await draftInvoice(LABZEN, "INV-3001", `
      ($ID, 'labor',  'On site',   5000, 17500, false, 0),
      ($ID, 'part',   'Nebulizer', 1000, 168000, false, 1),
      ($ID, 'travel', 'Trip',      1000, 9500, false, 2),
      ($ID, 'tax',    'Sales tax', 1000, 13860, false, 3),
      ($ID, 'labor',  'Covered PM', 4000, 17500, true, 4)`);
    const res = await money.markInvoiceSent(id);
    expect(res.error).toBeUndefined();
    const [e] = await invoiceEntries(id);
    expect(shape(e)).toEqual([
      ["receivable", 87500 + 168000 + 9500 + 13860, 0],
      ["revenue_labor", 0, 87500],
      ["revenue_parts", 0, 168000],
      ["revenue_travel", 0, 9500],
      ["sales_tax_owed", 0, 13860],
    ]);
    expect(await ledger.balanceOf(id, SIERRA)).toBe(278860);
    expect((await ledger.positions(SIERRA)).salesTaxOwed).toBe(13860);
    // Sending it again is refused, and posts nothing more.
    expect((await money.markInvoiceSent(id)).error).toMatch(/already been sent/);
    expect(await invoiceEntries(id)).toHaveLength(1);
  });

  it("a fully covered $0 invoice posts nothing", async () => {
    const id = await draftInvoice(LABZEN, "INV-3002", `($ID, 'labor', 'Covered', 4000, 17500, true, 0)`);
    expect((await money.markInvoiceSent(id)).error).toBeUndefined();
    expect(await invoiceEntries(id)).toHaveLength(0);
  });

  it("recordPayment: bank up, receivable down; deletePayment reverses it dated today", async () => {
    const id = await draftInvoice(LABZEN, "INV-3003", `($ID, 'labor', 'Work', 2000, 17500, false, 0)`);
    await money.markInvoiceSent(id);
    const res = await money.recordPayment(id, { method: "check", amount: "150.00", reference: "#4502", receivedOn: "2026-09-10" });
    expect(res.error).toBeUndefined();
    const pay = await entryFor(id, "Payment on ");
    expect(pay.postedOn).toBe("2026-09-10");
    expect(shape(pay)).toEqual([["bank", 15000, 0], ["receivable", 0, 15000]]);
    expect(await ledger.balanceOf(id, SIERRA)).toBe(20000);
    const [row] = (await testDb.select().from(schema.invoices)).filter((i) => i.id === id);
    expect(row.status).toBe("partial");

    const [p] = (await testDb.select().from(schema.payments)).filter((p) => p.invoiceId === id);
    expect((await money.deletePayment(p.id, "check bounced")).error).toBeUndefined();
    const all = await invoiceEntries(id);
    expect(all).toHaveLength(3);
    const mirror = await entryFor(id, "Reversal of ");
    expect(mirror.reversesId).toBe(pay.id);
    expect(shape(mirror)).toEqual([["bank", 0, 15000], ["receivable", 15000, 0]]);
    expect(await ledger.balanceOf(id, SIERRA)).toBe(35000);
    expect((await testDb.select().from(schema.payments)).some((x) => x.id === p.id)).toBe(false);
    expect((await testDb.select().from(schema.invoices)).find((i) => i.id === id)!.status).toBe("sent");
  });

  it("postFee / waiveFee: the fee and its waiver are two entries, the row keeps `waived`", async () => {
    const id = await draftInvoice(LABZEN, "INV-3004", `($ID, 'part', 'Board', 1000, 100000, false, 0)`);
    await client.exec(`UPDATE invoices SET status = 'sent', issued_on = '2026-06-01', due_on = '2026-07-01' WHERE id = ${id}`);
    const inv = (await testDb.select().from(schema.invoices)).find((i) => i.id === id)!;
    const lines = (await testDb.select().from(schema.invoiceLines)).filter((l) => l.invoiceId === id);
    const { postInvoiceSent } = await import("@/lib/ledger/postings");
    await postInvoiceSent({ inv, lines, depositFor: null, by: "fixture" });
    const fee = await money.postFee(id);
    expect(fee.error).toBeUndefined();
    expect(fee.amountCents).toBeGreaterThan(0);
    const [, feeEntry] = await invoiceEntries(id);
    expect(shape(feeEntry)).toEqual([["receivable", fee.amountCents!, 0], ["revenue_fees", 0, fee.amountCents!]]);
    expect(await ledger.balanceOf(id, SIERRA)).toBe(100000 + fee.amountCents!);

    const [feeRow] = (await testDb.select().from(schema.invoiceFees)).filter((f) => f.invoiceId === id);
    expect((await money.waiveFee(feeRow.id, "goodwill, long client")).error).toBeUndefined();
    const [, , waive] = await invoiceEntries(id);
    expect(shape(waive)).toEqual([["receivable", 0, fee.amountCents!], ["revenue_fees", fee.amountCents!, 0]]);
    expect(waive.reversesId).toBeNull();   // its own entry, not a reversal
    expect(await ledger.balanceOf(id, SIERRA)).toBe(100000);
    const after = (await testDb.select().from(schema.invoiceFees)).find((f) => f.id === feeRow.id)!;
    expect(after.waived).toBe(true);
    expect(after.waivedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("resolveDispute(credited): the line's revenue down, receivable down", async () => {
    const id = await draftInvoice(LABZEN, "INV-3005", `($ID, 'part', 'Detector board', 1000, 428000, false, 0), ($ID, 'labor', 'Fit', 1000, 17500, false, 1)`);
    await money.markInvoiceSent(id);
    const [line] = (await testDb.select().from(schema.invoiceLines)).filter((l) => l.invoiceId === id && l.kind === "part");
    expect((await money.openDispute(id, { lineId: line.id, reason: "board was under OEM warranty" })).error).toBeUndefined();
    const [d] = (await testDb.select().from(schema.disputes)).filter((x) => x.invoiceId === id);
    expect((await money.resolveDispute(d.id, "credited", "warranty confirmed")).error).toBeUndefined();
    const [, credit] = await invoiceEntries(id);
    expect(shape(credit)).toEqual([["receivable", 0, 428000], ["revenue_parts", 428000, 0]]);
    expect(await ledger.balanceOf(id, SIERRA)).toBe(17500);
  });

  it("voidInvoice: the send and any fee are reversed; status void", async () => {
    const id = await draftInvoice(LABZEN, "INV-3006", `($ID, 'labor', 'Work', 1000, 50000, false, 0)`);
    await money.markInvoiceSent(id);
    expect(await ledger.balanceOf(id, SIERRA)).toBe(50000);
    expect((await money.voidInvoice(id, "billed to the wrong site")).error).toBeUndefined();
    expect(await ledger.balanceOf(id, SIERRA)).toBe(0);
    const all = await invoiceEntries(id);
    expect(all).toHaveLength(2);
    expect(all[1].reversesId).toBe(all[0].id);
    expect((await testDb.select().from(schema.invoices)).find((i) => i.id === id)!.status).toBe("void");
    // Nothing live is left to reverse, so a second void is a no-op.
    expect((await money.voidInvoice(id, "again")).error).toBeUndefined();
    expect(await invoiceEntries(id)).toHaveLength(2);
  });

  it("refuses to void an invoice with a payment on it", async () => {
    const id = await draftInvoice(LABZEN, "INV-3007", `($ID, 'labor', 'Work', 1000, 50000, false, 0)`);
    await money.markInvoiceSent(id);
    await money.recordPayment(id, { method: "ach", amount: "500.00", reference: "", receivedOn: "2026-09-11" });
    expect((await money.voidInvoice(id, "paid, cannot void")).error).toMatch(/reverse those first/);
  });
});

describe("deposits", () => {
  it("a quote's deposit invoice posts as a liability, and the final invoice applies it", async () => {
    await client.exec(`
      INSERT INTO quotes (id, org_id, tenant_org_id, work_order_id, number, title, status, sent_on, deposit_pct)
        VALUES (50, ${LABZEN}, ${SIERRA}, 1, 'Q-0141', 'Source rebuild', 'sent', '2026-09-01', 30);
      INSERT INTO quote_lines (quote_id, kind, description, qty, unit_cents, covered, position)
        VALUES (50, 'labor', 'Rebuild', 1000, 684000, false, 0);
      INSERT INTO share_links (token, kind, org_id, quote_id, expires_on, created_by)
        VALUES ('tok-lab-zen-000050', 'quote', ${LABZEN}, 50, '2099-12-31', 'fixture');
    `);
    const res = await actions.approveQuote("tok-lab-zen-000050", 50, "Dana R.");
    expect(res.error).toBeUndefined();
    expect(res.depositInvoiceId).toBeGreaterThan(0);
    const [dep] = await invoiceEntries(res.depositInvoiceId!);
    expect(dep.memo).toContain("deposit on Q-0141");
    expect(shape(dep)).toEqual([["deposits_held", 0, 205200], ["receivable", 205200, 0]]);
    expect((await ledger.positions(SIERRA)).depositsHeld).toBe(205200);

    // The deposit is paid; then the final invoice carries the offset line
    // draftInvoice writes, and the send applies the held deposit.
    await money.recordPayment(res.depositInvoiceId!, { method: "ach", amount: "2052.00", reference: "", receivedOn: "2026-09-03" });
    const id = await draftInvoice(LABZEN, "INV-3010", `
      ($ID, 'labor', 'Rebuild', 1000, 684000, false, 0),
      ($ID, 'fee_ref', 'Less deposit invoiced on Q-0141', 1000, -205200, false, 1)`);
    await money.markInvoiceSent(id);
    const [send] = await invoiceEntries(id);
    expect(shape(send)).toEqual([["deposits_held", 205200, 0], ["receivable", 478800, 0], ["revenue_labor", 0, 684000]]);
    expect((await ledger.positions(SIERRA)).depositsHeld).toBe(0);
  });

  it("requestDeposit (credit hold): sent on creation, posts on creation, as a charge", async () => {
    await client.exec(`
      INSERT INTO invoices (id, tenant_org_id, org_id, number, status, issued_on, due_on) VALUES (60, ${SIERRA}, 2, 'INV-OLD', 'sent', '2026-05-01', '2026-05-31');
      INSERT INTO invoice_lines (invoice_id, kind, description, qty, unit_cents) VALUES (60, 'part', 'HED supply', 1000, 429000);
    `);
    const res = await money.requestDeposit(2, "");
    expect(res.error).toBeUndefined();
    const [e] = await invoiceEntries(res.id!);
    expect(e.lines.find((l) => l.account === "receivable")!.debitCents).toBeGreaterThan(0);
    expect(e.lines.map((l) => l.account).sort()).toEqual(["receivable", "revenue_fees"]);
  });
});

describe("money out", () => {
  it("receivePoLine: parts cost up, payable up for the received qty × price; payPurchaseOrder pays it down", async () => {
    const made = await actions.createPurchaseOrder({ vendor: "Edwards", stockroomId: 1, lines: [], allowEmpty: true });
    expect(made.id).toBeGreaterThan(0);
    await actions.addPoLine(made.id!, { partNumber: "nXDS10i", name: "Pump", qty: "2", price: "1490.00" });
    await actions.sendPurchaseOrder(made.id!);
    const [line] = (await testDb.select().from(schema.poLines)).filter((l) => l.poId === made.id);
    expect((await actions.receivePoLine(line.id, 1)).error).toBeUndefined();
    let es = await ledger.timelineFor(SIERRA, "po", made.id!);
    expect(es).toHaveLength(1);
    expect(shape(es[0])).toEqual([["cost_parts", 149000, 0], ["payable", 0, 149000]]);
    expect((await actions.receivePoLine(line.id, 1)).error).toBeUndefined();
    es = await ledger.timelineFor(SIERRA, "po", made.id!);
    expect(es).toHaveLength(2);
    expect((await ledger.positions(SIERRA)).payable).toBe(298000);

    // Not yet paid: refused for the wrong reasons first.
    expect((await money.payPurchaseOrder(made.id!, { paidOn: "2099-01-01", reference: "" })).error).toMatch(/future/);
    expect((await money.payPurchaseOrder(made.id!, { paidOn: "2026-09-12", reference: "ACH 4471" })).error).toBeUndefined();
    es = await ledger.timelineFor(SIERRA, "po", made.id!);
    const paid = es.find((e) => e.postedOn === "2026-09-12")!;
    expect(shape(paid)).toEqual([["bank", 0, 298000], ["payable", 298000, 0]]);
    expect((await ledger.positions(SIERRA)).payable).toBe(0);
    expect((await testDb.select().from(schema.purchaseOrders)).find((p) => p.id === made.id)!.paidOn).toBe("2026-09-12");
    expect((await money.payPurchaseOrder(made.id!, { paidOn: "2026-09-12", reference: "" })).error).toMatch(/was paid on/);
  });

  it("the bills cron: overhead up, bank down per cycle, never twice", async () => {
    await client.exec(`
      INSERT INTO bills (tenant_org_id, name, payee, kind, amount_cents, every_months, day_of_month, starts_on, active, autopay)
      VALUES (${SIERRA}, 'Rent', 'Sierra Commerce Park', 'Rent', 185000, 1, 1, '2026-08-01', true, true);
    `);
    const { runBills } = await import("@/lib/billRun");
    const first = await runBills(new Date("2026-09-14T19:00:00Z"));
    expect(first.posted.map((p) => p.on)).toEqual(["2026-08-01", "2026-09-01"]);
    const [bill] = await testDb.select().from(schema.bills);
    let es = await ledger.timelineFor(SIERRA, "bill", bill.id);
    expect(es.map((e) => e.postedOn)).toEqual(["2026-08-01", "2026-09-01"]);
    expect(shape(es[0])).toEqual([["bank", 0, 185000], ["overhead", 185000, 0]]);
    await runBills(new Date("2026-09-14T20:00:00Z"));
    es = await ledger.timelineFor(SIERRA, "bill", bill.id);
    expect(es).toHaveLength(2);
  });

  it("payExpenseReport: field expenses up, bank down, on the day paid, against the job", async () => {
    await client.exec(`
      INSERT INTO expense_reports (id, tenant_org_id, person, title, work_order_id, status, submitted_by) VALUES (70, ${SIERRA}, 'Bill Reyes', 'Fresno trip', 1, 'submitted', 'bill@sierra.test');
      INSERT INTO expenses (tenant_org_id, work_order_id, kind, description, amount_cents, incurred_on, person, logged_by, report_id) VALUES
        (${SIERRA}, 1, 'Fuel', 'Round trip', 6140, '2026-09-02', 'Bill Reyes', 'bill@sierra.test', 70),
        (${SIERRA}, 1, 'Meals', 'Lunch', 3860, '2026-09-02', 'Bill Reyes', 'bill@sierra.test', 70);
    `);
    expect((await money.payExpenseReport(70, { paidOn: "2026-09-04", reference: "Zelle" })).error).toBeUndefined();
    const [e] = await ledger.timelineFor(SIERRA, "report", 70);
    expect(e.postedOn).toBe("2026-09-04");
    expect(e.refWorkOrderId).toBe(1);
    expect(e.refOrgId).toBe(LABZEN);
    expect(shape(e)).toEqual([["bank", 0, 10000], ["cost_field_expenses", 10000, 0]]);
  });

  it("logOverheadExpense: company-paid posts; a row somebody is owed for does not", async () => {
    expect((await money.logOverheadExpense({ kind: "Software", description: "Google Workspace", amount: "72.00", incurredOn: "2026-09-01", person: "" })).error).toBeUndefined();
    const rows = await testDb.select().from(schema.expenses);
    const seat = rows.find((r) => r.description === "Google Workspace")!;
    const [e] = await ledger.timelineFor(SIERRA, "expense", seat.id);
    expect(shape(e)).toEqual([["bank", 0, 7200], ["overhead", 7200, 0]]);
    expect((await money.logOverheadExpense({ kind: "Other", description: "Bill's internet", amount: "35.00", incurredOn: "2026-09-01", person: "Bill" })).error).toBeUndefined();
    const owed = (await testDb.select().from(schema.expenses)).find((r) => r.description === "Bill's internet")!;
    expect(await ledger.timelineFor(SIERRA, "expense", owed.id)).toHaveLength(0);
    // Removing the company-paid row reverses it.
    expect((await actions.deleteExpense(seat.id, "logged twice")).error).toBeUndefined();
    const after = await ledger.timelineFor(SIERRA, "expense", seat.id);
    expect(after).toHaveLength(2);
    expect(after[1].reversesId).toBe(e.id);
    expect(await ledger.sumAccount("overhead", { tenant: SIERRA, refType: "expense", refId: String(seat.id) })).toBe(0);
  });

  it("logExpense on a job, company-paid: the job's field cost, not overhead", async () => {
    expect((await actions.logExpense(1, { kind: "shipping", description: "Crane, half day", amount: "450.00", incurredOn: "2026-09-05" })).error).toBeUndefined();
    const row = (await testDb.select().from(schema.expenses)).find((r) => r.description === "Crane, half day")!;
    const [e] = await ledger.timelineFor(SIERRA, "expense", row.id);
    expect(e.refWorkOrderId).toBe(1);
    expect(shape(e)).toEqual([["bank", 0, 45000], ["cost_field_expenses", 45000, 0]]);
  });

  it("runPayroll: once per month at the register's gross; payroll up, bank down", async () => {
    await client.exec(`
      INSERT INTO payroll (tenant_org_id, org_id, name, kind, amount_cents, effective_on) VALUES
        (${SIERRA}, ${SIERRA}, 'Priya', 'monthly', 800000, '2026-01-01'),
        (${SIERRA}, ${SIERRA}, 'Marcus', 'monthly', 660000, '2026-01-01');
    `);
    const res = await money.runPayroll("2026-08");
    expect(res.error).toBeUndefined();
    expect(res.grossCents).toBe(1460000);
    const [e] = await ledger.timelineFor(SIERRA, "payroll", "2026-08");
    expect(e.memo).toBe("Payroll - August 2026");
    expect(shape(e)).toEqual([["bank", 0, 1460000], ["payroll", 1460000, 0]]);
    expect((await money.runPayroll("2026-08")).error).toMatch(/was run on/);
    expect(await ledger.timelineFor(SIERRA, "payroll", "2026-08")).toHaveLength(1);
    expect((await money.runPayroll("2099-01")).error).toMatch(/not started/);
  });

  it("setCashOpening: bank against equity on its day; changing it is a reversal plus a new entry", async () => {
    expect((await money.setCashOpening({ amount: "58,500.00", on: "2026-07-01" })).error).toBeUndefined();
    let es = await ledger.timelineFor(SIERRA, "opening", SIERRA);
    expect(es).toHaveLength(1);
    expect(es[0].postedOn).toBe("2026-07-01");
    expect(shape(es[0])).toEqual([["bank", 5850000, 0], ["opening_balance", 0, 5850000]]);
    expect((await money.setCashOpening({ amount: "60,000.00", on: "2026-08-01" })).error).toBeUndefined();
    es = await ledger.timelineFor(SIERRA, "opening", SIERRA);
    expect(es).toHaveLength(3);
    expect(es.filter((e) => e.reversesId !== null)).toHaveLength(1);
    expect(await ledger.sumAccount("opening_balance", { tenant: SIERRA })).toBe(6000000);
  });

  it("remitTax: the liability down, bank down, for what is owed", async () => {
    const owed = (await ledger.positions(SIERRA)).salesTaxOwed;
    expect(owed).toBe(13860);
    const res = await money.remitTax({ period: "2026-Q3", paidOn: "2026-09-14" });
    expect(res.cents).toBe(13860);
    const [e] = await ledger.timelineFor(SIERRA, "tax", "2026-Q3");
    expect(shape(e)).toEqual([["bank", 0, 13860], ["sales_tax_owed", 13860, 0]]);
    expect((await ledger.positions(SIERRA)).salesTaxOwed).toBe(0);
    expect((await money.remitTax({ period: "2026-Q3", paidOn: "2026-09-14" })).error).toMatch(/No sales tax/);
  });
});

describe("Stripe", () => {
  it("a pay-link payment lands in the Stripe balance with its fee as a cost row", async () => {
    const id = await draftInvoice(LABZEN, "INV-3020", `($ID, 'labor', 'Work', 1000, 100000, false, 0)`);
    await money.markInvoiceSent(id);
    const { recordStripePayment } = await import("@/lib/stripeSettle");
    await recordStripePayment({ invoiceId: id, amountCents: 100000, reference: "pi_1", method: "card", feeCents: 2930 });
    await recordStripePayment({ invoiceId: id, amountCents: 100000, reference: "pi_1", method: "card", feeCents: 2930 });   // the retry
    const es = await invoiceEntries(id);
    expect(es).toHaveLength(3);
    expect(shape(es[1])).toEqual([["receivable", 0, 100000], ["stripe", 100000, 0]]);
    expect(shape(es[2])).toEqual([["cost_processing", 2930, 0], ["stripe", 0, 2930]]);
    const p = await ledger.positions(SIERRA);
    expect(p.stripe).toBe(97070);
    expect(await ledger.balanceOf(id, SIERRA)).toBe(0);
  });

  it("a referral fee paid to another shop is a cost on the payer's books", async () => {
    await client.exec(`
      INSERT INTO client_shares (id, tenant_org_id, to_org_id, source_org_id, status) VALUES (5, ${SIERRA}, ${SIERRA}, 4, 'accepted');
      INSERT INTO referral_fees (id, tenant_org_id, share_id, payee_org_id, payer_org_id, kind, fee_cents, status)
        VALUES (80, ${SIERRA}, 5, 4, ${SIERRA}, 'flat', 50000, 'open');
    `);
    const { recordReferralPayment } = await import("@/lib/stripeSettle");
    await recordReferralPayment({ feeId: 80, amountCents: 50000, reference: "pi_ref" });
    const [e] = await ledger.timelineFor(SIERRA, "referral", 80);
    expect(shape(e)).toEqual([["bank", 0, 50000], ["overhead", 50000, 0]]);
  });
});

describe("the journal actions", () => {
  it("closeBooks refuses the current month, closes a past one, and post() then refuses it", async () => {
    expect((await money.closeBooks("2099-01")).error).toMatch(/not ended/);
    expect((await money.closeBooks("2026-07")).error).toBeUndefined();
    expect((await money.recordPayment(60, { method: "check", amount: "10.00", reference: "", receivedOn: "2026-07-15" })).error).toMatch(/closed month/);
    // The refused payment left no row behind.
    expect((await testDb.select().from(schema.payments)).filter((p) => p.invoiceId === 60)).toHaveLength(0);
    expect((await money.closeBooks("")).was).toBe("2026-07");
  });

  it("reverseLedgerEntry mirrors an entry with the reason, and routes a payment through deletePayment", async () => {
    const id = await draftInvoice(LABZEN, "INV-3030", `($ID, 'labor', 'Work', 1000, 20000, false, 0)`);
    await money.markInvoiceSent(id);
    await money.recordPayment(id, { method: "check", amount: "200.00", reference: "", receivedOn: "2026-09-12" });
    const pay = await entryFor(id, "Payment on ");
    expect((await money.reverseLedgerEntry(pay.id, "entered on the wrong invoice")).error).toBeUndefined();
    expect((await testDb.select().from(schema.payments)).filter((p) => p.invoiceId === id)).toHaveLength(0);
    expect(await ledger.balanceOf(id, SIERRA)).toBe(20000);
    const send = await entryFor(id, "INV-3030 sent");
    expect((await money.reverseLedgerEntry(send.id, "never sent")).error).toBeUndefined();
    expect(await ledger.balanceOf(id, SIERRA)).toBe(0);
    expect((await money.reverseLedgerEntry(send.id, "")).error).toMatch(/reason/);
  });

  it("another workspace's owner cannot reach any of it", async () => {
    // Operator 4's owner; the ROOT operator stays 3, so this is not platform staff.
    who = { ...OWNER, email: "sam@rival.test", operatorOrgId: 4 };
    const id = (await testDb.select().from(schema.invoices)).find((i) => i.number === "INV-3001")!.id;
    expect((await money.recordPayment(id, { method: "check", amount: "1.00", reference: "", receivedOn: "2026-09-12" })).error).toBe("Not found");
    expect((await money.voidInvoice(id, "mine now")).error).toBe("Not found");
    expect((await money.postFee(id)).error).toBe("Not found");
    const [e] = await invoiceEntries(id);
    expect((await money.reverseLedgerEntry(e.id, "mine now")).error).toBe("Not found");
    expect((await money.payExpenseReport(70, { paidOn: "2026-09-04", reference: "" })).error).toBe("Not found");
    expect((await ledger.positions(4)).receivable).toBe(0);
  });
});

describe("every posting has a natural key", () => {
  it("no entry from the actions above is missing one", async () => {
    const rows = await testDb.select().from(schema.ledgerEntries);
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.filter((r) => r.postingKey === "")).toEqual([]);
  });
});
