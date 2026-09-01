// Standing reimbursements, as arithmetic on dates.
//
// "I pay one engineer $35 a month for their internet. I want that reimbursed
// automatically, and not through a payroll check." That sentence has three
// parts and this file is the first: WHEN a stipend is owed. lib/stipendRun is
// what it turns into, and the schema note on `stipends` is why it is a
// reimbursement rather than a wage line.
//
// The date arithmetic is lib/recurring's, deliberately and without a copy. A
// retainer and a stipend are the same shape - an amount, a cadence, a day of
// the month, a window - and that module already knows that the 31st clamps to
// the 28th in February, that a cycle date is a UTC-noon-anchored string, and
// that an unbounded walk on a corrupt date is a hung request. Re-deriving any
// of that here would be a second thing to get wrong.
//
// Everything is pure. Every date is a YYYY-MM-DD string.

import {
  addMonths, addWeeks, alignWeekday, cycleDay, firstCycle, isDay, weekdayOf,
} from "@/lib/recurring";

/**
 * The two shapes a schedule can be.
 *
 * "months" was the only one, and stays the default, so every arrangement that
 * existed before the column keeps behaving exactly as it did. "weeks" arrived
 * because a month is not the only thing that recurs - "weekly parking",
 * "every other Friday" - and no amount of day-of-month arithmetic expresses a
 * weekday. They are two shapes rather than one general one because a monthly
 * cycle CLAMPS (the 31st is the 28th in February) and a weekly cycle STEPS,
 * and pretending those are the same operation is how the 31st ends up in March.
 */
export const CADENCES = ["months", "weeks"] as const;
export type Cadence = (typeof CADENCES)[number];
export const cadenceOf = (v: unknown): Cadence => (v === "weeks" ? "weeks" : "months");

/**
 * The last day of the month, as a day-of-month.
 *
 * Not a magic number and not a fourth column: cycleDay clamps to the month's
 * own length, so 31 lands on the 30th in April and the 28th in February - in
 * every month, exactly. The shop asked for "1st of the month, last, specific
 * day" and the last was already expressible; what it was missing was a name,
 * so the form could offer it instead of expecting somebody to know that
 * typing 31 means something other than the 31st.
 */
export const LAST_DAY = 31;

/**
 * How many steps any walk may take before giving up.
 *
 * Sixty years of monthly cycles, and about five of weekly ones. Both are far
 * past any real arrangement, and the point is only that a corrupt start date
 * cannot spin a request forever.
 */
const WALK_CAP = 720;

export const WEEKDAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

export type StipendTerms = {
  amountCents: number;
  /** "months" | "weeks". Anything else reads as months - see cadenceOf. */
  cadence?: string;
  everyMonths: number;
  dayOfMonth: number;
  everyWeeks?: number;
  /** 0 = Sunday, matching getUTCDay(). */
  weekday?: number;
  startsOn: string;
  /** Blank = runs until somebody stops it. */
  endsOn: string;
  active: boolean;
  /** The last cycle actually raised. Blank = none yet. */
  lastOn: string;
};

/**
 * The two halves of the walk, resolved once.
 *
 * Every function below needs the same three answers - where the first cycle
 * is, how to step to the next one, and whether the schedule is even coherent -
 * and asking them in three places is how a monthly rule and a weekly rule
 * drift apart. `first` is blank when the terms cannot produce a cycle at all,
 * which every caller already treats as "nothing is due".
 */
function walk(s: StipendTerms): { first: string; step: (iso: string) => string } {
  if (cadenceOf(s.cadence) === "weeks") {
    const every = Math.max(1, Math.round(s.everyWeeks ?? 1));
    const day = Math.round(s.weekday ?? weekdayOf(s.startsOn));
    return {
      first: alignWeekday(s.startsOn, day < 0 ? 1 : day),
      step: (iso) => addWeeks(iso, every),
    };
  }
  const every = Math.max(1, Math.round(s.everyMonths));
  return {
    first: firstCycle(s.startsOn, s.dayOfMonth),
    step: (iso) => addMonths(iso, every, s.dayOfMonth),
  };
}

