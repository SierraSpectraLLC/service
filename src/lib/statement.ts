// What a client owes, across every invoice - and how old each piece of it is.
//
// Same rule as lib/billing one level up: nothing here is stored. A statement
// is a view of rows at a moment, recomputed every time somebody looks, which
// is why the number on the client's portal and the number in Collections can
// never disagree. There is no statements table and there should never be one.
//
// Aging is the part worth being careful about. "Past due" is measured from the
// due date, not the issue date, and an invoice with a dispute on it ages on
// its undisputed remainder only - a client who raised a real question about
// one cartridge has not thereby bought ninety quiet days on the rest.
//
// Pure. Callers hand in the rows.

import { invoiceBalance, payableNow, type DraftLine } from "@/lib/billing";
import type { Tone } from "@/lib/tones";

/** The lifecycle word stored on the row. Arithmetic is never one of these. */
export const INVOICE_STATUSES = ["draft", "sent", "partial", "paid", "void", "referred"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft", sent: "Sent", partial: "Partly paid", paid: "Paid",
  void: "Void", referred: "Referred",
};

/**
 * What an invoice IS today, as opposed to what its status column last said.
 *
 * The column is a lifecycle word somebody wrote; this is the answer the rows
 * give. They are reconciled here rather than by a job that rewrites the column,
 * because a nightly job that disagrees with the ledger is a third opinion.
 */
export type Standing = "draft" | "void" | "paid" | "overdue" | "due" | "sent" | "referred";

export const STANDING_LABEL: Record<Standing, string> = {
  draft: "Draft", void: "Void", paid: "Paid", overdue: "Past due",
  due: "Due soon", sent: "Open", referred: "Referred",
};

export const STANDING_TONE: Record<Standing, Tone> = {
  draft: "neutral", void: "faint", paid: "good", overdue: "bad",
  due: "warn", sent: "info", referred: "bad",
};

export const METHOD_LABEL: Record<string, string> = {
  ach: "ACH", card: "Card", check: "Check", other: "Other",
};

export type InvoiceRow = {
  id: number;
  number: string;
  orgId: number;
  status: string;
  issuedOn: string;         // YYYY-MM-DD, blank while draft
  dueOn: string;            // blank = no terms recorded, never overdue
  lines: Pick<DraftLine, "qty" | "unitCents" | "covered">[];
  feeCents?: number[];
  paidCents?: number[];
  /** What is under dispute right now. Ages, but is not asked for. */
  disputedCents?: number;
};

export type InvoiceView = {
  id: number;
  number: string;
  standing: Standing;
  linesCents: number;
  feesCents: number;
  paidCents: number;
  /** Owed on paper, disputes included. */
  balanceCents: number;
  /** What a reminder may ask for: the balance less anything disputed. */
  payableCents: number;
  disputedCents: number;
  /** Days past the due date. Zero or negative reads as 0. */
  daysLate: number;
};

/** Whole days from `from` to `to`, both YYYY-MM-DD. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  if (!from || !to) return 0;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/** The due date terms give an invoice: the day it was issued, plus net N. */
export function dueDate(issuedOn: string, termsDays: number): string {
  if (!issuedOn) return "";
  const t = Date.parse(`${issuedOn}T00:00:00Z`);
  if (!Number.isFinite(t)) return "";
  return new Date(t + Math.max(0, termsDays) * 86400000).toISOString().slice(0, 10);
}

/**
 * How many days out a "due soon" invoice is still merely due. Beyond this it
 * is just open; inside it, somebody should be looking at it.
 */
export const DUE_SOON_DAYS = 7;

export function invoiceView(inv: InvoiceRow, today: string): InvoiceView {
  const sums = invoiceBalance({ lines: inv.lines, feeCents: inv.feeCents, paidCents: inv.paidCents });
  const disputed = Math.max(0, inv.disputedCents ?? 0);
  const late = inv.dueOn ? Math.max(0, daysBetween(inv.dueOn, today)) : 0;
  const standing: Standing =
    inv.status === "draft" ? "draft"
    : inv.status === "void" ? "void"
    : inv.status === "referred" ? "referred"
    // Paid is the ledger's answer, not the column's: a row that says "sent"
    // and sums to zero has been paid, whatever nobody got round to clicking.
    : sums.balanceCents <= 0 ? "paid"
    : late > 0 ? "overdue"
    : inv.dueOn && daysBetween(today, inv.dueOn) <= DUE_SOON_DAYS ? "due"
    : "sent";
  return {
    id: inv.id, number: inv.number, standing,
    linesCents: sums.linesCents, feesCents: sums.feesCents, paidCents: sums.paidCents,
    balanceCents: sums.balanceCents,
    payableCents: payableNow({ balanceCents: sums.balanceCents, disputedCents: disputed }),
    disputedCents: disputed,
    daysLate: standing === "paid" || standing === "void" || standing === "draft" ? 0 : late,
  };
}

