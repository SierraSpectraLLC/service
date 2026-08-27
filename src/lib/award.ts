// A multi-year award, and the one question it exists to answer: what has to be
// decided, and by when.
//
// The base year is committed. Everything after it is an OPTION - priced, agreed,
// and not yet bought - and each one has a day by which the client must say. That
// day is the whole problem. A shop that files five contracts and gets on with
// the work finds out it has lost option year two by noticing the money stopped
// in October, which is both too late to ask and the worst possible moment to
// discover it.
//
// So the vocabulary here is not the vocabulary of a contract. An ordinary
// agreement is active, expiring or expired - a story about dates. A period of an
// award is also waiting on a DECISION, and the two are independent: a period can
// be agreed and not started, or unstarted and already lost. lib/agreements'
// standing() cannot say either, because it sees one row and this needs to know
// which period of what.
//
// Pure. Callers hand in the rows.

import { addDays } from "@/lib/pm";
import { standing, type Standing } from "@/lib/agreements";
import type { Tone } from "@/lib/tones";

/** One period of an award, as much of an agreement row as the rules need. */
export type PeriodLike = {
  periodIndex: number;
  status: string;
  startsOn: string;
  endsOn: string;
  renewNoticeDays: number;
  billAmountCents: number;
  valueCents: number | null;
};

export type AwardLike = {
  awardedOn: string;
  optionNoticeDays: number;
};

/**
 * Where one period stands.
 *
 * Five words, and the two new ones are the point:
 *
 *   running    in force today - the ordinary active/expiring/expired story
 *   option     priced, not exercised, and still can be
 *   lapsed     the moment to exercise it went by and nobody did
 *   taken      exercised, not started yet
 *   declined   somebody said no, on purpose
 *
 * LAPSED is the one worth the money. It is not a status anybody sets - it is
 * what an unexercised option becomes when its start date passes, and the whole
 * reason this module exists is so that it can be seen coming rather than
 * discovered afterwards.
 */
export const PERIOD_STANDINGS = ["running", "taken", "option", "lapsed", "declined", "over"] as const;
export type PeriodStanding = (typeof PERIOD_STANDINGS)[number];

export const PERIOD_LABEL: Record<PeriodStanding, string> = {
  running: "In force",
  taken: "Exercised",
  option: "Option",
  lapsed: "Lapsed",
  declined: "Declined",
  over: "Finished",
};

export const PERIOD_TONE: Record<PeriodStanding, Tone> = {
  running: "good",
  taken: "info",
  option: "warn",
  lapsed: "bad",
  declined: "faint",
  over: "faint",
};

/**
 * The word for a standing, which is not the same word for the base year.
 *
 * "Exercised" is wrong for period 0 and wrong in a way somebody will query: the
 * base year was never an option, so nobody exercised it. It was committed the
 * day the award was signed, and between then and its start date that is exactly
 * what it is. Every other standing reads the same whichever period it is.
 */
export function standingWord(s: PeriodStanding, periodIndex: number): string {
  if (periodIndex === 0 && s === "taken") return "Committed";
  return PERIOD_LABEL[s];
}

export function periodStanding(p: PeriodLike, today: string): PeriodStanding {
  if (p.status === "cancelled") return "declined";
  if (p.status === "draft") {
    // An option whose start has arrived unexercised is gone. Not "still
    // available, a bit late" - the client's window to take it has closed, and
    // saying anything softer here is how it stays on a list being ignored.
    return p.startsOn && p.startsOn <= today ? "lapsed" : "option";
  }
  // Exercised, but its term has not begun.
  if (p.startsOn && p.startsOn > today) return "taken";
  const s: Standing = standing(p, today);
  return s === "expired" ? "over" : "running";
}

/**
 * The last day the client can exercise this period.
 *
 * Its start, less the award's notice. Blank when the period has no start date,
 * because a deadline computed from nothing is a deadline that will be wrong.
 */
export function optionDeadline(p: Pick<PeriodLike, "startsOn">, award: AwardLike): string {
  if (!p.startsOn) return "";
  return addDays(p.startsOn, -Math.max(0, award.optionNoticeDays));
}

