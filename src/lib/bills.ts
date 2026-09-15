// Standing overhead bills, as arithmetic on dates.
//
// "I want to see the insurance, the benefits, the phone line - what we pay
// every month to exist - on the money side, know when each is due, and get
// to the place I pay it in one click." That is three things and this file is
// the first: WHEN a bill falls due, and what one is fit to store. lib/billRun
// is what a due cycle turns into (an overhead expense), and the schema note
// on `bills` is why it is neither a stipend nor a purchase order.
//
// The schedule is lib/stipends', without a copy. A bill and a stipend are the
// same shape - an amount, a cadence, a day, a window, a never-twice cursor -
// and that module already knows the 31st clamps to the 28th in February and
// that an unbounded walk on a corrupt date is a hung request. What is here is
// only what a bill has and a stipend does not: a calendar window ("what comes
// due in the next fourteen days", which a stipend never asks because a
// stipend is paid by the pass and never by a person), and the words.
//
// Everything is pure. Every date is a YYYY-MM-DD string.

import { addDays, isDay } from "@/lib/recurring";
import {
  type StipendTerms, cadenceOf, dueStipendCycles, nextStipendCycle, scheduleWalk, stipendLive,
  stipendCadenceLabel, stipendDescription, monthlyEquivalentCents,
} from "@/lib/stipends";

/** A bill's schedule is a stipend's schedule. One type, one walker. */
export type BillTerms = StipendTerms;

/** Is this bill actually set up to post anything? */
export const billLive = stipendLive;

/** The cycles a bill owes the ledger and has not posted, oldest first. See dueStipendCycles. */
export const dueBillCycles = dueStipendCycles;

/** When the pass next posts it. "" = never again. See nextStipendCycle. */
export const nextBillCycle = nextStipendCycle;

/** "monthly, on the 15th" - see stipendCadenceLabel. */
export const billCadence = stipendCadenceLabel;

/** What one bill costs in an average month. See monthlyEquivalentCents. */
export const billMonthlyCents = monthlyEquivalentCents;

/**
 * What the ledger row says: "Liability policy - September 2026", or with the
 * day for a weekly one. The stipend rule, because it is the same problem: a
 * monthly bill is named by its month and a weekly one has to be told apart
 * from its neighbours.
 */
export const billDescription = stipendDescription;

/** How many cycles a calendar walk may return. A year of weekly bills, with room. */
const WINDOW_CAP = 60;

/**
 * The cycles that fall inside [from, to], whether or not they have posted.
 *
 * A CALENDAR question, not a cursor question - which is why it does not go
 * through dueBillCycles. "What comes due this month" wants the 15th whether
 * the pass has already posted it or not, because the owner asking is about
 * to pay it; the never-twice cursor is the pass's concern and none of theirs.
 *
 * Bounded by the bill's own window and by WINDOW_CAP; a corrupt start date
 * cannot spin.
 */
export function billCyclesBetween(b: BillTerms, from: string, to: string): string[] {
  if (!billLive(b) || !isDay(from) || !isDay(to) || !isDay(b.startsOn) || to < from) return [];
  const { first, step } = scheduleWalk(b);
  if (!first) return [];
  const out: string[] = [];
  let cursor = first;
  for (let i = 0; i < 720 && out.length < WINDOW_CAP; i++) {
    if (cursor > to) break;
    if (b.endsOn && isDay(b.endsOn) && cursor > b.endsOn) break;
    if (cursor >= from) out.push(cursor);
    const next = step(cursor);
    if (!next || next <= cursor) break;
    cursor = next;
  }
  return out;
}

/** What a set of bills comes to inside a window - the rail's figure. */
export function billsDueBetween<T extends BillTerms>(
  bills: T[], from: string, to: string,
): { cents: number; cycles: { bill: T; on: string }[] } {
  const cycles = bills.flatMap((bill) => billCyclesBetween(bill, from, to).map((on) => ({ bill, on })))
    .sort((a, b) => a.on.localeCompare(b.on));
  return { cents: cycles.reduce((n, c) => n + c.bill.amountCents, 0), cycles };
}

/** How far ahead "coming due" looks on the overview and the desk. */
export const DUE_SOON_DAYS = 14;

/** The cycles landing in the next DUE_SOON_DAYS days, today included. */
export function billsDueSoon<T extends BillTerms>(bills: T[], today: string, days = DUE_SOON_DAYS) {
  return billsDueBetween(bills, today, addDays(today, days));
}

/**
 * The last day of the month a day falls in, for "due this month".
 *
 * Its own three lines rather than a dependency on lib/finance, whose
 * periodStart answers the other end and whose month arithmetic this would
 * only half use.
 */
export function endOfMonth(day: string): string {
  if (!isDay(day)) return "";
  const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${day.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

/**
 * A bill fit to store, or the first thing wrong with it.
 *
 * Checked here so the form can grey its own button on the rule the action
 * refuses on. A person is OPTIONAL, which is the one place this parts from
 * checkStipend: most bills are the company's, and a benefit names whose it
 * is. A zero amount is refused for the stipend's reason - a live arrangement
 * posting nothing every month is not a thing anybody means to set up.
 */
export function checkBill(draft: {
  name: string; amountCents: number;
  cadence?: string; everyMonths: number; dayOfMonth: number;
  everyWeeks?: number; weekday?: number;
  startsOn: string; endsOn: string; portalUrl?: string;
}): string | null {
  if (!draft.name.trim()) return "Name it - \"Liability policy\"";
  if (!(draft.amountCents > 0)) return "Enter an amount like 412.00";
  if (cadenceOf(draft.cadence) === "weeks") {
    const every = Math.round(draft.everyWeeks ?? 0);
    if (every < 1 || every > 52) return "Bill it every 1 to 52 weeks";
    const day = Math.round(draft.weekday ?? -1);
    if (day < 0 || day > 6) return "Pick the day of the week it lands on";
  } else {
    if (draft.everyMonths < 1 || draft.everyMonths > 12) return "Bill it every 1 to 12 months";
    if (draft.dayOfMonth < 1 || draft.dayOfMonth > 31) return "Pick a day of the month between 1 and 31";
  }
  if (!isDay(draft.startsOn)) return "Pick the day it starts";
  if (draft.endsOn && !isDay(draft.endsOn)) return "That end date is not a date";
  if (draft.endsOn && draft.endsOn < draft.startsOn) return "It cannot end before it starts";
  const url = (draft.portalUrl ?? "").trim();
  if (url && !/^https?:\/\//i.test(url)) return "The portal link needs to start with https://";
  return null;
}

/**
 * "autopay" or "pay it" - what there is to do on the day.
 *
 * One function so the desk, the overview and the person file cannot describe
 * the same bill three ways. A bill with a portal and no autopay is the one
 * somebody has to act on; the link is the action.
 */
export function billAction(b: { autopay: boolean; portalUrl: string }): "autopay" | "pay" | "note" {
  if (b.autopay) return "autopay";
  return b.portalUrl ? "pay" : "note";
}