/** Is this arrangement actually set up to pay anybody? */
export const stipendLive = (
  s: Pick<StipendTerms, "amountCents" | "everyMonths" | "everyWeeks" | "cadence" | "active">,
): boolean =>
  s.active && s.amountCents > 0
  && (cadenceOf(s.cadence) === "weeks"
    ? Math.round(s.everyWeeks ?? 1) > 0
    : s.everyMonths > 0);

/**
 * The cycles a stipend owes and has not raised, oldest first.
 *
 * Three disciplines, and the middle one is the whole reason a cron can be
 * trusted with money:
 *
 *   IT NEVER PAYS TWICE. Everything at or before lastOn is already money that
 *   went out. A pass that runs twice - or a catch-up overlapping a normal
 *   run - produces an empty list the second time, by construction.
 *
 *   IT CATCHES UP. A pass that did not run for six weeks raises what it
 *   missed. An engineer should not be out of pocket because a cron job had a
 *   bad Tuesday.
 *
 *   IT IS BOUNDED. `cap` is the number of cycles one call may return, so a
 *   stipend misconfigured to start in 2014 cannot raise a hundred and thirty
 *   rows in one overnight pass. The rest come on the following days, which is
 *   slow enough for somebody to notice and stop it.
 *
 * A stipend with no lastOn starts at its FIRST cycle rather than at today, so
 * one set up on the 3rd with a start date of the 1st pays this month. That is
 * the honest reading of "starting this month", and the alternative - opening
 * at the next unstarted cycle the way a retainer does - would silently skip
 * the month the owner was thinking about when they typed it.
 */
export function dueStipendCycles(s: StipendTerms, today: string, cap = 6): string[] {
  if (!stipendLive(s) || !isDay(today) || !isDay(s.startsOn)) return [];
  const { first, step } = walk(s);
  if (!first) return [];

  let cursor = first;
  // Skip straight past everything already paid, without emitting it.
  if (s.lastOn && isDay(s.lastOn)) {
    // Bounded for the same reason lib/recurring bounds its walk: a corrupt
    // date must not spin. WALK_CAP is sixty years of monthly cycles and about
    // five of weekly ones, both far past any real arrangement.
    for (let i = 0; i < WALK_CAP && cursor <= s.lastOn; i++) {
      const next = step(cursor);
      if (!next || next <= cursor) return [];
      cursor = next;
    }
    if (cursor <= s.lastOn) return [];
  }

  const out: string[] = [];
  for (let i = 0; i < WALK_CAP && out.length < cap; i++) {
    if (cursor > today) break;
    if (s.endsOn && isDay(s.endsOn) && cursor > s.endsOn) break;
    out.push(cursor);
    const next = step(cursor);
    if (!next || next <= cursor) break;
    cursor = next;
  }
  return out;
}

/**
 * When this stipend next pays, for the row on the roster. "" = never again.
 *
 * Which means the next cycle THE PASS WILL RAISE, not the next one on the
 * calendar - and when a stipend is behind those are different dates. An
 * arrangement set up in June and first run in August owes June, July and
 * August; the honest answer to "when does this next pay" is June, because that
 * is the row that appears on the next run. Saying September would show an
 * owner a date in the future for money that is already overdue.
 *
 * So the answer comes from dueStipendCycles when anything is owed, and only
 * walks forward when nothing is. One authority, so the roster and the pass
 * cannot disagree.
 */
