// The database half of lib/billing.
//
// lib/billing is pure and stays that way: it is handed rows and returns lines
// and sums. This is the file that goes and gets the rows - the same split
// lib/agreements and lib/agreementUsage already have, and for the same reason.
// One loader means the draft page, the invoice page, /money, the portal and
// the digest are all reading the same numbers by construction rather than by
// four people remembering to write the same query.
//
// Everything a client can see is fetched THROUGH AN ORG ID that the caller
// proved they are entitled to - never through an id off a URL. See
// invoiceForOrg, which is the only door the share viewer uses.

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/db";
import {
  agreements, appSettings, creditOverrides, disputes, dunningEvents, expenses,
  instruments, invoiceFees, invoiceLines, invoices, orgs, orgSites, partPrices,
  parts, payments, promises, quoteLines, quotes, rateCards, shareLinks, tasks,
  timeEntries, workOrders,
} from "@/db/schema";
import {
  buildInvoiceLines, coverageFor, coveredValue, linesTotal, sellPrice,
  type DraftLine, type ExpenseRow, type PartRow, type TimeRow,
} from "@/lib/billing";
import { resolvePolicy } from "@/lib/billingPolicy";
import { forTenant } from "@/lib/tenancy";
import { bestPrice } from "@/lib/priceBook";
import { resolveRate, type RateCard } from "@/lib/rates";
import { dueDate, invoiceView, isOpen, type InvoiceRow } from "@/lib/statement";
import { CLEAR, creditStanding, type CreditStanding } from "@/lib/credit";
import { nextAction, promiseBroken } from "@/lib/dunning";
import {
  clientMargin, inWindow, jobMargin, type ClientMargin, type JobMargin,
} from "@/lib/costing";
import { pmCosts, type PmCompletion, type PmCostBoard } from "@/lib/pmCosting";
import { isoDay } from "@/lib/partGroups";
import { getSystemLabels } from "@/lib/systemLabel";
import { daysToExpiry, netCents, stale } from "@/lib/quotes";
import type { BillingPolicy } from "@/lib/billingPolicy";
import type { MoneyInput } from "@/lib/digestMoney";
import { shopToday } from "@/lib/shopday";

/** Cached per request: three pages on one render all want the settings row. */
const settingsRow = cache(async () => {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  return row ?? null;
});

export type BillingContext = {
  policy: BillingPolicy;
  loadedLaborCents: number;
};

/** The policy in force for one client, and the two numbers beside it. */
export async function billingContext(orgId: number | null): Promise<BillingContext> {
  const [s, org] = await Promise.all([
    settingsRow(),
    orgId === null ? Promise.resolve(null) : db.select().from(orgs).where(eq(orgs.id, orgId)).then((r) => r[0] ?? null),
  ]);
  return {
    policy: resolvePolicy(s?.billingPolicy ?? null, org?.billingPolicy ?? null),
    loadedLaborCents: s?.loadedLaborCents ?? 0,
  };
}

export type DraftSource = {
  wo: typeof workOrders.$inferSelect;
  org: typeof orgs.$inferSelect | null;
  rate: RateCard;
  context: BillingContext;
  coverage: ReturnType<typeof coverageFor>;
  lines: DraftLine[];
  /** What the parts on this job cost us, for the margin sidebar. */
  partsCostCents: number;
  billedMinutes: number;
  expensesCents: number;
  taxRateBps: number;
  taxLabel: string;
};

/**
 * Everything an invoice for one work order would be, without writing anything.
 *
 * The draft page renders this and the create action re-runs it - deliberately,
 * so that what somebody looked at and what gets written are produced by the
 * same code rather than by a form posting back numbers it was shown.
 */
