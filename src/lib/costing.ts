// Revenue against cost, and how long the money takes to arrive.
//
// Two numbers sit beside each other here on purpose. Margin says whether a job
// was worth doing; days-to-pay says what it cost to be owed the money. A 41%
// job that takes sixty-seven days and three phone calls is not a better client
// than a 38% one that pays in eleven, and a shop that only ever looks at the
// first number cannot see that.
//
// The cost inputs are the ones the app already records: what parts landed at,
// hours at a loaded rate, and expenses. Loaded rather than the wage, because an
// hour costs the shop its share of the van, the phone and the insurance whether
// or not it was sold - costing against the raw wage is how a shop concludes
// every job is profitable.
//
// A covered job has no margin to report. Its value is the agreement's, drawn
// down over a term, and pretending a $0 invoice is a 100% loss would make the
// contract look like the worst work in the shop. Those roll up separately.
//
// Pure. Callers hand in the rows.

import { formatCents } from "@/lib/money";
import type { Tone } from "@/lib/tones";

export const WINDOWS = [30, 90, 365] as const;
export type Window = (typeof WINDOWS)[number];

export const WINDOW_LABEL: Record<number, string> = {
  30: "30 d", 90: "90 d", 365: "YTD",
};

export type JobRow = {
  woId: number;
  number: string;
  title: string;
  orgId: number | null;
  orgName: string;
  closedOn: string;
  /** Blank when the job was time and materials. */
  coveredBy: string;
  billedCents: number;
  partsCostCents: number;
  billedMinutes: number;
  expensesCents: number;
};

export type JobMargin = {
  woId: number;
  number: string;
  title: string;
  orgName: string;
  closedOn: string;
  billedCents: number;
  costCents: number;
  marginCents: number;
  /** Null when there is nothing honest to report - see `note`. */
  marginPct: number | null;
  /** Why there is no percentage, when there is not. */
  note: string;
  tone: Tone;
};

/**
 * One job's margin.
 *
 * Three cases that are NOT the ordinary one, each reported rather than
 * flattened into a number:
 *
 *   covered      - billed nothing because a contract answered for it. The
 *                  value belongs to the agreement, not to this job.
 *   no rate set  - nobody has told us what an hour costs, so the labour half
 *                  of the cost is missing and any percentage would be a lie.
 *   nothing billed - a $0 job with no coverage either. Division by zero, and
 *                  also a question somebody should be asked.
 */
export function jobMargin(row: JobRow, loadedLaborCents: number): JobMargin {
  const labor = Math.round((loadedLaborCents * row.billedMinutes) / 60);
  const cost = row.partsCostCents + labor + row.expensesCents;
  const margin = row.billedCents - cost;
  const base = {
    woId: row.woId, number: row.number, title: row.title, orgName: row.orgName,
    closedOn: row.closedOn, billedCents: row.billedCents, costCents: cost,
    marginCents: margin,
  };

  if (row.coveredBy && row.billedCents === 0) {
    return { ...base, marginPct: null, note: `vs ${row.coveredBy}`, tone: "info" };
  }
  if (loadedLaborCents <= 0 && row.billedMinutes > 0) {
    return { ...base, marginPct: null, note: "no loaded labor rate set", tone: "faint" };
  }
  if (row.billedCents <= 0) {
    return { ...base, marginPct: null, note: "nothing billed", tone: "faint" };
  }
  const pct = Math.round((margin / row.billedCents) * 100);
  return {
    ...base, marginPct: pct, note: "",
    tone: pct < 0 ? "bad" : pct < 20 ? "warn" : "good",
  };
}

/**
 * How long this client's money takes to arrive, weighted by amount.
 *
 * Weighted, not averaged: a client who pays five $200 invoices the same day
 * and one $40,000 invoice at ninety days is a ninety-day client, and a plain
 * mean would call them a fifteen-day one. What the shop is financing is the
 * dollars, so the dollars are what count.
 *
 * Only invoices that have actually been paid in full are included. A bill
 * still sitting open has no days-to-pay yet - it has an age, which is what
 * aging is for, and mixing the two would let an unpaid invoice quietly
 * improve the number by not being counted as late.
 */
export function daysToPay(
  invoices: { issuedOn: string; paidOn: string; amountCents: number }[],
): number | null {
  const rows = invoices.filter((i) => i.issuedOn && i.paidOn && i.amountCents > 0);
  if (!rows.length) return null;
  let weighted = 0;
  let total = 0;
  for (const i of rows) {
    const a = Date.parse(`${i.issuedOn}T00:00:00Z`);
    const b = Date.parse(`${i.paidOn}T00:00:00Z`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const days = Math.max(0, Math.round((b - a) / 86400000));
    weighted += days * i.amountCents;
    total += i.amountCents;
  }
  return total > 0 ? Math.round(weighted / total) : null;
}

export type ClientRow = {
  orgId: number;
  orgName: string;
  /** "retainer · net 14" - what kind of client they are, in their own terms. */
  terms: string;
  jobs: JobMargin[];
  paid: { issuedOn: string; paidOn: string; amountCents: number }[];
  openCents: number;
};

export type ClientMargin = {
  orgId: number;
  orgName: string;
  terms: string;
  billedCents: number;
  costCents: number;
  marginPct: number | null;
  daysToPay: number | null;
  openCents: number;
  jobs: number;
  /** The sentence beside the numbers, when the two disagree. */
  note: string;
};

/** How slow is slow enough to say something about it. */
export const SLOW_PAY_DAYS = 45;

export function clientMargin(row: ClientRow): ClientMargin {
  // Covered jobs are excluded from the percentage for the same reason they are
  // excluded from a job's: their value is the agreement's, and counting a $0
  // invoice as a total loss would make the contract look like the worst work
  // in the shop.
  const billable = row.jobs.filter((j) => j.marginPct !== null);
  const billed = billable.reduce((n, j) => n + j.billedCents, 0);
  const cost = billable.reduce((n, j) => n + j.costCents, 0);
  const pct = billed > 0 ? Math.round(((billed - cost) / billed) * 100) : null;
  const days = daysToPay(row.paid);

  const note = pct !== null && days !== null && pct >= 30 && days >= SLOW_PAY_DAYS
    ? `A ${pct}% margin that costs ${days} days of float. That is the number to reprice on, `
      + `or the reason to propose a contract.`
    : "";

  return {
    orgId: row.orgId, orgName: row.orgName, terms: row.terms,
    billedCents: billed, costCents: cost, marginPct: pct,
    daysToPay: days, openCents: row.openCents, jobs: row.jobs.length, note,
  };
}

/** "$41.2k" - a figure somebody scans down a column rather than reconciles. */
export function short(cents: number): string {
  const abs = Math.abs(cents);
  if (abs < 1_000_00) return formatCents(cents);
  const k = cents / 100_000;
  return `${k < 0 ? "-" : ""}$${Math.abs(k).toFixed(1)}k`;
}

/** Everything closed inside the window, newest first. */
export const inWindow = (closedOn: string, today: string, days: number): boolean => {
  if (!closedOn) return false;
  const a = Date.parse(`${closedOn}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const age = Math.round((b - a) / 86400000);
  return age >= 0 && age <= days;
};
