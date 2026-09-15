// Ledger parity: the same figures, computed both ways, and the difference.
//
// For the dual-write period the old arithmetic (rows summed at render, one
// formula per screen) and the ledger (SUM() over the journal) run side by
// side. This is the check that decides whether the reads may flip: every
// figure below is computed from the legacy rows exactly as the legacy pages
// compute it, and from the ledger, and the diff is printed per figure. Zero
// everywhere, or every nonzero written up with its reason, is gate 4.
//
// The legacy side is re-implemented here rather than called through
// lib/financeData, for one reason: financeFigures scopes by readTenant(),
// which is null for the platform's own operator and therefore reads the
// whole instance. Parity has to compare one workspace to one workspace, so
// each legacy formula is repeated with an explicit tenant, and the comment
// on each names the page it came from.

import { and, eq, gte, inArray, isNull, lte, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  appSettings, expenseReports, expenses, invoiceFees, invoiceLines, invoices, ledgerParity, orgs,
  payments, payroll, payrollRuns, poLines, purchaseOrders, quotes, disputes,
} from "@/db/schema";
import { invoiceView, isOpen, type InvoiceRow } from "@/lib/statement";
import { payrollForMonth, type PayRow } from "@/lib/payroll";
import { endOfMonth } from "@/lib/bills";
import { periodEnd, periodStart } from "@/lib/finance";
import { periodFlow, positions } from "@/lib/ledger/sums";
import { companyPaid, isDepositOffset } from "@/lib/ledger/postings";
import { monthsBetween } from "@/lib/ledger/backfill";

export type ParityFigure = {
  key: string;
  label: string;
  legacyCents: number;
  ledgerCents: number;
  diffCents: number;
  /** Where each side comes from, in a sentence. */
  note: string;
};

export type ParityRun = { tenantOrgId: number; orgName: string; figures: ParityFigure[]; today: string };

/** The rows of one workspace - including the unstamped ones, for the instance's own operator. */
function ownedBy(col: AnyColumn, tenant: number, fallback: number | null): SQL {
  return tenant === fallback ? (or(eq(col, tenant), isNull(col)) as SQL) : eq(col, tenant);
}

const lineCents = (l: { qty: number; unitCents: number }) => Math.round((l.qty / 1000) * l.unitCents);