export async function draftSourceFor(woId: number): Promise<DraftSource | null> {
  const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, woId));
  if (!wo) return null;

  const [partRows, timeRows, expenseRows, agreementRows, org, inst] = await Promise.all([
    db.select().from(parts).where(eq(parts.workOrderId, woId)),
    db.select().from(timeEntries).where(eq(timeEntries.workOrderId, woId)),
    db.select().from(expenses).where(eq(expenses.workOrderId, woId)),
    wo.orgId === null ? Promise.resolve([]) : db.select().from(agreements).where(eq(agreements.orgId, wo.orgId)),
    wo.orgId === null ? Promise.resolve(null) : db.select().from(orgs).where(eq(orgs.id, wo.orgId)).then((r) => r[0] ?? null),
    wo.instrumentId === null ? Promise.resolve(null)
      : db.select().from(instruments).where(eq(instruments.id, wo.instrumentId)).then((r) => r[0] ?? null),
  ]);

  const context = await billingContext(wo.orgId);
  const today = shopToday();

  const coverage = coverageFor({
    agreements: agreementRows.map((a) => ({
      id: a.id, number: a.number, orgId: a.orgId, status: a.status,
      startsOn: a.startsOn, endsOn: a.endsOn, instrumentIds: a.instrumentIds,
      // Somebody else's contract cannot absorb our labour - see coverageFor.
      providerOrgId: a.providerOrgId,
      laborCovered: a.kind === "contract",
      partsCovered: a.kind === "contract" && (a.partsUnlimited || a.partsAllowanceCents > 0),
    })),
    orgId: wo.orgId, instrumentId: wo.instrumentId, today,
  });

  // Both of these are the JOB's workspace, not the instance's. Unscoped, another
  // operator's default rate card can win resolveRate's last clause and another
  // operator's vendor offer can win bestPrice - so a draft invoice quietly bills
  // at somebody else's numbers.
  const [cards, site, book] = await Promise.all([
    db.select().from(rateCards).where(forTenant(rateCards.tenantOrgId, wo.tenantOrgId)),
    inst?.siteId ? db.select().from(orgSites).where(eq(orgSites.id, inst.siteId)).then((r) => r[0] ?? null) : Promise.resolve(null),
    db.select().from(partPrices).where(forTenant(partPrices.tenantOrgId, wo.tenantOrgId)),
  ]);
  const rate = resolveRate(cards, { orgId: wo.orgId, agreementId: coverage.agreementId });

  const partList: PartRow[] = partRows.map((p) => ({
    id: p.id, name: p.name, partNumber: p.partNumber,
    qty: parseInt(p.qty, 10) || 1, costCents: p.costCents,
  }));
  const timeList: TimeRow[] = timeRows.map((t) => ({
    id: t.id, minutes: t.minutes, category: t.category, billable: t.billable,
    person: t.person, date: t.date, note: t.note,
  }));
  const expenseList: ExpenseRow[] = expenseRows.map((e) => ({
    id: e.id, kind: e.kind, description: e.description, amountCents: e.amountCents,
    billable: e.billable,
  }));

  // The price book prices a part when it knows it; otherwise the landed cost
  // plus the markup. Never a bare cost - selling at cost is not a decision
  // anybody makes on purpose, so it must not be what happens by accident.
  const markup = context.policy.partsMarkupBps;
  const priceOf = (p: PartRow): number => {
    const listed = p.partNumber ? bestPrice(book, p.partNumber) : null;
    return listed ? sellPrice(listed.priceCents, markup) : sellPrice(p.costCents, markup);
  };

  const taxRateBps = context.policy.taxParts ? (site?.taxRateBps ?? 0) : 0;
  const taxLabel = site && taxRateBps > 0
    ? `Sales tax, parts only - ${site.name || "site"} ${(taxRateBps / 100).toFixed(2)}%` : "";

  const lines = buildInvoiceLines({
    parts: partList, time: timeList, expenses: expenseList,
    rate, coverage, sellCents: priceOf, taxRateBps, taxLabel,
  });

  return {
    wo, org, rate, context, coverage, lines,
    partsCostCents: partRows.reduce((n, p) => n + (p.costCents ?? 0), 0),
    billedMinutes: timeList.filter((t) => t.billable).reduce((n, t) => n + t.minutes, 0),
    expensesCents: expenseList.reduce((n, e) => n + e.amountCents, 0),
    taxRateBps, taxLabel,
  };
}

/** An invoice with everything hanging off it, in statement shape. */
export type FullInvoice = {
  row: typeof invoices.$inferSelect;
  lines: (typeof invoiceLines.$inferSelect)[];
  payments: (typeof payments.$inferSelect)[];
  fees: (typeof invoiceFees.$inferSelect)[];
  promises: (typeof promises.$inferSelect)[];
  disputes: (typeof disputes.$inferSelect)[];
  dunning: (typeof dunningEvents.$inferSelect)[];
};

/**
 * What is under dispute right now: the open disputes' own lines, at their line
 * amount. A dispute with no line on it pauses nothing - it is a question about
 * the invoice, not a refusal of a charge - and says so rather than quietly
 * pausing the whole bill.
 */
