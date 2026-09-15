// Every figure the financial section shows, loaded once per request.
//
// The rail badges, the Home page, the six stages, the payables queue, the
// decision list and the digest's money section are the same rows seen at
// different distances, so they come from one loader. Every DOLLAR here is a
// sum over the journal (lib/ledger); what is not a dollar - a quote's
// promise, a closed job's unbilled worth, a bill's next cycle - is read from
// its own rows and the copy says so.
//
// Request-cached: a page and the rail beside it ask once.

import { cache } from "react";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  agreements, bankTransactions, bills, expenseReports, expenses, orgs, payroll, payrollRuns, paymentSuggestions,
  poLines, purchaseOrders, quotes, shareLinks, workOrders,
} from "@/db/schema";
import { forTenant } from "@/lib/tenancy";
import {
  allInvoices, allQuotes, asStatementRow, creditForMany, quoteTotal, unbilledJobs, type FullInvoice,
} from "@/lib/invoiceData";
import { invoiceView, isOpen, type InvoiceView } from "@/lib/statement";
import { daysToExpiry, quoteStanding, stale } from "@/lib/quotes";
import { billCyclesBetween, billLive, dueBillCycles, endOfMonth } from "@/lib/bills";
import { poTotals } from "@/lib/po";
import { payrollForMonth, type PayRow } from "@/lib/payroll";
import { periodEnd, periodStart, plusDays, daysBetween, type Period, type FinanceAmounts, type FinanceLabels, type FinanceTones } from "@/lib/finance";
import { BURN_MONTHS, PO_TERMS_DAYS } from "@/lib/money/constants";
import { decisionsFrom, type Decision, type DecisionSources } from "@/lib/money/decisions";
import {
  balancesByRef, entries, periodFlow, positions, accountSums,
  type LedgerEntry, type PeriodFlow, type Positions,
} from "@/lib/ledger/sums";
import { isDepositOffset } from "@/lib/ledger/postings";

export type Stage = { cents: number; n: number };

export type InvoiceLine_ = { orgName: string; view: InvoiceView; f: FullInvoice; balanceCents: number; dueOn: string };

export type MoneyFigures = {
  today: string;
  period: Period;
  from: string;
  to: string;
  positions: Positions;
  cashCents: number;
  runway: { burnCents: number; months: number | null };
  unreconciled: { unmatched: number; unmatchedCents: number; inTransit: number; hasFeed: boolean };
  flow: PeriodFlow;
  collected: Stage;
  stages: { quoted: Stage; awarded: Stage; unbilled: Stage; current: Stage; pastDue: Stage; paid: Stage };
  owes: { vendorsCents: number; reimbDueCents: number; taxCents: number; totalCents: number };
  onOrderCents: number;
  committedCents: number;
  holds: number;
  decisions: Decision[];
  sources: DecisionSources;
  amounts: FinanceAmounts;
  labels: FinanceLabels;
  tones: FinanceTones;
  /** Rows for the Receivables room, one per document, stage-tagged. */
  receivables: ReceivableRow[];
  /** Rows for the Payables room, one per thing that will leave, by date. */
  payables: PayableRow[];
  orgName: Map<number, string>;
};

export type ReceivableRow = {
  stage: "quoted" | "awarded" | "unbilled" | "current" | "pastdue" | "paid";
  status: string;
  orgId: number;
  orgName: string;
  doc: string;
  href: string;
  title: string;
  meta: string;
  cents: number;
  tone?: "warn" | "bad" | "good";
  sort: string;
  invoiceId?: number;
  quoteId?: number;
  workOrderId?: number;
  draft?: boolean;
  disputed?: boolean;
  pastDue?: boolean;
};

export type PayableRow = {
  when: string;
  payee: string;
  kind: string;
  doc: string;
  href?: string;
  title: string;
  cents: number;
  status: "due" | "owed" | "to approve" | "on order" | "scheduled" | "accruing";
  action?: { kind: "pay-po"; id: number } | { kind: "run-payroll"; ym: string } | { kind: "remit-tax" } | { kind: "link"; href: string; label: string };
  /** Only for a reader who may read the register. */
  payroll?: boolean;
};