export function nextStipendCycle(s: StipendTerms, today: string): string {
  if (!stipendLive(s) || !isDay(s.startsOn)) return "";
  const due = dueStipendCycles(s, today, 1);
  if (due.length) return due[0];

  const { first, step } = walk(s);
  let cursor = first;
  if (!cursor) return "";
  const paidTo = s.lastOn && isDay(s.lastOn) ? s.lastOn : "";
  // Nothing is owed, so the next cycle is the first one past both today and
  // everything already raised. Bounded, for the reason lib/recurring bounds
  // its own walk: a corrupt date must not spin a request.
  for (let i = 0; i < WALK_CAP; i++) {
    if (cursor > today && (!paidTo || cursor > paidTo)) break;
    const next = step(cursor);
    if (!next || next <= cursor) return "";
    cursor = next;
  }
  if (s.endsOn && isDay(s.endsOn) && cursor > s.endsOn) return "";
  return cursor;
}

/**
 * The month a cycle belongs to, as the perks report is titled.
 *
 * One report per person per month, named for the month rather than the cycle
 * date, because that is how somebody looks for it: "what did we pay Owen in
 * perks in August". The pass matches on this to add a second stipend to the
 * same claim rather than opening a second one.
 */
export const perksMonth = (cycle: string): string => cycle.slice(0, 7);

export function perksTitle(cycle: string): string {
  const month = perksMonth(cycle);
  if (!/^\d{4}-\d{2}$/.test(month)) return "General perks";
  const d = new Date(`${month}-01T12:00:00Z`);
  return `General perks - ${d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}`;
}

/**
 * What a stipend row says on the claim: "Internet stipend - August 2026".
 *
 * A MONTHLY arrangement raises one row a month, so the month names it exactly.
 * A WEEKLY one raises four or five, and naming them all for the month would
 * put four identical lines on one claim - which reads as a duplicate to the
 * person approving it, and is the fastest way to have real money queried or
 * refused. So a weekly row carries its own date.
 *
 * The claim they land on is still the month's: see perksTitle. Grouping by
 * month is right - "what did we pay Owen in perks in August" is the question -
 * and it is the LINES that have to be told apart, not the claims.
 */
