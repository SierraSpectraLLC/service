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
 * What a client without a contract has actually been buying, read off their
 * own invoices.
 *
 * Pure, and it takes invoice lines rather than work orders and parts rows on
 * purpose: an invoice is what the client was CHARGED, which is the only side
 * of this a proposal may quote at them. It is also the one source already
 * scoped to the workspace by the time a page has it - see the note on usageFor
 * in lib/agreementUsage, which reads parts by owner org and would have been
 * the wrong door here.
 *
 * `covered` lines are skipped throughout. A line a contract paid for is not
 * time-and-materials, and counting it would inflate both the pace and the
 * price on the one card whose whole job is comparing the two.
 */
export type TrailingLine = { kind: string; qty: number; unitCents: number; covered: boolean };
export type TrailingInvoice = {
  issuedOn: string;
  /** The job it billed, if any. Distinct jobs are the honest count of visits. */
  workOrderId: number | null;
  lines: TrailingLine[];
};

export type TrailingUsage = {
  /** Whole months from their first issued invoice to today. Never negative. */
  months: number;
  invoices: number;
  /** Distinct jobs invoiced - how many times somebody went out. */
  visits: number;
  partsCents: number;
  laborMinutes: number;
  /** Everything they were charged that a contract did not cover. */
  trailingCents: number;
};

export function trailingUsage(input: {
  invoices: TrailingInvoice[];
  today: string;
}): TrailingUsage {
  const dated = input.invoices.map((i) => i.issuedOn).filter(Boolean).sort();
  const first = dated[0] ?? "";
  const months = first
    ? Math.max(0, Math.round(
        (Date.parse(`${input.today}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / (86400000 * 30),
      ))
    : 0;
  const jobs = new Set<number>();
  let partsCents = 0, laborMinutes = 0, trailingCents = 0;
  for (const inv of input.invoices) {
    if (inv.workOrderId !== null) jobs.add(inv.workOrderId);
    for (const l of inv.lines) {
      if (l.covered) continue;
      const qty = l.qty / 1000;
      const cents = Math.round(qty * l.unitCents);
      trailingCents += cents;
      if (l.kind === "part") partsCents += cents;
      // Labor qty is thousandths of an HOUR - see invoice_lines.qty, where 4.5 h
      // is 4500 - so the minutes are the hours times sixty and not the qty.
      if (l.kind === "labor") laborMinutes += Math.round(qty * 60);
    }
  }
  return {
    months, invoices: input.invoices.length,
    visits: jobs.size, partsCents, laborMinutes, trailingCents,
  };
}

/**
 * The least history a "pace" can honestly be read off.
 *
 * One invoice is a point, not a rate, and the arithmetic below multiplies by
 * twelve. A single $20,000 invoice issued this month annualised to "$240,000 a
 * year at the current pace" and then offered a contract priced against it -
 * which is a number nobody could defend in the room, on a card whose only job
 * is to be defensible in the room.
 */
export const PACE_MIN_MONTHS = 3;
export const PACE_MIN_INVOICES = 2;

export const hasPace = (u: TrailingUsage): boolean =>
  u.months >= PACE_MIN_MONTHS && u.invoices >= PACE_MIN_INVOICES;

/**
 * The proposal for a client who has never had a contract: their own trailing
 * time-and-materials, turned into a price and an entitlement.
 *
 * EVERY FIGURE IN THE SENTENCE IS THEIRS. The visits and the parts allowance
 * are their own annualised usage, not a house template - this card used to say
 * "4 visits plus $2,000 of parts" to every client on the list, which is an
 * offer nobody had entered and which happened to be wrong for both of the
 * clients it was shown for. The one number that is a policy rather than an
 * observation is the discount, and it is named in the line for that reason.
 *
 * Returns null when there is not enough history to read a pace off - see
 * hasPace. The caller shows the trailing figure alone in that case, which is a
 * fact, instead of a projection that is twelve times a single invoice.
 */
export function contractProposal(input: {
  usage: TrailingUsage;
  /** How much of the annualised T&M is given back as the reason to sign. */
  discountBps?: number;
}): {
  annualCents: number;
  trailingAnnualCents: number;
  savingCents: number;
  visitsPerYear: number;
  partsAllowanceCents: number;
  line: string;
} | null {
  const u = input.usage;
  if (!hasPace(u) || u.trailingCents <= 0) return null;
  const perYear = (n: number) => (n * 12) / u.months;
  /*
   * To the dollar, not the cent. Every figure below is a PROJECTION - a
   * trailing sum multiplied by twelve over however many months - and printing
   * one to the cent claims a precision the arithmetic does not have. It also
   * read as a bug: "$19,596.75 a year" beside "$7,685" and "$23,055" looks
   * like a spreadsheet artefact rather than a price somebody would say out
   * loud. Ledger figures elsewhere keep their cents, because those are money
   * that actually moved.
   */
  const toDollar = (cents: number) => Math.round(cents / 100) * 100;
  const annualised = toDollar(perYear(u.trailingCents));
  const discount = Math.min(9000, Math.max(0, input.discountBps ?? 1500));
  const annual = toDollar((annualised * (10000 - discount)) / 10000);
  // At least one visit: a contract quoting zero visits because the trailing
  // work was all parts is a contract nobody signs. Parts are NOT floored the
  // same way - a client who has bought no parts should be offered no allowance
  // rather than a made-up one, which is the whole point of this change.
  const visitsPerYear = Math.max(1, Math.round(perYear(u.visits)));
  const partsAllowanceCents = toDollar(perYear(u.partsCents));
  const parts = partsAllowanceCents > 0
    ? ` plus ${formatCents(partsAllowanceCents)} of parts`
    : "";
  return {
    annualCents: annual,
    trailingAnnualCents: annualised,
    savingCents: annualised - annual,
    visitsPerYear,
    partsAllowanceCents,
    line: `Their own pace over ${u.months} months: ${visitsPerYear} visit${visitsPerYear === 1 ? "" : "s"}`
      + `${parts} a year, against ${formatCents(annualised)} of time and materials. `
      + `A contract covering that at ${formatCents(annual)} - ${(discount / 100).toFixed(0)}% off.`,
  };
}

/**
 * Why there is no proposal, said to the person looking at the card.
 *
 * "Not enough history" with nothing after it reads as a bug. Which of the two
 * thresholds is short, and by how much, is the difference between "wait" and
 * "this client is not really a client".
 */
export function paceShortfall(u: TrailingUsage): string | null {
  if (hasPace(u)) return null;
  const short: string[] = [];
  if (u.invoices < PACE_MIN_INVOICES) {
    short.push(`${u.invoices} invoice${u.invoices === 1 ? "" : "s"}`);
  }
  if (u.months < PACE_MIN_MONTHS) {
    short.push(u.months === 0 ? "under a month of history" : `${u.months} month${u.months === 1 ? "" : "s"} of history`);
  }
  return `Too little to price a contract off - ${short.join(", ")}.`;
}