export function disputedCents(f: FullInvoice): number {
  const open = f.disputes.filter((d) => d.resolvedOn === null && d.lineId !== null);
  return open.reduce((n, d) => {
    const line = f.lines.find((l) => l.id === d.lineId);
    return n + (line && !line.covered ? Math.round(qtyOf(line) * line.unitCents) : 0);
  }, 0);
}

/** Fees that are actually owed - a waived one keeps its row and charges nothing. */
export const liveFees = (f: FullInvoice): number[] =>
  f.fees.filter((x) => !x.waived).map((x) => x.amountCents);

/** qty is stored in thousandths; the arithmetic wants the real number. */
export const qtyOf = (l: { qty: number }): number => l.qty / 1000;

export const asStatementRow = (f: FullInvoice): InvoiceRow => ({
  id: f.row.id, number: f.row.number, orgId: f.row.orgId, status: f.row.status,
  issuedOn: f.row.issuedOn, dueOn: f.row.dueOn,
  lines: f.lines.map((l) => ({ qty: qtyOf(l), unitCents: l.unitCents, covered: l.covered })),
  feeCents: liveFees(f),
  paidCents: f.payments.map((p) => p.amountCents),
  disputedCents: disputedCents(f),
});

async function hydrate(rows: (typeof invoices.$inferSelect)[]): Promise<FullInvoice[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [lineRows, payRows, feeRows, promiseRows, disputeRows, dunningRows] = await Promise.all([
    db.select().from(invoiceLines).where(inArray(invoiceLines.invoiceId, ids)),
    db.select().from(payments).where(inArray(payments.invoiceId, ids)),
    db.select().from(invoiceFees).where(inArray(invoiceFees.invoiceId, ids)),
    db.select().from(promises).where(inArray(promises.invoiceId, ids)),
    db.select().from(disputes).where(inArray(disputes.invoiceId, ids)),
    db.select().from(dunningEvents).where(inArray(dunningEvents.invoiceId, ids)),
  ]);
  return rows.map((row) => ({
    row,
    lines: lineRows.filter((l) => l.invoiceId === row.id).sort((a, b) => a.position - b.position || a.id - b.id),
    payments: payRows.filter((p) => p.invoiceId === row.id).sort((a, b) => a.receivedOn.localeCompare(b.receivedOn)),
    fees: feeRows.filter((x) => x.invoiceId === row.id).sort((a, b) => a.postedOn.localeCompare(b.postedOn)),
    promises: promiseRows.filter((x) => x.invoiceId === row.id).sort((a, b) => a.promisedOn.localeCompare(b.promisedOn)),
    disputes: disputeRows.filter((x) => x.invoiceId === row.id).sort((a, b) => a.id - b.id),
    dunning: dunningRows.filter((x) => x.invoiceId === row.id).sort((a, b) => a.sentOn.localeCompare(b.sentOn)),
  }));
}

/** Every invoice in the workspace, newest first. Internal surfaces only. */
/* Request-cached: the financial section computes its rail badges from the same
   rows the page under it is already reading, and React's cache dedupes the two
   within one render rather than running the query twice. */
export const allInvoices = cache(async (tenantOrgId: number | null): Promise<FullInvoice[]> => {
  const rows = await db.select().from(invoices).where(forTenant(invoices.tenantOrgId, tenantOrgId));
  return (await hydrate(rows)).sort((a, b) => b.row.id - a.row.id);
});

/** One invoice by id, for a staff surface that has already been authz-checked. */
export async function invoiceById(id: number): Promise<FullInvoice | null> {
  const rows = await db.select().from(invoices).where(eq(invoices.id, id));
  return (await hydrate(rows))[0] ?? null;
}

/**
 * One invoice, for a client.
 *
 * The org id is the authorization, and it is applied IN THE QUERY. A viewer
 * holding org 2's token asking for org 1's invoice gets null here, not a
 * redaction decision made further up where somebody could forget to make it.
 */
export async function invoiceForOrg(id: number, orgId: number): Promise<FullInvoice | null> {
  const rows = await db.select().from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.orgId, orgId)));
  return (await hydrate(rows))[0] ?? null;
}

/**
 * Every invoice belonging to one client. The same door, for the statement.
 *
 * cache()d because hydrate() is seven queries and a client's own page asks
 * this twice - once for what is waiting on them, once for the account figures -
 * and they are the same rows both times.
 */
export const invoicesForOrg = cache(async (orgId: number): Promise<FullInvoice[]> => {
  const rows = await db.select().from(invoices).where(eq(invoices.orgId, orgId));
  return (await hydrate(rows)).sort((a, b) => b.row.id - a.row.id);
});