/** Days until that deadline. Negative once it has gone by; null when there isn't one. */
export function daysToDecide(p: PeriodLike, award: AwardLike, today: string): number | null {
  const day = optionDeadline(p, award);
  if (!day) return null;
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** What one period is worth: what it bills, or what somebody wrote down. */
export const periodValue = (p: PeriodLike): number =>
  p.billAmountCents > 0 ? p.billAmountCents : (p.valueCents ?? 0);

/**
 * The award's whole value, and the part of it that is only an option.
 *
 * Both, always, and never just the total. "A $362,000 award" is the number
 * everybody repeats and it is four fifths a hope: $68,000 is committed and the
 * rest is a series of decisions somebody else makes, one a year. A forecast
 * built on the total is a forecast of somebody else's intentions.
 */
export function awardValue(periods: PeriodLike[], today: string): {
  totalCents: number; committedCents: number; optionCents: number; lostCents: number;
} {
  let totalCents = 0, committedCents = 0, optionCents = 0, lostCents = 0;
  for (const p of periods) {
    const v = periodValue(p);
    const s = periodStanding(p, today);
    totalCents += v;
    if (s === "running" || s === "taken" || s === "over") committedCents += v;
    else if (s === "option") optionCents += v;
    else lostCents += v;   // lapsed or declined
  }
  return { totalCents, committedCents, optionCents, lostCents };
}

/**
 * The periods that need deciding, soonest first.
 *
 * `within` is how far ahead to look BEYOND the notice period - a shop wants to
 * be talking about an option before the last legal day to raise it, not on it.
 * Anything already lapsed is included whatever the window says: it is the most
 * urgent conversation on the list and the one nobody is having.
 */
export function decisionsDue(
  periods: PeriodLike[], award: AwardLike, today: string, within = 30,
): { period: PeriodLike; standing: PeriodStanding; days: number | null }[] {
  return periods
    .map((period) => ({ period, standing: periodStanding(period, today), days: daysToDecide(period, award, today) }))
    .filter((r) => r.standing === "lapsed" || (r.standing === "option" && r.days !== null && r.days <= within))
    .sort((a, b) => (a.days ?? 0) - (b.days ?? 0) || a.period.periodIndex - b.period.periodIndex);
}

/** Everything stopping this period being exercised. Empty means go ahead. */
export function exerciseProblems(p: PeriodLike, today: string): string[] {
  const s = periodStanding(p, today);
  if (s === "option") return [];
  if (s === "lapsed") {
    // Not refused: a client CAN come back late, and a shop that cannot record
    // that has to lie in its own records. But it is said plainly, because
    // exercising a period whose start has passed means back-billing a term
    // that has already partly run.
    return [`Its term began ${p.startsOn} - exercising now back-dates the period.`];
  }
  return [`Already ${PERIOD_LABEL[s].toLowerCase()}.`];
}

/**
 * The sentence a person reads about an award.
 *
 * Deliberately leads with what is DECIDED, then what is not. See awardValue.
 */
export function awardLine(periods: PeriodLike[], award: AwardLike, today: string, fmt: (c: number) => string): string {
  if (periods.length === 0) return "";
  const v = awardValue(periods, today);
  const due = decisionsDue(periods, award, today);
  const parts = [`${periods.length} period${periods.length === 1 ? "" : "s"}`];
  parts.push(`${fmt(v.committedCents)} committed`);
  if (v.optionCents > 0) parts.push(`${fmt(v.optionCents)} still optional`);
  if (v.lostCents > 0) parts.push(`${fmt(v.lostCents)} not taken`);
  const line = `${parts.join(", ")}.`;
  if (!due.length) return line;
  const next = due[0];
  return next.standing === "lapsed"
    ? `${line} Option year ${next.period.periodIndex} lapsed on ${optionDeadline(next.period, award)}.`
    : `${line} Option year ${next.period.periodIndex} must be decided by `
      + `${optionDeadline(next.period, award)}${next.days !== null ? ` - ${next.days} days` : ""}.`;
}
