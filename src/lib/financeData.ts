import { and, eq, gte, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  agreements, clientAllowlist, expenseReports, expenses, orgs, payments, payroll,
  poLines, purchaseOrders,
} from "@/db/schema";
import { myTenantOrgId, type SessionUser } from "@/lib/authz";
import { forTenant, readTenant } from "@/lib/tenancy";
import { allInvoices, allQuotes, asStatementRow, quoteTotal, unbilledJobs } from "@/lib/invoiceData";
import { invoiceView, isOpen } from "@/lib/statement";
import { quoteStanding } from "@/lib/quotes";
import { poTotals } from "@/lib/po";
import { shopToday } from "@/lib/shopday";
import { formatCents } from "@/lib/money";
import { maySeePayroll, payrollForMonth, type PayRow, type PayrollViewer } from "@/lib/payroll";
import {
  CHASE_DAYS, RENEWAL_DAYS, STALE_QUOTE_DAYS,
  addYear, daysBetween, monthlyContractCents, monthsIn, periodFor, periodStart, rankDecisions,
  type Decision, type FinanceAmounts, type Period,
} from "@/lib/finance";
import type { UnbilledJob } from "@/lib/invoiceData";

/**
 * Every figure the financial section shows, computed once.
 *
 * The rail badges and the overview lanes are the same numbers seen at two
 * distances, so they come from one place. Two functions would eventually
 * disagree by a rounding rule or a filter, and a rail that says $9,800 beside
 * a lane that says $9,200 destroys the credibility of both.
 *
 * Nothing here is read from a stored column: every figure is a sum over rows
 * taken at render, which is why there is no state for this to be stale with.
 */
export type FinanceFigures = {
  /** Cents per rail entry. Keys the viewer may not see are simply absent. */
  amounts: FinanceAmounts;
  moneyIn: {
    quotedCents: number;
    unbilledCents: number;
    unbilledJobs: number;
    currentCents: number;
    pastDueCents: number;
    pastDueCount: number;
    paidCents: number;
  };
  moneyOut: {
    purchasingCents: number;
    openPos: number;
    reimbursementsCents: number;
    reimbursementReports: number;
    /** Null when this reader may not read it - not zero, which would be a lie. */
    overheadCents: number | null;
    payrollCents: number | null;
  };
  contractsMonthlyCents: number;
  /** The soonest contract expiry inside a year, for the decisions list. */
  renewal: { orgName: string; endsOn: string; monthlyCents: number } | null;
  /** Closed jobs nobody has invoiced - the overview is the only place to act. */
  unbilled: UnbilledJob[];
  /** One ranked list across every ledger. */
  decisions: Decision[];
};

/** A contract still running on the given day. */
const contractLive = (a: { status: string; endsOn: string }, today: string): boolean =>
  a.status === "active" && (a.endsOn === "" || a.endsOn >= today);