const lineCents = (l: { qty: number; unitCents: number; covered: boolean }) =>
  l.covered ? 0 : Math.round((l.qty / 1000) * l.unitCents);

/** Collections in a window: invoice entries whose other side is cash. */
export async function collectedIn(tenant: number | null, from: string, to: string): Promise<{ cents: number; n: number; entries: LedgerEntry[] }> {
  const es = (await entries({ tenant, from, to, refType: "invoice", liveOnly: true }))
    .filter((e) => e.lines.some((l) => (l.account === "bank" || l.account === "stripe") && l.debitCents > 0));
  return {
    cents: es.reduce((n, e) => n + e.lines.filter((l) => l.account === "receivable").reduce((m, l) => m + l.creditCents, 0), 0),
    n: es.length, entries: es,
  };
}

export const moneyFigures = cache(async (
  tenant: number | null, today: string, period: Period, opts: { seesPayroll: boolean },
): Promise<MoneyFigures> => {
  const from = periodStart(today, period), to = periodEnd(today, period);
  const monthFrom = periodStart(today, "month"), monthTo = periodEnd(today, "month");

  const [
    pos, flow, collected, balances, invRows, quoteRows, unbilled, orgRows, depositQuotes,
    reportRows, billRows, poRows, poLineRows, bankRows, agreementRows, payRows, runs, links, woRows, suggestionRows,
  ] = await Promise.all([
    positions(tenant),
    periodFlow(tenant, from, to),
    collectedIn(tenant, from, to),
    balancesByRef(tenant, "receivable", "invoice"),
    allInvoices(tenant),
    allQuotes(tenant),
    unbilledJobs(tenant, 50),
    db.select({ id: orgs.id, name: orgs.name, kind: orgs.kind }).from(orgs),
    db.select({ id: quotes.id, number: quotes.number, invoiceId: quotes.depositInvoiceId, workOrderId: quotes.workOrderId })
      .from(quotes).where(forTenant(quotes.tenantOrgId, tenant)),
    db.select().from(expenseReports).where(and(forTenant(expenseReports.tenantOrgId, tenant), eq(expenseReports.status, "submitted"))),
    db.select().from(bills).where(forTenant(bills.tenantOrgId, tenant)),
    db.select().from(purchaseOrders).where(and(forTenant(purchaseOrders.tenantOrgId, tenant), inArray(purchaseOrders.status, ["sent", "partial", "received"]))),
    db.select().from(poLines),
    db.select().from(bankTransactions).where(forTenant(bankTransactions.tenantOrgId, tenant)),
    db.select().from(agreements).where(and(forTenant(agreements.tenantOrgId, tenant), eq(agreements.status, "active"))),
    opts.seesPayroll && tenant !== null
      ? db.select().from(payroll).where(eq(payroll.orgId, tenant)).then((r) => r as PayRow[])
      : Promise.resolve([] as PayRow[]),
    db.select().from(payrollRuns).where(forTenant(payrollRuns.tenantOrgId, tenant)),
    db.select({ quoteId: shareLinks.quoteId, openCount: shareLinks.openCount }).from(shareLinks)
      .where(and(forTenant(shareLinks.tenantOrgId, tenant), isNull(shareLinks.revokedAt))),
    db.select({ id: workOrders.id, number: workOrders.number, title: workOrders.title, state: workOrders.state, orgId: workOrders.orgId })
      .from(workOrders).where(forTenant(workOrders.tenantOrgId, tenant)),
    db.select().from(paymentSuggestions)
      .where(and(forTenant(paymentSuggestions.tenantOrgId, tenant), eq(paymentSuggestions.status, "open"))),
  ]);

  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));
  const name = (id: number | null) => (id === null ? "" : orgName.get(id) ?? "");
  const depositInvoiceIds = new Set(depositQuotes.map((q) => q.invoiceId).filter((x): x is number => x !== null));

  // ── Invoices: balance from the journal, standing from the row ─────────
  const invoices = invRows.map((f) => {
    const view = invoiceView(asStatementRow(f), today);
    // The journal's balance for a sent invoice; the row's own arithmetic for
    // one the journal has not seen (a draft, or history not yet backfilled -
    // the parity view names those).
    const posted = balances.get(String(f.row.id));
    const balanceCents = posted ?? view.balanceCents;
    return { f, view, balanceCents, orgName: name(f.row.orgId), dueOn: f.row.dueOn };
  });
  const open = invoices.filter((i) => isOpen(i.view) && i.balanceCents > 0);
  const late = open.filter((i) => i.view.daysLate > 0);
  const current = open.filter((i) => i.view.daysLate <= 0);
  const drafts = invoices.filter((i) => i.f.row.status === "draft");
  const sumBal = (xs: typeof open) => xs.reduce((n, i) => n + i.balanceCents, 0);

  // ── Quotes and jobs: the pipeline's promise, not its record ──────────
  const awaiting = quoteRows.filter((q) => quoteStanding(q.row, today) === "awaiting");
  const quoted = awaiting.reduce((n, q) => n + quoteTotal(q), 0);
  const woById = new Map(woRows.map((w) => [w.id, w]));
  const invoicedWo = new Set(invRows.filter((f) => f.row.workOrderId !== null && f.row.status !== "void" && !depositInvoiceIds.has(f.row.id)).map((f) => f.row.workOrderId as number));
  const awarded = quoteRows
    .filter((q) => q.row.status === "approved" && q.row.workOrderId !== null)
    .map((q) => ({ q, wo: woById.get(q.row.workOrderId as number) }))
    .filter(({ wo, q }) => wo && wo.state !== "closed" && wo.state !== "cancelled" && !invoicedWo.has(q.row.workOrderId as number))
    .map(({ q, wo }) => {
      const dep = invoices.find((i) => i.f.row.id === q.row.depositInvoiceId);
      const depositCents = dep ? dep.f.lines.reduce((n, l) => n + lineCents(l), 0) : 0;
      return { q, wo: wo!, cents: Math.max(0, quoteTotal(q) - depositCents), depositCents };
    });
  const unbilledCents = unbilled.reduce((n, j) => n + j.valueCents, 0) + drafts.reduce((n, d) => n + d.view.linesCents, 0);

  // ── Money out ─────────────────────────────────────────────────────────
  const linesByPo = new Map<number, typeof poLineRows>();
  for (const l of poLineRows) (linesByPo.get(l.poId) ?? linesByPo.set(l.poId, []).get(l.poId)!).push(l);
  const receivedUnpaid = poRows.filter((p) => !p.paidOn && p.status !== "sent");
  const onOrder = poRows.filter((p) => p.status === "sent" || p.status === "partial");
  const onOrderCents = onOrder.reduce((n, p) => n + (linesByPo.get(p.id) ?? [])
    .reduce((m, l) => m + (l.unitCents ?? 0) * Math.max(0, l.qtyOrdered - l.qtyReceived), 0), 0);
  const reportIds = new Set(reportRows.map((r) => r.id));
  const reportCents = reportIds.size
    ? await db.select({ reportId: expenses.reportId, amountCents: expenses.amountCents }).from(expenses)
        .where(inArray(expenses.reportId, [...reportIds]))
    : [];
  const reportTotal = (id: number) => reportCents.filter((e) => e.reportId === id).reduce((n, e) => n + e.amountCents, 0);
  const reimbDue = reportRows.reduce((n, r) => n + reportTotal(r.id), 0);

  const thisYm = today.slice(0, 7);
  const payrollGross = payRows.length ? payrollForMonth(payRows, thisYm).totalCents : 0;
  const payrollRun = runs.find((r) => r.ym === thisYm);
  const payrollDue = opts.seesPayroll && payrollGross > 0 && !payrollRun
    ? { ym: thisYm, grossCents: payrollGross, runOn: endOfMonth(`${thisYm}-01`), people: payrollForMonth(payRows, thisYm).people.length }
    : null;

  // ── Cash, reconciliation, runway ──────────────────────────────────────
  const hasFeed = bankRows.length > 0;
  const unmatchedRows = bankRows.filter((b) => b.matchedEntryId === null);
  const matchedIds = new Set(bankRows.map((b) => b.matchedEntryId).filter((x): x is number => x !== null));
  const inTransit = hasFeed
    ? (await entries({ tenant, account: "bank", liveOnly: true })).filter((e) => e.refType !== "opening" && !matchedIds.has(e.id)).length
    : 0;
  const burnFrom = periodStart(plusDays(monthFrom, -1), "month");   // the start of last month
  const burnTo = plusDays(monthFrom, -1);                            // the end of last month
  const burnStart = (() => { let d = burnFrom; for (let i = 1; i < BURN_MONTHS; i++) d = periodStart(plusDays(d, -1), "month"); return d; })();
  const burnSums = await accountSums({ tenant, from: burnStart, to: burnTo });
  const burnCents = Math.round(burnSums.filter((s) => ["overhead", "payroll", "cost_field_expenses"].includes(s.account))
    .reduce((n, s) => n + s.balanceCents, 0) / BURN_MONTHS);
  const cashCents = pos.bank + pos.stripe;

  // ── Holds ─────────────────────────────────────────────────────────────
  const holdOrgIds = [...new Set(open.map((i) => i.f.row.orgId))];
  const standings = await creditForMany(holdOrgIds, today);
  const holds = [...standings.entries()].filter(([, s]) => s.onHold)
    .map(([id, s]) => ({ orgId: id, orgName: name(id), worstDays: s.oldestDaysLate, owedCents: s.balanceCents }));

  // ── Decisions and the digest, from one set of sources ────────────────
  const days = (from: string) => daysBetween(from, today);
  const sources: DecisionSources = {
    today,
    drafts: drafts.map((d) => ({ id: d.f.row.id, number: d.f.row.number, orgName: d.orgName, totalCents: d.view.linesCents, workOrderId: d.f.row.workOrderId })),
    overdue: late.map((i) => ({
      id: i.f.row.id, number: i.f.row.number, orgName: i.orgName, daysLate: i.view.daysLate, balanceCents: i.balanceCents,
      promiseBroken: i.f.promises.some((p) => !p.keptOn && p.promisedOn && p.promisedOn < today),
      disputed: i.f.disputes.some((d) => d.resolvedOn === null),
    })),
    unbilled: unbilled.map((j) => ({ woId: j.woId, number: j.number, orgName: j.orgName, title: j.title, daysClosed: j.daysClosed, valueCents: j.valueCents })),
    reports: reportRows.map((r) => ({ id: r.id, person: r.person, title: r.title, status: r.status, cents: reportTotal(r.id), submittedOn: r.submittedAt.toISOString().slice(0, 10) })),
    billsDue: billRows.filter(billLive).flatMap((b) => {
      const dueNow = dueBillCycles(b, today);                      // due and not yet posted
      const ahead = billCyclesBetween(b, plusDays(today, 1), monthTo);
      return [...dueNow, ...ahead].map((on) => ({ id: b.id, payee: b.payee || b.name, kind: b.kind, cents: b.amountCents, on, portalUrl: b.portalUrl }));
    }),
    posReceived: receivedUnpaid.map((p) => ({
      id: p.id, number: p.number, vendor: p.vendor,
      title: (linesByPo.get(p.id) ?? []).map((l) => l.name || l.partNumber).slice(0, 2).join(", "),
      cents: (linesByPo.get(p.id) ?? []).reduce((n, l) => n + (l.unitCents ?? 0) * l.qtyReceived, 0),
      receivedOn: (p.closedAt ?? p.sentAt ?? p.createdAt).toISOString().slice(0, 10),
    })).filter((p) => p.cents > 0),
    unmatchedBank: { count: unmatchedRows.length, cents: unmatchedRows.reduce((n, b) => n + Math.abs(b.amountCents), 0) },
    stripeCents: pos.stripe,
    stripeSuggestions: suggestionRows.map((p) => ({
      id: p.id, description: p.description, cents: p.amountCents, invoiceId: p.invoiceId,
      invoiceNumber: invRows.find((f) => f.row.id === p.invoiceId)?.row.number ?? "",
    })),
    installments: agreementRows.filter((a) => a.billNextOn && a.billAmountCents > 0)
      .map((a) => ({ agreementId: a.id, orgName: name(a.orgId), title: a.title || a.number, cents: a.billAmountCents, on: a.billNextOn })),
    holds,
    payroll: payrollDue,
    staleQuotes: stale(quoteRows.map((q) => q.row), today).map((row) => {
      const f = quoteRows.find((x) => x.row.id === row.id)!;
      return {
        id: row.id, number: row.number, orgName: name(row.orgId),
        daysUnanswered: days(row.sentOn || today), totalCents: quoteTotal(f),
        daysLeft: daysToExpiry(row.expiresOn, today) ?? 0,
        views: links.find((l) => l.quoteId === row.id)?.openCount ?? 0,
      };
    }),
    brokenPromises: late.flatMap((i) => i.f.promises.filter((p) => !p.keptOn && p.promisedOn && p.promisedOn < today).map((p) => ({
      number: i.f.row.number, orgName: i.orgName, byName: p.byName, promisedOn: p.promisedOn, daysPast: days(p.promisedOn), payableCents: i.view.payableCents,
    }))),
    openDisputes: open.flatMap((i) => i.f.disputes.filter((d) => d.resolvedOn === null).map((d) => ({
      number: i.f.row.number, orgName: i.orgName, reason: d.reason, daysOpen: days(d.openedOn), disputedCents: i.view.disputedCents, restCents: i.view.payableCents,
    }))),
  };

  // ── Receivables rows ──────────────────────────────────────────────────
  const rows: ReceivableRow[] = [];
  for (const q of awaiting) {
    rows.push({
      stage: "quoted", status: "sent", orgId: q.row.orgId, orgName: name(q.row.orgId), doc: q.row.number,
      href: `/money/quotes/${q.row.id}`, title: q.row.title,
      meta: `sent ${q.row.sentOn} · expires ${q.row.expiresOn}${q.row.depositPct ? ` · ${q.row.depositPct}% deposit on approval` : ""}`,
      cents: quoteTotal(q), sort: q.row.expiresOn || "z", quoteId: q.row.id,
    });
  }
  for (const a of awarded) {
    rows.push({
      stage: "awarded", status: "in work", orgId: a.q.row.orgId, orgName: name(a.q.row.orgId), doc: a.wo.number,
      href: `/work/${a.wo.id}`, title: a.wo.title,
      meta: `from ${a.q.row.number}${a.depositCents ? ` · ${(a.depositCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} deposit held, applies on invoice` : ""}`,
      cents: a.cents, sort: "z", workOrderId: a.wo.id,
    });
  }
  for (const j of unbilled) {
    rows.push({
      stage: "unbilled", status: "closed", orgId: j.orgId ?? 0, orgName: j.orgName, doc: j.number,
      href: `/work/${j.woId}`, title: j.title,
      meta: `closed ${j.closedOn} · ${j.daysClosed} day${j.daysClosed === 1 ? "" : "s"} unbilled${j.coveredBy ? ` · ${j.allCovered ? "covered by" : "partly covered by"} ${j.coveredBy}` : ""}`,
      cents: j.valueCents, tone: "warn", sort: j.closedOn, workOrderId: j.woId,
    });
  }
  for (const d of drafts) {
    rows.push({
      stage: "unbilled", status: "draft", orgId: d.f.row.orgId, orgName: d.orgName, doc: d.f.row.number,
      href: `/money/invoices/${d.f.row.id}`, title: d.f.row.title || d.f.row.note,
      meta: "draft · nothing posted until sent", cents: d.view.linesCents, tone: "warn", sort: "0", invoiceId: d.f.row.id, draft: true,
    });
  }
  for (const i of open) {
    const past = i.view.daysLate > 0;
    const daysToDue = i.dueOn ? daysBetween(today, i.dueOn) : 0;
    rows.push({
      stage: past ? "pastdue" : "current", status: i.f.row.status, orgId: i.f.row.orgId, orgName: i.orgName, doc: i.f.row.number,
      href: `/money/invoices/${i.f.row.id}`, title: i.f.row.title || i.f.row.note,
      meta: past
        ? `${i.view.daysLate} days past due · ${i.f.dunning.length} rung${i.f.dunning.length === 1 ? "" : "s"} sent${i.f.disputes.some((d) => d.resolvedOn === null) ? " · dispute open" : ""}${i.f.promises.some((p) => !p.keptOn) ? ` · promised ${i.f.promises.filter((p) => !p.keptOn).at(-1)?.promisedOn}` : ""}`
        : `due ${i.dueOn} · ${daysToDue} day${daysToDue === 1 ? "" : "s"}${i.f.row.status === "partial" ? " · partly paid" : ""}`,
      cents: i.balanceCents, tone: past ? "bad" : undefined, sort: i.dueOn || "z", invoiceId: i.f.row.id,
      disputed: i.f.disputes.some((d) => d.resolvedOn === null), pastDue: past,
    });
  }
  for (const e of collected.entries) {
    const inv = invoices.find((i) => String(i.f.row.id) === e.refId);
    if (!inv) continue;
    rows.push({
      stage: "paid", status: "paid", orgId: inv.f.row.orgId, orgName: inv.orgName, doc: inv.f.row.number,
      href: `/money/invoices/${inv.f.row.id}`, title: inv.f.row.title || inv.f.row.note,
      meta: `paid ${e.postedOn}${inv.balanceCents > 0 ? " · part" : ""}`,
      cents: e.lines.filter((l) => l.account === "receivable").reduce((n, l) => n + l.creditCents, 0),
      tone: "good", sort: e.postedOn, invoiceId: inv.f.row.id,
    });
  }
  const order: Record<ReceivableRow["stage"], number> = { pastdue: 0, unbilled: 1, current: 2, awarded: 3, quoted: 4, paid: 5 };
  rows.sort((a, b) => order[a.stage] - order[b.stage] || a.sort.localeCompare(b.sort));

  // ── Payables rows ─────────────────────────────────────────────────────
  const pay: PayableRow[] = [];
  for (const b of sources.billsDue) {
    pay.push({ when: b.on, payee: b.payee, kind: `Bill · ${b.kind}`, doc: `B-${b.id}`, title: "posts to overhead on its day", cents: b.cents, status: "due",
      action: b.portalUrl ? { kind: "link", href: b.portalUrl, label: "Pay" } : undefined });
  }
  for (const p of sources.posReceived) {
    pay.push({ when: plusDays(p.receivedOn, PO_TERMS_DAYS), payee: p.vendor, kind: "Purchase order", doc: p.number, href: `/money/purchasing/${p.id}`,
      title: `${p.title} · received ${p.receivedOn}`, cents: p.cents, status: "owed", action: { kind: "pay-po", id: p.id } });
  }
  for (const p of onOrder) {
    const cents = (linesByPo.get(p.id) ?? []).reduce((n, l) => n + (l.unitCents ?? 0) * Math.max(0, l.qtyOrdered - l.qtyReceived), 0);
    if (cents <= 0) continue;
    pay.push({ when: "9999-12-31", payee: p.vendor, kind: "Purchase order", doc: p.number, href: `/money/purchasing/${p.id}`,
      title: `on order${p.expectedAt ? ` · expected ${p.expectedAt}` : ""} · not a cost until it arrives`, cents, status: "on order" });
  }
  for (const r of sources.reports) {
    pay.push({ when: r.submittedOn, payee: r.person, kind: "Reimbursement", doc: `EXP-${r.id}`, href: `/money/reimbursements/${r.id}`,
      title: r.title || "expense report", cents: r.cents, status: "to approve", action: { kind: "link", href: `/money/reimbursements/${r.id}`, label: "Pay" } });
  }
  if (pos.salesTaxOwed > 0) {
    const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
    const quarterEnd = `${today.slice(0, 4)}-${String(q * 3 + 3).padStart(2, "0")}-${q === 0 || q === 2 ? "31" : "30"}`;
    pay.push({ when: plusDays(quarterEnd, 30), payee: "The state", kind: "Sales tax", doc: `Q${q + 1} ${today.slice(0, 4)}`,
      title: "collected on parts sold, owed to the state", cents: pos.salesTaxOwed, status: "accruing", action: { kind: "remit-tax" } });
  }
  if (payrollDue) {
    pay.push({ when: payrollDue.runOn, payee: `${payrollDue.people} ${payrollDue.people === 1 ? "person" : "people"}`, kind: "Payroll", doc: thisYm,
      title: "gross, from the register", cents: payrollDue.grossCents, status: "scheduled", action: { kind: "run-payroll", ym: thisYm }, payroll: true });
  }
  pay.sort((a, b) => a.when.localeCompare(b.when));

  const owedNow = pos.payable + reimbDue + pos.salesTaxOwed;
  const committed = onOrderCents + (payrollDue?.grossCents ?? 0);

  return {
    today, period, from, to,
    positions: pos, cashCents,
    runway: { burnCents, months: burnCents > 0 ? Math.round((cashCents / burnCents) * 10) / 10 : null },
    unreconciled: { unmatched: unmatchedRows.length, unmatchedCents: sources.unmatchedBank.cents, inTransit, hasFeed },
    flow, collected: { cents: collected.cents, n: collected.n },
    stages: {
      quoted: { cents: quoted, n: awaiting.length },
      awarded: { cents: awarded.reduce((n, a) => n + a.cents, 0), n: awarded.length },
      unbilled: { cents: unbilledCents, n: unbilled.length + drafts.length },
      current: { cents: sumBal(current), n: current.length },
      pastDue: { cents: sumBal(late), n: late.length },
      paid: { cents: collected.cents, n: collected.n },
    },
    owes: { vendorsCents: pos.payable, reimbDueCents: reimbDue, taxCents: pos.salesTaxOwed, totalCents: owedNow },
    onOrderCents, committedCents: committed,
    holds: holds.length,
    decisions: decisionsFrom(sources),
    sources,
    amounts: { receivables: pos.receivable, payables: owedNow, cash: cashCents },
    labels: holds.length ? { clients: `${holds.length} on hold` } : {},
    tones: { ...(sumBal(late) > 0 ? { receivables: "bad" as const } : {}), ...(holds.length ? { clients: "bad" as const } : {}) },
    receivables: rows,
    payables: pay,
    orgName,
  };
});

/** Which client's rows, for the Clients room: the same loader, narrowed. */
export const exposureByClient = (f: MoneyFigures): { orgId: number; orgName: string; cents: number }[] => {
  const by = new Map<number, { orgId: number; orgName: string; cents: number }>();
  for (const r of f.receivables) {
    if (r.stage === "paid" || r.stage === "quoted" || !r.orgId) continue;
    const o = by.get(r.orgId) ?? { orgId: r.orgId, orgName: r.orgName, cents: 0 };
    o.cents += r.cents;
    by.set(r.orgId, o);
  }
  return [...by.values()].sort((a, b) => b.cents - a.cents);
};

/** Keep the import honest for the deposit rule this loader depends on. */
void isDepositOffset;
void asc;