/** Is this invoice still money in the world: sent, not void, not settled. */
export const isOpen = (v: InvoiceView): boolean =>
  v.standing !== "draft" && v.standing !== "void" && v.standing !== "paid";

export const AGING_BUCKETS = ["current", "d30", "d60", "d90"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const BUCKET_LABEL: Record<AgingBucket, string> = {
  current: "Current", d30: "1 to 30 days", d60: "31 to 60 days", d90: "Over 60 days",
};

export const BUCKET_TONE: Record<AgingBucket, Tone> = {
  current: "good", d30: "warn", d60: "bad", d90: "bad",
};

export const bucketOf = (daysLate: number): AgingBucket =>
  daysLate <= 0 ? "current" : daysLate <= 30 ? "d30" : daysLate <= 60 ? "d60" : "d90";

/**
 * The aging bar: how much is owed in each band, and by whom. Only open
 * invoices count - a paid one is not aging and a draft was never sent.
 */
export function aging(views: InvoiceView[]): { total: number; buckets: Record<AgingBucket, number> } {
  const buckets: Record<AgingBucket, number> = { current: 0, d30: 0, d60: 0, d90: 0 };
  let total = 0;
  for (const v of views.filter(isOpen)) {
    buckets[bucketOf(v.daysLate)] += v.balanceCents;
    total += v.balanceCents;
  }
  return { total, buckets };
}

export type Statement = {
  orgId: number;
  /** Every open invoice, oldest due date first - the order a client reads. */
  open: InvoiceView[];
  openCents: number;
  payableCents: number;
  disputedCents: number;
  /** Paid inside the window the caller handed in. */
  paidCents: number;
  oldestDaysLate: number;
  aging: ReturnType<typeof aging>;
};

/**
 * One client's account, as of today.
 *
 * `invoices` is every invoice for the org - the function decides which ones
 * are still open, rather than the caller pre-filtering and getting the rule
 * slightly different from the next caller.
 */
export function statementFor(input: {
  orgId: number;
  invoices: InvoiceRow[];
  today: string;
  /** Payments inside the reporting window, for the "paid this period" line. */
  paidCents?: number[];
}): Statement {
  const views = input.invoices
    .filter((i) => i.orgId === input.orgId)
    .map((i) => invoiceView(i, input.today));
  const open = views.filter(isOpen).sort((a, b) => b.daysLate - a.daysLate || a.number.localeCompare(b.number));
  return {
    orgId: input.orgId,
    open,
    openCents: open.reduce((n, v) => n + v.balanceCents, 0),
    payableCents: open.reduce((n, v) => n + v.payableCents, 0),
    disputedCents: open.reduce((n, v) => n + v.disputedCents, 0),
    paidCents: (input.paidCents ?? []).reduce((n, c) => n + c, 0),
    oldestDaysLate: open.reduce((n, v) => Math.max(n, v.daysLate), 0),
    aging: aging(views),
  };
}

/**
 * The loop bar on /money Overview: where money is sitting, in the order it
 * moves. Every figure is a sum handed in; nothing is read from a column.
 */
export type LoopBar = {
  quotedCents: number;
  approvedCents: number;
  unbilledCents: number;
  currentCents: number;
  pastDueCents: number;
  paidCents: number;
};

export function loopBar(input: {
  quoted: number[]; approved: number[]; unbilled: number[];
  views: InvoiceView[]; paid: number[];
}): LoopBar {
  const sum = (xs: number[]) => xs.reduce((n, c) => n + c, 0);
  const open = input.views.filter(isOpen);
  return {
    quotedCents: sum(input.quoted),
    approvedCents: sum(input.approved),
    unbilledCents: sum(input.unbilled),
    currentCents: open.filter((v) => v.daysLate <= 0).reduce((n, v) => n + v.balanceCents, 0),
    pastDueCents: open.filter((v) => v.daysLate > 0).reduce((n, v) => n + v.balanceCents, 0),
    paidCents: sum(input.paid),
  };
}