export async function parityFor(tenant: number, today: string): Promise<ParityFigure[]> {
  const [settings] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  const fallback = settings?.operatorOrgId ?? null;
  const from = periodStart(today, "month"), to = periodEnd(today, "month");
  const inWindow = (d: string) => d >= from && d <= to;

  const [invRows, pos, flow] = await Promise.all([
    db.select().from(invoices).where(ownedBy(invoices.tenantOrgId, tenant, fallback)),
    positions(tenant),
    periodFlow(tenant, from, to),
  ]);
  const ids = invRows.map((i) => i.id);
  const [lineRows, payRows, feeRows, disputeRows, depositQuotes] = ids.length ? await Promise.all([
    db.select().from(invoiceLines).where(inArray(invoiceLines.invoiceId, ids)),
    db.select().from(payments).where(inArray(payments.invoiceId, ids)),
    db.select().from(invoiceFees).where(inArray(invoiceFees.invoiceId, ids)),
    db.select().from(disputes).where(inArray(disputes.invoiceId, ids)),
    db.select({ invoiceId: quotes.depositInvoiceId }).from(quotes).where(inArray(quotes.depositInvoiceId, ids)),
  ]) : [[], [], [], [], []];
  const depositIds = new Set(depositQuotes.map((q) => q.invoiceId as number));

  // lib/invoiceData.asStatementRow, then lib/statement.invoiceView.
  const views = invRows.map((row) => {
    const lines = lineRows.filter((l) => l.invoiceId === row.id);
    const open = disputeRows.filter((d) => d.invoiceId === row.id && d.resolvedOn === null && d.lineId !== null);
    const disputed = open.reduce((n, d) => {
      const line = lines.find((l) => l.id === d.lineId);
      return n + (line && !line.covered ? lineCents(line) : 0);
    }, 0);
    const sr: InvoiceRow = {
      id: row.id, number: row.number, orgId: row.orgId, status: row.status,
      issuedOn: row.issuedOn, dueOn: row.dueOn,
      lines: lines.map((l) => ({ qty: l.qty / 1000, unitCents: l.unitCents, covered: l.covered })),
      feeCents: feeRows.filter((f) => f.invoiceId === row.id && !f.waived).map((f) => f.amountCents),
      paidCents: payRows.filter((p) => p.invoiceId === row.id).map((p) => p.amountCents),
      disputedCents: disputed,
    };
    return { row, view: invoiceView(sr, today) };
  });

  const figures: ParityFigure[] = [];
  const fig = (key: string, label: string, legacyCents: number, ledgerCents: number, note: string) =>
    figures.push({ key, label, legacyCents, ledgerCents, diffCents: ledgerCents - legacyCents, note });

  // Receivable: /money "Owed to you" = open invoices' balances (lines + live fees - payments).
  fig("receivable", "Receivable",
    views.filter((v) => isOpen(v.view)).reduce((n, v) => n + v.view.balanceCents, 0),
    pos.receivable,
    "Legacy: balances of open invoices, financeFigures.currentCents + pastDueCents. Ledger: the receivable account.");

  // Deposits held: deposit invoices raised at quote approval, less what later invoices applied.
  const depositRaised = invRows.filter((i) => depositIds.has(i.id) && i.status !== "void" && i.status !== "draft")
    .reduce((n, i) => n + lineRows.filter((l) => l.invoiceId === i.id && !l.covered).reduce((m, l) => m + lineCents(l), 0), 0);
  const depositApplied = invRows.filter((i) => i.status !== "void" && i.status !== "draft")
    .reduce((n, i) => n + lineRows.filter((l) => l.invoiceId === i.id && isDepositOffset(l)).reduce((m, l) => m - lineCents(l), 0), 0);
  fig("deposits", "Deposits held", depositRaised - depositApplied, pos.depositsHeld,
    "Legacy: deposit invoices (quotes.deposit_invoice_id) less the offset lines on later invoices. Ledger: deposits held.");

  // Sales tax owed: tax lines on sent invoices, less remits (none before the ledger).
  const taxLines = invRows.filter((i) => i.status !== "void" && i.status !== "draft")
    .reduce((n, i) => n + lineRows.filter((l) => l.invoiceId === i.id && l.kind === "tax" && !l.covered).reduce((m, l) => m + lineCents(l), 0), 0);
  const remitted = await sumRemits(tenant);
  fig("tax", "Sales tax owed", taxLines - remitted, pos.salesTaxOwed,
    "Legacy: tax lines on sent invoices, less remittances. Ledger: sales tax owed.");

  // Revenue this month: /money/costing's billed figure, by issue date. A
  // credit memo counts in the month its dispute was resolved, which is the
  // day the money was given back - the invoice's own month would put a
  // September credit into August.
  const creditMonth = new Map<number, string>();
  for (const d of disputeRows) {
    if (d.resolution === "credited" && d.resolvedOn && d.lineId !== null) {
      const memo = lineRows.find((l) => l.sourceId === d.lineId && l.unitCents < 0 && l.kind === "fee_ref");
      if (memo) creditMonth.set(memo.id, d.resolvedOn);
    }
  }
  const revenueLegacy = invRows
    .filter((i) => i.status !== "void" && i.status !== "draft" && !depositIds.has(i.id))
    .reduce((n, i) => n + lineRows
      .filter((l) => l.invoiceId === i.id && !l.covered && l.kind !== "tax" && !isDepositOffset(l))
      .filter((l) => inWindow(creditMonth.get(l.id) ?? i.issuedOn))
      .reduce((m, l) => m + lineCents(l), 0), 0)
    + feeRows.filter((f) => inWindow(f.postedOn)).reduce((n, f) => n + f.amountCents, 0)
    - feeRows.filter((f) => f.waived && inWindow(f.waivedOn || f.postedOn)).reduce((n, f) => n + f.amountCents, 0);
  fig("revenue", "Revenue this month", revenueLegacy, flow.revenueCents,
    "Legacy: uncovered non-tax lines of invoices issued in the month (credit memos in the month they were resolved), plus fees posted, less fees waived. Ledger: the revenue accounts.");

  // Collected this month: /money "Paid this period" = payments by received_on.
  fig("collected", "Collected this month",
    payRows.filter((p) => inWindow(p.receivedOn)).reduce((n, p) => n + p.amountCents, 0),
    await sumCollected(tenant, from, to),
    "Legacy: payments received in the month. Ledger: receivable credits from payments in the month.");

  // Overhead this month: company-paid overhead rows (lib/financeData.overheadExpense, company-paid), bills included.
  const exp = await db.select().from(expenses).where(ownedBy(expenses.tenantOrgId, tenant, fallback));
  const reportsHere = await db.select().from(expenseReports).where(ownedBy(expenseReports.tenantOrgId, tenant, fallback));
  const onClientClaim = new Set(reportsHere.filter((r) => r.orgId !== null).map((r) => r.id));
  const overheadLegacy = exp.filter((e) => e.workOrderId === null && !(e.reportId !== null && onClientClaim.has(e.reportId))
    && (companyPaid(e) || e.billId !== null) && inWindow(e.incurredOn)).reduce((n, e) => n + e.amountCents, 0);
  fig("overhead", "Overhead this month", overheadLegacy, flow.cost.overhead,
    "Legacy: company-paid overhead rows incurred in the month (the rows lib/cash subtracts), bill cycles included. Ledger: the overhead account. "
    + "A row somebody is owed for is not here on either side - it posts when their claim is paid.");

  // Field expenses this month: claims paid in the month + company-paid job expenses incurred in it.
  const paidReports = reportsHere.filter((r) => r.status === "paid" && inWindow(r.paidOn));
  const paidIds = new Set(paidReports.map((r) => r.id));
  const reimbursed = exp.filter((e) => e.reportId !== null && paidIds.has(e.reportId)).reduce((n, e) => n + e.amountCents, 0);
  const jobPaid = exp.filter((e) => e.workOrderId !== null && companyPaid(e) && inWindow(e.incurredOn)).reduce((n, e) => n + e.amountCents, 0);
  fig("field", "Field expenses this month", reimbursed + jobPaid, flow.cost.cost_field_expenses,
    "Legacy: paidOutFigures.reimbursedCents plus company-paid job expenses. Ledger: field expenses.");

  // Payroll this month: the register's month, counted once the month has ended (lib/cash's rule).
  const payRowsHere = (await db.select().from(payroll).where(eq(payroll.orgId, tenant))) as PayRow[];
  const runs = await db.select().from(payrollRuns).where(eq(payrollRuns.tenantOrgId, tenant));
  const payrollLegacy = monthsBetween(from.slice(0, 7), to.slice(0, 7))
    .filter((ym) => endOfMonth(`${ym}-01`) <= today || runs.some((r) => r.ym === ym))
    .reduce((n, ym) => n + payrollForMonth(payRowsHere, ym).totalCents, 0);
  fig("payroll", "Payroll this month", payrollLegacy, flow.cost.payroll,
    "Legacy: payrollForMonth for months ended in the window. Ledger: payroll runs posted in the window. "
    + "A month run early (before its end) is on the ledger and not yet in the legacy figure until the month ends.");

  // Payable: received PO lines not yet paid, at the agreed price.
  const pos_ = await db.select().from(purchaseOrders).where(ownedBy(purchaseOrders.tenantOrgId, tenant, fallback));
  const poIds = pos_.map((p) => p.id);
  const lines = poIds.length ? await db.select().from(poLines).where(inArray(poLines.poId, poIds)) : [];
  const payableLegacy = pos_.filter((p) => !p.paidOn)
    .reduce((n, p) => n + lines.filter((l) => l.poId === p.id).reduce((m, l) => m + (l.unitCents ?? 0) * l.qtyReceived, 0), 0);
  fig("payable", "Payable", payableLegacy, pos.payable,
    "Legacy: received PO lines on unpaid orders, at the agreed price - a figure no page showed before. Ledger: payable.");

  // Cash: lib/cash rolled forward, versus bank + Stripe.
  const [org] = await db.select().from(orgs).where(eq(orgs.id, tenant));
  if (org?.cashOpeningOn) {
    const o = org.cashOpeningOn;
    const win = (d: string) => d >= o && d <= today;
    const received = payRows.filter((p) => win(p.receivedOn)).reduce((n, p) => n + p.amountCents, 0);
    const paidR = reportsHere.filter((r) => r.status === "paid" && win(r.paidOn));
    const paidRIds = new Set(paidR.map((r) => r.id));
    const reimb = exp.filter((e) => e.reportId !== null && paidRIds.has(e.reportId)).reduce((n, e) => n + e.amountCents, 0);
    const ovh = exp.filter((e) => e.workOrderId === null && !(e.reportId !== null && onClientClaim.has(e.reportId))
      && e.reportId === null && e.person === "" && win(e.incurredOn)).reduce((n, e) => n + e.amountCents, 0);
    const payrollOut = monthsBetween(o.slice(0, 7), today.slice(0, 7))
      .filter((ym) => { const end = endOfMonth(`${ym}-01`); return end >= o && end <= today; })
      .reduce((n, ym) => n + payrollForMonth(payRowsHere, ym).totalCents, 0);
    fig("cash", "Cash on hand", org.cashOpeningCents + received - reimb - ovh - payrollOut, pos.bank + pos.stripe,
      "Legacy: lib/cash - opening plus payments, less claims paid, company-paid overhead and month-end payroll. Ledger: bank plus Stripe. "
      + "The ledger also counts company-paid job expenses, purchase orders paid, tax remitted and Stripe fees, which lib/cash never saw.");
  }

  return figures;
}