export async function financeFigures(
  user: SessionUser,
  today: string,
  period: Period,
  opts: { operatorOrgId: number | null },
): Promise<FinanceFigures> {
  const t = readTenant(user);
  const from = periodStart(today, period);

  // Payroll is read only for a reader who may read one, and only for their own
  // company - see lib/payroll. It is fetched conditionally rather than fetched
  // and filtered, so a figure they may not have never enters this process.
  const mine = opts.operatorOrgId;
  const viewer: PayrollViewer = {
    email: user.email, role: user.role, orgId: user.orgId,
    operatorOrgId: mine, canSeePayroll: false,
  };
  const mayReadPay = mine !== null && maySeePayroll(viewer, mine);

  const [invoiceRows, quoteRows, unbilled, paidRows, poRows, poLineRows, reportRows, reportExpenses, overheadRows, contractRows, orgRows, payRows] =
    await Promise.all([
      allInvoices(),
      allQuotes(),
      unbilledJobs(),
      db.select().from(payments)
        .where(and(forTenant(payments.tenantOrgId, t), gte(payments.receivedOn, from))),
      db.select().from(purchaseOrders).where(forTenant(purchaseOrders.tenantOrgId, t)),
      db.select().from(poLines),
      db.select().from(expenseReports)
        .where(and(forTenant(expenseReports.tenantOrgId, t), eq(expenseReports.status, "submitted"))),
      db.select().from(expenses).where(forTenant(expenses.tenantOrgId, t)),
      db.select().from(expenses)
        .where(and(
          isNull(expenses.workOrderId),
          forTenant(expenses.tenantOrgId, t),
          gte(expenses.incurredOn, from),
        )),
      db.select().from(agreements)
        .where(and(forTenant(agreements.tenantOrgId, t), eq(agreements.kind, "contract"))),
      db.select({ id: orgs.id, name: orgs.name }).from(orgs),
      mayReadPay
        ? db.select().from(payroll).where(eq(payroll.orgId, mine as number))
        : Promise.resolve([]),
    ]);

  const views = invoiceRows.map((f) => invoiceView(asStatementRow(f), today));
  const open = views.filter(isOpen);
  const late = open.filter((v) => v.daysLate > 0);

  // Only work that has been priced and not yet answered is money in flight. A
  // draft nobody has sent is not something a client is sitting on.
  const quoted = quoteRows
    .filter((q) => quoteStanding(q.row, today) === "awaiting")
    .reduce((n, q) => n + quoteTotal(q), 0);

  // Committed spend: ordered and not yet in hand. A received order has already
  // become stock, and counting it again would double the same dollar.
  const linesByPo = new Map<number, typeof poLineRows>();
  for (const l of poLineRows) {
    const list = linesByPo.get(l.poId);
    if (list) list.push(l); else linesByPo.set(l.poId, [l]);
  }
  const openPos = poRows.filter((p) => p.status === "sent" || p.status === "partial");
  const purchasingCents = openPos.reduce(
    (n, p) => n + poTotals(linesByPo.get(p.id) ?? []).cents, 0);

  // Claimed and not yet paid out. The pool a person has spent but not claimed
  // is theirs to submit, not the company's to owe.
  const reportIds = new Set(reportRows.map((r) => r.id));
  const reimbursementsCents = reportExpenses
    .filter((e) => e.reportId !== null && reportIds.has(e.reportId))
    .reduce((n, e) => n + e.amountCents, 0);

  const overheadCents = overheadRows.reduce((n, e) => n + e.amountCents, 0);

  const payrollCents = mayReadPay
    ? monthsIn(today, period).reduce(
        (n, ym) => n + payrollForMonth(payRows as PayRow[], ym).totalCents, 0)
    : null;

  const liveContracts = contractRows.filter((a) => contractLive(a, today));
  const contractsMonthlyCents = liveContracts.reduce((n, a) => n + monthlyContractCents(a), 0);

  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));
  const yearOut = addYear(today);
  const soonest = liveContracts
    .filter((a) => a.endsOn !== "" && a.endsOn <= yearOut)
    .sort((a, b) => a.endsOn.localeCompare(b.endsOn))[0];

  const currentCents = open.filter((v) => v.daysLate <= 0).reduce((n, v) => n + v.balanceCents, 0);
  const pastDueCents = late.reduce((n, v) => n + v.balanceCents, 0);

  const renewal = soonest
    ? {
        orgName: orgName.get(soonest.orgId) ?? "a client",
        endsOn: soonest.endsOn,
        monthlyCents: monthlyContractCents(soonest),
      }
    : null;

  // The single worst thing in each ledger, rather than all of them: this list
  // is a call to act, and a list of forty is a list nobody acts on.
  const invoiceOrg = new Map(invoiceRows.map((f) => [f.row.id, f.row.orgId]));
  const worstLate = [...late].sort((a, b) => b.daysLate - a.daysLate)[0];
  const stalest = quoteRows
    .filter((q) => quoteStanding(q.row, today) === "awaiting")
    .sort((a, b) => (a.row.sentOn || today).localeCompare(b.row.sentOn || today))[0];

  return {
    amounts: {
      quotes: quoted,
      invoices: currentCents + pastDueCents,
      collections: pastDueCents,
      contracts: contractsMonthlyCents,
      purchasing: purchasingCents,
      reimbursements: reimbursementsCents,
      overhead: overheadCents,
      // Absent, not zero: the rail drops the entry entirely for this reader.
      ...(payrollCents === null ? {} : { payroll: payrollCents }),
    },
    moneyIn: {
      quotedCents: quoted,
      unbilledCents: unbilled.reduce((n, j) => n + j.valueCents, 0),
      unbilledJobs: unbilled.length,
      currentCents,
      pastDueCents,
      pastDueCount: late.length,
      paidCents: paidRows.reduce((n, p) => n + p.amountCents, 0),
    },
    moneyOut: {
      purchasingCents, openPos: openPos.length,
      reimbursementsCents, reimbursementReports: reportRows.length,
      overheadCents, payrollCents,
    },
    contractsMonthlyCents,
    renewal,
    unbilled,
    decisions: rankDecisions([
      ...(worstLate ? [{
        key: `invoice-${worstLate.id}`,
        tone: (worstLate.daysLate >= CHASE_DAYS ? "bad" : "warn") as Decision["tone"],
        title: `${worstLate.number} is ${worstLate.daysLate} days past terms`,
        detail: `${orgName.get(invoiceOrg.get(worstLate.id) ?? -1) ?? "A client"} · ${formatCents(worstLate.balanceCents)}`
          + (late.length > 1 ? ` · ${late.length - 1} more behind it` : ""),
        href: "/money/collections",
      }] : []),
      ...(stalest ? [{
        key: `quote-${stalest.row.id}`,
        tone: (daysBetween(stalest.row.sentOn || today, today) >= STALE_QUOTE_DAYS ? "bad" : "warn") as Decision["tone"],
        title: `${stalest.row.number} has been unanswered for ${daysBetween(stalest.row.sentOn || today, today)} days`,
        detail: `${orgName.get(stalest.row.orgId) ?? "A client"} · ${formatCents(quoteTotal(stalest))}`,
        href: "/money/quotes",
      }] : []),
      ...(unbilled.length > 0 ? [{
        key: "unbilled",
        tone: "warn" as Decision["tone"],
        title: `${unbilled.length} closed job${unbilled.length === 1 ? " is" : "s are"} not invoiced`,
        detail: `${formatCents(unbilled.reduce((n, j) => n + j.valueCents, 0))} worked and unbilled - the leak`,
        href: "/money",
      }] : []),
      ...(renewal && daysBetween(today, renewal.endsOn) <= RENEWAL_DAYS ? [{
        key: "renewal",
        tone: "warn" as Decision["tone"],
        title: `The ${renewal.orgName} contract ends ${renewal.endsOn}`,
        detail: `${formatCents(renewal.monthlyCents)}/mo · ${daysBetween(today, renewal.endsOn)} days to draft terms`,
        href: "/money/contracts",
      }] : []),
      ...(reimbursementsCents > 0 ? [{
        key: "reimbursements",
        tone: "warn" as Decision["tone"],
        title: `${formatCents(reimbursementsCents)} of field spend is waiting on you`,
        detail: `${reportRows.length} report${reportRows.length === 1 ? "" : "s"} submitted and not paid out`,
        href: "/expenses",
      }] : []),
    ]),
  };
}