/** The due date this client's terms give an invoice issued today. */
/**
 * The deposits already raised against a job, for its final invoice.
 *
 * A quote approved with a deposit raises its own invoice carrying the job's
 * id. That invoice is half the money arriving early, not THE job's invoice -
 * so the final bill must skip it when checking "is this job already billed"
 * and subtract what it BILLED (not what has been paid: the two invoices must
 * sum to the job's total whatever the payment timing, or a slow payer gets
 * billed 150%). A voided deposit invoice offsets nothing and blocks nothing.
 */
export async function depositOffsetsFor(workOrderId: number): Promise<{
  depositInvoiceIds: Set<number>;
  offsets: { number: string; quoteNumber: string; cents: number }[];
}> {
  const quotesHere = await db.select().from(quotes)
    .where(and(eq(quotes.workOrderId, workOrderId), eq(quotes.status, "approved")));
  const depositInvoiceIds = new Set(
    quotesHere.map((q) => q.depositInvoiceId).filter((x): x is number => x !== null));
  const offsets: { number: string; quoteNumber: string; cents: number }[] = [];
  for (const q of quotesHere) {
    if (q.depositInvoiceId === null) continue;
    const [dep] = await db.select().from(invoices).where(eq(invoices.id, q.depositInvoiceId));
    if (!dep || dep.status === "void") continue;
    const depLines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, dep.id));
    const cents = depLines.reduce((n, l) => n + Math.round((l.qty / 1000) * l.unitCents), 0);
    if (cents > 0) offsets.push({ number: dep.number, quoteNumber: q.number, cents });
  }
  return { depositInvoiceIds, offsets };
}

export const dueFor = (org: { termsDays: number } | null, issuedOn: string): string =>
  dueDate(issuedOn, org?.termsDays ?? 30);

export type UnbilledJob = {
  woId: number;
  number: string;
  title: string;
  orgId: number | null;
  orgName: string;
  closedOn: string;
  daysClosed: number;
  /** What an invoice for it would come to, priced now. */
  valueCents: number;
  coveredBy: string;
  /** True when the whole job is covered - the $0 invoice that still documents it. */
  allCovered: boolean;
};

/**
 * Closed work that has not been billed - the leak.
 *
 * Priced by actually composing each draft rather than by a stored estimate,
 * which is slower and is the point: the number on this list is the number the
 * draft page will show, because it came from the same function.
 */