async function sumRemits(tenant: number): Promise<number> {
  const { sumAccount } = await import("@/lib/ledger/sums");
  return sumAccount("sales_tax_owed", { tenant, refType: "tax", side: "dr" });
}

/** Receivable credits whose other side is cash: payments, not waivers or credits. */
async function sumCollected(tenant: number, from: string, to: string): Promise<number> {
  const { entries } = await import("@/lib/ledger/sums");
  const es = await entries({ tenant, from, to, refType: "invoice", liveOnly: true });
  return es.filter((e) => e.lines.some((l) => (l.account === "bank" || l.account === "stripe") && l.debitCents > 0))
    .reduce((n, e) => n + e.lines.filter((l) => l.account === "receivable").reduce((m, l) => m + l.creditCents, 0), 0);
}

/** Every operator's parity, computed now. */
export async function parityRuns(today: string): Promise<ParityRun[]> {
  const operators = await db.select().from(orgs).where(eq(orgs.isOperator, true));
  const out: ParityRun[] = [];
  for (const org of operators) {
    out.push({ tenantOrgId: org.id, orgName: org.name, today, figures: await parityFor(org.id, today) });
  }
  return out;
}

/** Compute and store, for the view and the cron. Returns what it wrote. */
export async function recordParity(today: string): Promise<ParityRun[]> {
  const runs = await parityRuns(today);
  const at = new Date();
  for (const r of runs) {
    if (!r.figures.length) continue;
    await db.insert(ledgerParity).values(r.figures.map((f) => ({
      tenantOrgId: r.tenantOrgId, runAt: at, figure: f.key, label: f.label,
      legacyCents: f.legacyCents, ledgerCents: f.ledgerCents, note: f.note,
    })));
  }
  return runs;
}

/** The latest stored run for a workspace, or nothing. */
export async function latestParity(tenant: number): Promise<{ runAt: Date; figures: ParityFigure[] } | null> {
  const [last] = await db.select({ at: sql<string>`max(${ledgerParity.runAt})` }).from(ledgerParity)
    .where(eq(ledgerParity.tenantOrgId, tenant));
  if (!last?.at) return null;
  const runAt = new Date(last.at);
  const rows = await db.select().from(ledgerParity)
    .where(and(eq(ledgerParity.tenantOrgId, tenant), gte(ledgerParity.runAt, runAt), lte(ledgerParity.runAt, runAt)));
  return {
    runAt,
    figures: rows.map((r) => ({
      key: r.figure, label: r.label, legacyCents: r.legacyCents, ledgerCents: r.ledgerCents,
      diffCents: r.ledgerCents - r.legacyCents, note: r.note,
    })),
  };
}