export function stipendDescription(label: string, cycle: string, cadence?: string): string {
  const name = label.trim() || "Stipend";
  if (cadenceOf(cadence) === "weeks") {
    if (!isDay(cycle)) return name;
    const d = new Date(`${cycle}T12:00:00Z`);
    return `${name} - ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
  }
  const month = perksMonth(cycle);
  if (!/^\d{4}-\d{2}$/.test(month)) return name;
  const d = new Date(`${month}-01T12:00:00Z`);
  return `${name} - ${d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}`;
}

/** The provenance marker on a report the pass assembled. See the schema note. */
export const STIPEND_SOURCE = "stipend";

/**
 * A stipend fit to store, or the first thing wrong with it.
 *
 * Checked here so the form can grey its own button on the rule the action
 * refuses on. A zero amount is the interesting one: it would be a live
 * arrangement that pays nothing every month forever, which is not a thing
 * anybody means to create.
 */
export function checkStipend(draft: {
  person: string; label: string; amountCents: number;
  cadence?: string; everyMonths: number; dayOfMonth: number;
  everyWeeks?: number; weekday?: number;
  startsOn: string; endsOn: string;
}): string | null {
  if (!draft.person.trim()) return "Pick who it is for";
  if (!draft.label.trim()) return "Name it - \"Internet stipend\"";
  if (!(draft.amountCents > 0)) return "Enter an amount like 35.00";
  if (cadenceOf(draft.cadence) === "weeks") {
    const every = Math.round(draft.everyWeeks ?? 0);
    if (every < 1 || every > 52) return "Pay it every 1 to 52 weeks";
    const day = Math.round(draft.weekday ?? -1);
    if (day < 0 || day > 6) return "Pick the day of the week it lands on";
  } else {
    if (draft.everyMonths < 1 || draft.everyMonths > 12) return "Pay it every 1 to 12 months";
    if (draft.dayOfMonth < 1 || draft.dayOfMonth > 31) return "Pick a day of the month between 1 and 31";
  }
  if (!isDay(draft.startsOn)) return "Pick the day it starts";
  if (draft.endsOn && !isDay(draft.endsOn)) return "That end date is not a date";
  if (draft.endsOn && draft.endsOn < draft.startsOn) return "It cannot end before it starts";
  return null;
}

/**
 * The first cycle a freshly-typed arrangement would pay, for the form's
 * preview.
 *
 * The preview is not decoration. "Every 2 weeks on Friday from the 3rd" is a
 * sentence somebody can misread in four ways, and the one thing that settles
 * it is the date it would actually land on - so the form shows that date
 * before anybody commits standing company money to it.
 */
export const previewFirstCycle = (
  startsOn: string, dayOfMonth: number,
  cadence: string = "months", weekday = 1,
): string => {
  if (!isDay(startsOn)) return "";
  return walk({
    amountCents: 1, active: true, lastOn: "", endsOn: "",
    startsOn, cadence, everyMonths: 1, dayOfMonth, everyWeeks: 1, weekday,
  }).first;
};

/**
 * "monthly", "every 2 weeks on Friday", "on the last day of the month" - how a
 * schedule reads in a row.
 *
 * One function so the roster, the audit line and the form's preview cannot
 * describe the same arrangement three different ways, which is what happens
 * when a cadence grows a second shape and each screen grows its own ternary.
 */
export function stipendCadenceLabel(s: {
  cadence?: string; everyMonths: number; dayOfMonth: number;
  everyWeeks?: number; weekday?: number;
}): string {
  if (cadenceOf(s.cadence) === "weeks") {
    const n = Math.max(1, Math.round(s.everyWeeks ?? 1));
    const day = WEEKDAY_NAMES[((Math.round(s.weekday ?? 1) % 7) + 7) % 7];
    return n === 1 ? `every ${day}`
      : n === 2 ? `every other ${day}`
      : `every ${n} weeks on ${day}`;
  }
  const n = Math.max(1, Math.round(s.everyMonths));
  const when = s.dayOfMonth >= LAST_DAY ? "on the last day"
    : s.dayOfMonth === 1 ? "on the 1st"
    : `on the ${ordinal(s.dayOfMonth)}`;
  const how = n === 1 ? "monthly" : n === 3 ? "quarterly" : n === 12 ? "yearly" : `every ${n} months`;
  return `${how}, ${when}`;
}

/**
 * What one arrangement costs in an average month, for the roster's total.
 *
 * A monthly $35 is $35 and a quarterly $90 is $30, which is the arithmetic
 * that was already here. A WEEKLY $12 is not $12: there are 52 weeks in a year
 * and not 48, so every-other-week works out at $26 a month, and the running
 * total said $12 the moment the first weekly arrangement was set up.
 *
 * An average rather than a calendar month, deliberately - some months carry
 * five Fridays and some four, and a "what do we spend on this" figure that
 * moved with the calendar would be worse than one that is honestly rounded.
 */
export function monthlyEquivalentCents(s: {
  cadence?: string; amountCents: number; everyMonths: number; everyWeeks?: number;
}): number {
  if (cadenceOf(s.cadence) === "weeks") {
    const every = Math.max(1, Math.round(s.everyWeeks ?? 1));
    return Math.round((s.amountCents * 52) / (every * 12));
  }
  return Math.round(s.amountCents / Math.max(1, Math.round(s.everyMonths)));
}

/** 1st, 2nd, 3rd, 4th - only ever used on a day of the month. */
function ordinal(n: number): string {
  const d = Math.round(n);
  const teen = d % 100 >= 11 && d % 100 <= 13;
  const suffix = teen ? "th" : d % 10 === 1 ? "st" : d % 10 === 2 ? "nd" : d % 10 === 3 ? "rd" : "th";
  return `${d}${suffix}`;
}

/** Re-exported so callers need one import for the whole schedule. */
export { cycleDay, isDay };