export const unbilledJobs = cache(async (tenantOrgId: number | null, limit = 25): Promise<UnbilledJob[]> => {
  const closed = await db.select().from(workOrders)
    .where(and(eq(workOrders.state, "closed"), forTenant(workOrders.tenantOrgId, tenantOrgId)));
  const billed = new Set(
    (await db.select({ woId: invoices.workOrderId, status: invoices.status }).from(invoices)
      .where(forTenant(invoices.tenantOrgId, tenantOrgId)))
      .filter((r) => r.status !== "void" && r.woId !== null)
      .map((r) => r.woId as number),
  );
  const candidates = closed
    .filter((w) => !billed.has(w.id) && w.orgId !== null)
    .sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0))
    .slice(0, limit);
  if (!candidates.length) return [];

  const orgRows = await db.select({ id: orgs.id, name: orgs.name }).from(orgs);
  const name = new Map(orgRows.map((o) => [o.id, o.name]));
  const today = shopToday();

  const out: UnbilledJob[] = [];
  for (const w of candidates) {
    const src = await draftSourceFor(w.id);
    if (!src) continue;
    const value = linesTotal(src.lines);
    const closedOn = w.closedAt ? w.closedAt.toISOString().slice(0, 10) : "";
    out.push({
      woId: w.id, number: w.number, title: w.title, orgId: w.orgId,
      orgName: name.get(w.orgId ?? -1) ?? "",
      closedOn,
      daysClosed: closedOn ? Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${closedOn}T00:00:00Z`)) / 86400000)) : 0,
      valueCents: value,
      coveredBy: src.coverage.agreementNumber,
      allCovered: value === 0 && coveredValue(src.lines) > 0,
    });
  }
  return out;
});

/**
 * Where one client stands on credit, computed from their open invoices.
 *
 * Three places ask this - the work order page, the dispatch list, and the
 * action that opens a job - and they must not be able to disagree, so all
 * three come through here. lib/credit does the deciding; this only fetches.
 */
export async function creditFor(orgId: number | null, today: string): Promise<CreditStanding> {
  if (orgId === null) return CLEAR;
  const [full, ctx, overrideRows] = await Promise.all([
    invoicesForOrg(orgId),
    billingContext(orgId),
    db.select().from(creditOverrides).where(eq(creditOverrides.orgId, orgId)),
  ]);
  const open = full
    .map((f) => invoiceView(asStatementRow(f), today))
    .filter(isOpen);
  return creditStanding({
    policy: ctx.policy,
    openInvoices: open.map((v) => ({ balanceCents: v.balanceCents, daysLate: v.daysLate })),
    overrides: overrideRows.map((r) => ({
      reason: r.reason, grantedBy: r.grantedBy, untilOn: r.untilOn, lifted: r.liftedAt !== null,
    })),
    today,
  });
}

/** Credit standing for several clients at once, for a list page. */
export async function creditForMany(orgIds: number[], today: string): Promise<Map<number, CreditStanding>> {
  const ids = [...new Set(orgIds.filter((n) => Number.isInteger(n)))];
  const out = new Map<number, CreditStanding>();
  await Promise.all(ids.map(async (id) => out.set(id, await creditFor(id, today))));
  return out;
}

/** Every open invoice in the workspace that has a rung due today. */
export async function collectionsBoard(today: string, tenantOrgId: number | null): Promise<{
  invoice: FullInvoice;
  view: ReturnType<typeof invoiceView>;
  step: ReturnType<typeof nextAction>;
  policy: BillingPolicy;
  brokenPromise: boolean;
}[]> {
  const all = await allInvoices(tenantOrgId);
  const out = [];
  for (const f of all) {
    const view = invoiceView(asStatementRow(f), today);
    if (!isOpen(view)) continue;
    const { policy } = await billingContext(f.row.orgId);
    const brokenPromise = f.promises.some((p) => promiseBroken(
      { promisedOn: p.promisedOn, byName: p.byName, keptOn: p.keptOn }, today,
    ));
    const step = nextAction({
      dueOn: f.row.dueOn, today, policy,
      log: f.dunning.map((d) => ({ rung: d.rung, sentOn: d.sentOn })),
      promiseBroken: brokenPromise,
    });
    out.push({ invoice: f, view, step, policy, brokenPromise });
  }
  return out;
}

/**
 * The internal digest's money section, gathered.
 *
 * Internal only, and the function says so where somebody would look: there is
 * no per-org variant of this, because a client sees their own money through
 * their own portal token and nowhere else.
 */
export async function moneyDigest(today: string, tenantOrgId: number | null): Promise<MoneyInput> {
  const [board, jobs, orgRows] = await Promise.all([
    collectionsBoard(today, tenantOrgId),
    unbilledJobs(tenantOrgId, 12),
    db.select({ id: orgs.id, name: orgs.name }).from(orgs),
  ]);
  const name = (id: number) => orgRows.find((o) => o.id === id)?.name ?? "";
  const days = (from: string) => Math.max(0, Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000,
  ));

  const brokenPromises = [];
  const openDisputes = [];
  const overdue = [];
  for (const { invoice: f, view } of board) {
    const orgName = name(f.row.orgId);
    for (const p of f.promises) {
      if (p.keptOn || !p.promisedOn || p.promisedOn >= today) continue;
      brokenPromises.push({
        number: f.row.number, orgName, byName: p.byName,
        promisedOn: p.promisedOn, daysPast: days(p.promisedOn), payableCents: view.payableCents,
      });
    }
    for (const d of f.disputes) {
      if (d.resolvedOn) continue;
      openDisputes.push({
        number: f.row.number, orgName, reason: d.reason,
        daysOpen: days(d.openedOn), disputedCents: view.disputedCents, restCents: view.payableCents,
      });
    }
    if (view.daysLate > 0) {
      overdue.push({
        number: f.row.number, orgName,
        daysLate: view.daysLate, balanceCents: view.balanceCents,
      });
    }
  }

  const holdOrgIds = [...new Set(board.map((b) => b.invoice.row.orgId))];
  const standings = await creditForMany(holdOrgIds, today);
  const onHold = [...standings.entries()]
    .filter(([, s]) => s.onHold)
    .map(([id, s]) => ({
      orgName: name(id), balanceCents: s.balanceCents, oldestDaysLate: s.oldestDaysLate,
    }));

  // Quotes inside a week of lapsing. A quote nobody answered is revenue that
  // simply evaporates, and it evaporates quietly - there is no aging report it
  // ever appears on.
  const quoteRows = await allQuotes(tenantOrgId);
  const links = await db.select().from(shareLinks).where(forTenant(shareLinks.tenantOrgId, tenantOrgId));
  const staleQuotes = stale(quoteRows.map((q) => q.row), today).map((row) => {
    const f = quoteRows.find((x) => x.row.id === row.id)!;
    return {
      number: row.number, orgName: name(row.orgId),
      daysLeft: daysToExpiry(row.expiresOn, today) ?? 0,
      valueCents: quoteTotal(f),
      views: links.find((l) => l.quoteId === row.id)?.openCount ?? 0,
    };
  });

  return {
    staleQuotes,
    unbilled: jobs.map((j) => ({
      number: j.number, orgName: j.orgName, daysClosed: j.daysClosed, valueCents: j.valueCents,
    })).filter((j) => j.valueCents > 0),
    brokenPromises, openDisputes, overdue, onHold,
  };
}

// ---------------------------------------------------------------------------
// Quotes. Same split as invoices: pure rules in lib/quotes, fetching here, and
// one org-scoped door the share viewer uses.
// ---------------------------------------------------------------------------

export type FullQuote = {
  row: typeof quotes.$inferSelect;
  lines: (typeof quoteLines.$inferSelect)[];
};

/** The lines, before anything comes off. What the paper calls Subtotal. */
export const quoteSubtotal = (q: FullQuote): number =>
  q.lines.reduce((n, l) => n + (l.covered ? 0 : Math.round(qtyOf(l) * l.unitCents)), 0);

/**
 * What the quote is FOR: the lines, less the discount.
 *
 * The one place a quote's price comes from. Everything that quotes a figure at
 * anybody - the client's page, the emailed link, the deposit raised on
 * approval, the digest, the finance rollup - reads this, so a discount cannot
 * be visible on one screen and absent from the invoice that follows.
 */
export const quoteTotal = (q: FullQuote): number =>
  netCents(quoteSubtotal(q), q.row);

async function hydrateQuotes(rows: (typeof quotes.$inferSelect)[]): Promise<FullQuote[]> {
  if (!rows.length) return [];
  const lineRows = await db.select().from(quoteLines)
    .where(inArray(quoteLines.quoteId, rows.map((r) => r.id)));
  return rows.map((row) => ({
    row,
    lines: lineRows.filter((l) => l.quoteId === row.id).sort((a, b) => a.position - b.position || a.id - b.id),
  }));
}

/** Every quote in the workspace, newest first. Internal surfaces only. */
export const allQuotes = cache(async (tenantOrgId: number | null): Promise<FullQuote[]> => {
  const rows = await db.select().from(quotes).where(forTenant(quotes.tenantOrgId, tenantOrgId));
  return (await hydrateQuotes(rows)).sort((a, b) => b.row.id - a.row.id);
});

export async function quoteById(id: number): Promise<FullQuote | null> {
  return (await hydrateQuotes(await db.select().from(quotes).where(eq(quotes.id, id))))[0] ?? null;
}

/**
 * One quote, for a client - the org id applied IN THE QUERY, exactly as
 * invoiceForOrg does it. A token for one client cannot be pointed at another
 * client's price.
 */
export async function quoteForOrg(id: number, orgId: number): Promise<FullQuote | null> {
  const rows = await db.select().from(quotes).where(and(eq(quotes.id, id), eq(quotes.orgId, orgId)));
  return (await hydrateQuotes(rows))[0] ?? null;
}

// ---------------------------------------------------------------------------
// Job costing. Revenue against cost, and what it cost to be owed the money.
// ---------------------------------------------------------------------------

/**
 * Every closed job inside the window, costed, plus the same rolled up per
 * client with days-to-pay beside the margin.
 *
 * The cost of a job is read from the rows that already exist - what its parts
 * landed at, the hours logged against it, its expenses - and the revenue from
 * the invoice actually raised against it. A job with no invoice bills nothing
 * and says so; it is the leak the Overview names, seen from the other side.
 */
export async function costingBoard(today: string, windowDays: number, tenantOrgId: number | null): Promise<{
  jobs: JobMargin[];
  clients: ClientMargin[];
  loadedLaborCents: number;
}> {
  const [woRows, orgRows, settings, full] = await Promise.all([
    db.select().from(workOrders)
      .where(and(eq(workOrders.state, "closed"), forTenant(workOrders.tenantOrgId, tenantOrgId))),
    db.select({ id: orgs.id, name: orgs.name, termsDays: orgs.termsDays }).from(orgs),
    settingsRow(),
    allInvoices(tenantOrgId),
  ]);
  const loaded = settings?.loadedLaborCents ?? 0;
  const orgName = (id: number | null) => orgRows.find((o) => o.id === id)?.name ?? "";

  const closed = woRows.filter((w) => {
    const on = w.closedAt ? w.closedAt.toISOString().slice(0, 10) : "";
    return inWindow(on, today, windowDays);
  });
  const ids = closed.map((w) => w.id);
  const [partRows, timeRows, expenseRows, agreementRows] = ids.length
    ? await Promise.all([
        db.select().from(parts).where(inArray(parts.workOrderId, ids)),
        db.select().from(timeEntries).where(inArray(timeEntries.workOrderId, ids)),
        db.select().from(expenses).where(inArray(expenses.workOrderId, ids)),
        db.select().from(agreements).where(forTenant(agreements.tenantOrgId, tenantOrgId)),
      ])
    : [[], [], [], []];

  const jobs: JobMargin[] = closed.map((w) => {
    const billed = full
      .filter((f) => f.row.workOrderId === w.id && f.row.status !== "void" && f.row.status !== "draft")
      .reduce((n, f) => n + f.lines.reduce(
        (m, l) => m + (l.covered ? 0 : Math.round(qtyOf(l) * l.unitCents)), 0), 0);
    // Which paper answered for it, if any - the same picker the draft uses.
    const cov = coverageFor({
      agreements: agreementRows.map((a) => ({
        id: a.id, number: a.number, orgId: a.orgId, status: a.status,
        startsOn: a.startsOn, endsOn: a.endsOn, instrumentIds: a.instrumentIds,
      // Somebody else's contract cannot absorb our labour - see coverageFor.
      providerOrgId: a.providerOrgId,
        laborCovered: a.kind === "contract",
        partsCovered: a.kind === "contract" && (a.partsUnlimited || a.partsAllowanceCents > 0),
      })),
      orgId: w.orgId, instrumentId: w.instrumentId, today,
    });
    return jobMargin({
      woId: w.id, number: w.number, title: w.title,
      orgId: w.orgId, orgName: orgName(w.orgId),
      closedOn: w.closedAt ? w.closedAt.toISOString().slice(0, 10) : "",
      coveredBy: billed === 0 && cov.agreementNumber ? cov.agreementNumber : "",
      billedCents: billed,
      partsCostCents: partRows.filter((p) => p.workOrderId === w.id)
        .reduce((n, p) => n + (p.costCents ?? 0), 0),
      billedMinutes: timeRows.filter((t) => t.workOrderId === w.id && t.billable)
        .reduce((n, t) => n + t.minutes, 0),
      expensesCents: expenseRows.filter((e) => e.workOrderId === w.id)
        .reduce((n, e) => n + e.amountCents, 0),
    }, loaded);
  }).sort((a, b) => b.closedOn.localeCompare(a.closedOn));

  const byOrg = new Map<number, JobMargin[]>();
  for (const w of closed) {
    if (w.orgId === null) continue;
    const j = jobs.find((x) => x.woId === w.id);
    if (j) byOrg.set(w.orgId, [...(byOrg.get(w.orgId) ?? []), j]);
  }

  const clients: ClientMargin[] = [...byOrg.entries()].map(([orgId, theirJobs]) => {
    const org = orgRows.find((o) => o.id === orgId);
    const theirs = full.filter((f) => f.row.orgId === orgId);
    // Paid in full, and when. An invoice still open has an age, not a
    // days-to-pay - see lib/costing.
    const paid = theirs.flatMap((f) => {
      const view = invoiceView(asStatementRow(f), today);
      if (view.standing !== "paid" || !f.row.issuedOn || !f.payments.length) return [];
      const last = f.payments.map((p) => p.receivedOn).filter(Boolean).sort().at(-1) ?? "";
      return last ? [{ issuedOn: f.row.issuedOn, paidOn: last, amountCents: view.linesCents + view.feesCents }] : [];
    });
    const open = theirs
      .map((f) => invoiceView(asStatementRow(f), today))
      .filter(isOpen)
      .reduce((n, v) => n + v.balanceCents, 0);
    const contract = agreementRows.find((a) => a.orgId === orgId && a.kind === "contract" && a.status === "active");
    return clientMargin({
      orgId, orgName: org?.name ?? "", 
      terms: `${contract ? "contract" : "T&M"} · net ${org?.termsDays ?? 30}`,
      jobs: theirJobs, paid, openCents: open,
    });
  }).sort((a, b) => b.billedCents - a.billedCents);

  return { jobs, clients, loadedLaborCents: loaded };
}

/**
 * What maintenance cost, per completed job.
 *
 * The other half of the costing page, and the half nothing has ever loaded. A
 * completed PM is a Done task carrying its schedule's id - never a work order,
 * and never an invoice - so it has been invisible to costing since costing
 * existed, while its parts quietly left the building. See lib/pmCosting for
 * the attribution rule and for why this is parts only.
 *
 * EVERY Done PM record is read, not only the window's. A part goes against the
 * completion it was fitted for, and deciding that from the window's rows alone
 * would land a seal fitted two years ago on the oldest job still on screen,
 * dressed up as this quarter's spend.
 *
 * Its own loader rather than another field on costingBoard: /money and
 * /metrics call that one for figures that have nothing to do with PM, and
 * three more queries on two pages that will not read them is a bill nobody
 * asked for.
 */
export async function pmCostingBoard(
  today: string, windowDays: number, tenantOrgId: number | null,
): Promise<PmCostBoard> {
  const done = await db.select({
    id: tasks.id, pmScheduleId: tasks.pmScheduleId, title: tasks.title,
    instrumentId: tasks.instrumentId, assetId: tasks.assetId, completedAt: tasks.completedAt,
  }).from(tasks).where(and(
    forTenant(tasks.tenantOrgId, tenantOrgId),
    isNotNull(tasks.pmScheduleId),
    eq(tasks.state, "Done"),
    isNotNull(tasks.completedAt),
  ));
  if (!done.length) return { rows: [], quiet: 0, totalCents: 0 };

  const scheduleIds = [...new Set(done.map((t) => t.pmScheduleId as number))];
  const instIds = [...new Set(done.map((t) => t.instrumentId).filter((n): n is number => n !== null))];
  const [instRows, orgRows, partRows] = await Promise.all([
    instIds.length
      ? db.select({
          id: instruments.id, name: instruments.name, model: instruments.model,
          ownerOrgId: instruments.ownerOrgId,
        }).from(instruments).where(inArray(instruments.id, instIds))
      : Promise.resolve([]),
    db.select({ id: orgs.id, name: orgs.name }).from(orgs),
    /* Scoped by the schedule ids, which came off tenant-scoped tasks - the
       same way costingBoard reaches parts through its own work order ids. */
    db.select({
      pmScheduleId: parts.pmScheduleId, installedAt: parts.installedAt,
      costCents: parts.costCents, workOrderId: parts.workOrderId,
    }).from(parts).where(and(
      inArray(parts.pmScheduleId, scheduleIds),
      isNotNull(parts.costCents),
      sql`${parts.installedAt} <> ''`,
    )),
  ]);

  const woIds = [...new Set(partRows.map((p) => p.workOrderId).filter((n): n is number => n !== null))];
  const [labels, woRows] = await Promise.all([
    getSystemLabels(instRows),
    woIds.length
      ? db.select({ id: workOrders.id, number: workOrders.number }).from(workOrders)
          .where(inArray(workOrders.id, woIds))
      : Promise.resolve([]),
  ]);
  const orgName = (id: number | null) => orgRows.find((o) => o.id === id)?.name ?? "";

  const completions: PmCompletion[] = done.map((t) => {
    const inst = instRows.find((i) => i.id === t.instrumentId);
    return {
      taskId: t.id, scheduleId: t.pmScheduleId as number, title: t.title,
      orgName: orgName(inst?.ownerOrgId ?? null),
      systemName: t.instrumentId === null ? "" : labels.get(t.instrumentId) ?? "",
      // The record lives where the record lives: on the system's job band, or
      // on the module for a PM that belongs to a unit and no system.
      href: t.instrumentId !== null ? `/instruments/${t.instrumentId}#task-${t.id}`
        : t.assetId !== null ? `/assets/${t.assetId}` : "",
      completedOn: (t.completedAt as Date).toISOString().slice(0, 10),
    };
  });

  return pmCosts(completions, partRows.map((p) => ({
    scheduleId: p.pmScheduleId as number,
    // Anything that is not a calendar day cannot be placed against a cycle, and
    // isoDay is where the shop's one date rule already lives - see partGroups.
    installedOn: isoDay(p.installedAt),
    costCents: p.costCents ?? 0,
    onWorkOrder: p.workOrderId === null ? "" : woRows.find((w) => w.id === p.workOrderId)?.number ?? "",
  })), today, windowDays);
}
