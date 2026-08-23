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

import { and, eq, inArray } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/db";
import {
  agreements, appSettings, expenses, instruments, invoiceLines, invoices,
  orgs, orgSites, partPrices, parts, payments, rateCards, timeEntries, workOrders,
} from "@/db/schema";
import {
  buildInvoiceLines, coverageFor, coveredValue, linesTotal, sellPrice,
  type DraftLine, type ExpenseRow, type PartRow, type TimeRow,
} from "@/lib/billing";
import { resolvePolicy, type BillingPolicy } from "@/lib/billingPolicy";
import { bestPrice } from "@/lib/priceBook";
import { resolveRate, type RateCard } from "@/lib/rates";
import { dueDate, type InvoiceRow } from "@/lib/statement";
import { shopToday } from "@/lib/shopday";

/** Cached per request: three pages on one render all want the settings row. */
const settings = cache(async () => {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  return row ?? null;
});

export type BillingContext = {
  policy: BillingPolicy;
  invoicePrefix: string;
  loadedLaborCents: number;
};

/** The policy in force for one client, and the two numbers beside it. */
export async function billingContext(orgId: number | null): Promise<BillingContext> {
  const [s, org] = await Promise.all([
    settings(),
    orgId === null ? Promise.resolve(null) : db.select().from(orgs).where(eq(orgs.id, orgId)).then((r) => r[0] ?? null),
  ]);
  return {
    policy: resolvePolicy(s?.billingPolicy ?? null, org?.billingPolicy ?? null),
    invoicePrefix: s?.invoicePrefix || "INV-",
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
      laborCovered: a.kind === "contract",
      partsCovered: a.kind === "contract" && (a.partsUnlimited || a.partsAllowanceCents > 0),
    })),
    orgId: wo.orgId, instrumentId: wo.instrumentId, today,
  });

  const [cards, site, book] = await Promise.all([
    db.select().from(rateCards),
    inst?.siteId ? db.select().from(orgSites).where(eq(orgSites.id, inst.siteId)).then((r) => r[0] ?? null) : Promise.resolve(null),
    db.select().from(partPrices),
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

/** An invoice with its lines and payments attached, in statement shape. */
export type FullInvoice = {
  row: typeof invoices.$inferSelect;
  lines: (typeof invoiceLines.$inferSelect)[];
  payments: (typeof payments.$inferSelect)[];
};

/** qty is stored in thousandths; the arithmetic wants the real number. */
export const qtyOf = (l: { qty: number }): number => l.qty / 1000;

export const asStatementRow = (f: FullInvoice): InvoiceRow => ({
  id: f.row.id, number: f.row.number, orgId: f.row.orgId, status: f.row.status,
  issuedOn: f.row.issuedOn, dueOn: f.row.dueOn,
  lines: f.lines.map((l) => ({ qty: qtyOf(l), unitCents: l.unitCents, covered: l.covered })),
  paidCents: f.payments.map((p) => p.amountCents),
});

async function hydrate(rows: (typeof invoices.$inferSelect)[]): Promise<FullInvoice[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [lineRows, payRows] = await Promise.all([
    db.select().from(invoiceLines).where(inArray(invoiceLines.invoiceId, ids)),
    db.select().from(payments).where(inArray(payments.invoiceId, ids)),
  ]);
  return rows.map((row) => ({
    row,
    lines: lineRows.filter((l) => l.invoiceId === row.id).sort((a, b) => a.position - b.position || a.id - b.id),
    payments: payRows.filter((p) => p.invoiceId === row.id).sort((a, b) => a.receivedOn.localeCompare(b.receivedOn)),
  }));
}

/** Every invoice in the workspace, newest first. Internal surfaces only. */
export async function allInvoices(): Promise<FullInvoice[]> {
  const rows = await db.select().from(invoices);
  return (await hydrate(rows)).sort((a, b) => b.row.id - a.row.id);
}

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

/** Every invoice belonging to one client. The same door, for the statement. */
export async function invoicesForOrg(orgId: number): Promise<FullInvoice[]> {
  const rows = await db.select().from(invoices).where(eq(invoices.orgId, orgId));
  return (await hydrate(rows)).sort((a, b) => b.row.id - a.row.id);
}

/** The due date this client's terms give an invoice issued today. */
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
export async function unbilledJobs(limit = 25): Promise<UnbilledJob[]> {
  const closed = await db.select().from(workOrders).where(eq(workOrders.state, "closed"));
  const billed = new Set(
    (await db.select({ woId: invoices.workOrderId, status: invoices.status }).from(invoices))
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
}