/**
 * Everything a page in the financial section needs before it renders: the
 * window, who this reader is allowed to be shown, and every figure.
 *
 * One call per page rather than the same six lines copied ten times - and
 * because the permission question in particular must be asked the same way
 * everywhere. A page that computed `seesPayroll` slightly differently from the
 * rail beside it is exactly the leak this section had to be built around.
 */
export async function financeContext(user: SessionUser, periodParam: unknown): Promise<{
  period: Period;
  today: string;
  /** Whether the payroll register is readable by this person, at all. */
  seesPayroll: boolean;
  figures: FinanceFigures;
}> {
  const period = periodFor(periodParam);
  const today = shopToday();
  const mine = myTenantOrgId(user);

  const [allowRow] = user.orgId === null ? [] : await db
    .select({ canSeePayroll: clientAllowlist.canSeePayroll }).from(clientAllowlist)
    .where(eq(clientAllowlist.entry, user.email.trim().toLowerCase()));
  const seesPayroll = mine !== null && maySeePayroll({
    email: user.email, role: user.role, orgId: user.orgId,
    operatorOrgId: mine, canSeePayroll: allowRow?.canSeePayroll ?? false,
  }, mine);

  return {
    period, today, seesPayroll,
    figures: await financeFigures(user, today, period, { operatorOrgId: mine }),
  };
}
