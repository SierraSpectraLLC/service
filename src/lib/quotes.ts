// A price, offered - and what happens when somebody answers it.
//
// The lines are lib/billing's lines: a quote is composed by the same function
// that composes an invoice, from the same rows, so what was quoted and what
// gets billed cannot drift apart. Everything here is what a quote adds over an
// invoice: a date it stops being true, a deposit owed on yes, and the fact
// that the person answering is the CLIENT rather than somebody at the shop.
//
// Nothing is stored that can be computed. A quote's total is its lines, its
// standing is its status against today's date, and the deposit is a percentage
// of the total taken at the moment of approval.
//
// Pure. Callers hand in the rows.

import { formatCents } from "@/lib/money";
import type { Tone } from "@/lib/tones";

export const QUOTE_STATUSES = ["draft", "sent", "approved", "declined", "expired"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const QUOTE_LABEL: Record<string, string> = {
  draft: "Draft", sent: "Awaiting client", approved: "Approved",
  declined: "Declined", expired: "Expired",
};

/** What a quote IS today, as opposed to what its column last said. */
export type QuoteStanding = "draft" | "awaiting" | "approved" | "declined" | "expired";

export const STANDING_LABEL: Record<QuoteStanding, string> = {
  draft: "Draft", awaiting: "Awaiting client", approved: "Approved",
  declined: "Declined", expired: "Expired",
};

export const STANDING_TONE: Record<QuoteStanding, Tone> = {
  draft: "neutral", awaiting: "info", approved: "good",
  declined: "bad", expired: "faint",
};

/**
 * Expiry is a date comparison, not a job that rewrites rows overnight.
 *
 * A quote that lapsed at midnight is expired the moment somebody looks,
 * whether or not a cron ran - and the column is left alone so that the day it
 * actually lapsed stays readable.
 */
export function quoteStanding(
  q: { status: string; expiresOn: string }, today: string,
): QuoteStanding {
  if (q.status === "draft") return "draft";
  if (q.status === "approved") return "approved";
  if (q.status === "declined") return "declined";
  if (q.status === "expired") return "expired";
  return q.expiresOn && q.expiresOn < today ? "expired" : "awaiting";
}

/** Can the client still answer this one? */
export const answerable = (q: { status: string; expiresOn: string }, today: string): boolean =>
  quoteStanding(q, today) === "awaiting";

/** Days until it lapses. Negative once it has. Null with no expiry set. */
export function daysToExpiry(expiresOn: string, today: string): number | null {
  if (!expiresOn) return null;
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${expiresOn}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * How long before expiry the digest starts asking about it.
 *
 * A week: long enough that somebody can still chase it and get an answer,
 * short enough that it is not nagging about a quote sent on Tuesday.
 */
export const NUDGE_BEFORE_EXPIRY_DAYS = 7;

/** Quotes worth a line in the internal digest this morning. */
export function stale<T extends { status: string; expiresOn: string }>(
  quotes: T[], today: string,
): T[] {
  return quotes.filter((q) => {
    if (quoteStanding(q, today) !== "awaiting") return false;
    const d = daysToExpiry(q.expiresOn, today);
    return d !== null && d <= NUDGE_BEFORE_EXPIRY_DAYS;
  });
}

/**
 * The deposit due on approval, in cents.
 *
 * Rounded to the cent and never more than the whole quote - a 100% deposit is
 * a prepayment, which is a real thing to ask for, and anything above it is a
 * typo somebody made in a percent field.
 */
export function depositCents(totalCents: number, pct: number): number {
  if (pct <= 0 || totalCents <= 0) return 0;
  return Math.min(totalCents, Math.round((totalCents * Math.min(100, pct)) / 100));
}

/**
 * The sentence under the approve button.
 *
 * It says what pressing it DOES - schedules the work, reserves the parts, and
 * generates an invoice due now - because a client pressing a button on a phone
 * deserves to know they are about to owe money, and finding that out from the
 * invoice afterwards is how a good relationship acquires its first argument.
 */
export function approvalConsequence(input: {
  totalCents: number;
  depositPct: number;
  onHold: boolean;
  clientName: string;
}): string {
  const deposit = depositCents(input.totalCents, input.depositPct);
  const bits = ["Approving schedules the work and reserves the parts"];
  if (deposit > 0) {
    bits.push(`a ${input.depositPct}% deposit of ${formatCents(deposit)} is invoiced on approval, due immediately`);
  }
  if (input.onHold) {
    // Said plainly rather than discovered when nobody turns up: the job is
    // recorded either way, and pretending otherwise is how the client finds
    // out on the day of the visit.
    bits.push(`the job opens on credit hold while ${input.clientName}'s account is past due`);
  }
  return `${bits.join("; ")}.`;
}

/**
 * What a decline does. The reason goes to the job's discussion where the
 * engineer will see it, not into a field on the quote nobody opens again.
 */
export const declineConsequence = (): string =>
  "Closes the quote. Your reason is passed to the engineer.";

/**
 * Renewal pricing, from what the last term actually cost to serve.
 *
 * The argument for a number is the burn, not last year's number plus five
 * percent: "you used six visits and $4,900 of parts" is a conversation, and
 * "our rates went up" is not. Uplift is applied to the ACTUALS, so a client
 * who barely used the contract sees that reflected instead of paying for a
 * term somebody guessed at twelve months ago.
 */
export function renewalFromBurn(input: {
  visitsUsed: number;
  partsCents: number;
  laborMinutes: number;
  hourlyCents: number;
  /** Basis points of uplift on the computed figure. 500 = 5%. */
  upliftBps?: number;
}): { visits: number; partsCents: number; valueCents: number; basis: string } {
  const labor = Math.round((input.hourlyCents * input.laborMinutes) / 60);
  const raw = labor + input.partsCents;
  const uplift = Math.max(0, input.upliftBps ?? 0);
  const value = Math.round((raw * (10000 + uplift)) / 10000);
  // At least one visit and a real allowance: a renewal quoting zero visits
  // because last term was quiet is a renewal nobody signs.
  const visits = Math.max(1, input.visitsUsed);
  return {
    visits,
    partsCents: Math.max(0, input.partsCents),
    valueCents: value,
    basis: `${input.visitsUsed} visit${input.visitsUsed === 1 ? "" : "s"} used, `
      + `${Math.round(input.laborMinutes / 60)} h of labor at ${formatCents(input.hourlyCents)}, `
      + `${formatCents(input.partsCents)} of parts`
      + (uplift > 0 ? `, plus ${(uplift / 100).toFixed(1)}%` : ""),
  };
}

/**
 * The proposal for a client who has never had a contract: what their trailing
 * time-and-materials actually cost them, turned into a price.
 *
 * The pitch writes itself out of the numbers - cheaper for them, predictable
 * for you - and it is only honest if the discount is real, so the function
 * returns both figures and lets the caller show the comparison.
 */
export function contractProposal(input: {
  trailingCents: number;
  months: number;
  visitsPerYear: number;
  partsAllowanceCents: number;
  /** How much of the T&M spend is given back as the reason to sign. */
  discountBps?: number;
}): { annualCents: number; trailingAnnualCents: number; savingCents: number; line: string } | null {
  if (input.months <= 0 || input.trailingCents <= 0) return null;
  const annualised = Math.round((input.trailingCents * 12) / input.months);
  const discount = Math.max(0, input.discountBps ?? 1500);
  const annual = Math.round((annualised * (10000 - Math.min(9000, discount))) / 10000);
  return {
    annualCents: annual,
    trailingAnnualCents: annualised,
    savingCents: annualised - annual,
    line: `${input.visitsPerYear} visit${input.visitsPerYear === 1 ? "" : "s"} plus `
      + `${formatCents(input.partsAllowanceCents)} of parts at ${formatCents(annual)} a year, `
      + `against ${formatCents(annualised)} of time and materials at the current pace.`,
  };
}
