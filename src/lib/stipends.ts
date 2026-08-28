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

import { addMonths, cycleDay, firstCycle, isDay } from "@/lib/recurring";

export type StipendTerms = {
  amountCents: number;
  everyMonths: number;
  dayOfMonth: number;
  startsOn: string;
  /** Blank = runs until somebody stops it. */
  endsOn: string;
  active: boolean;
  /** The last cycle actually raised. Blank = none yet. */
  lastOn: string;
};

/** Is this arrangement actually set up to pay anybody? */
export const stipendLive = (s: Pick<StipendTerms, "amountCents" | "everyMonths" | "active">): boolean =>
  s.active && s.amountCents > 0 && s.everyMonths > 0;

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
  const every = Math.max(1, Math.round(s.everyMonths));
  const first = firstCycle(s.startsOn, s.dayOfMonth);
  if (!first) return [];

  let cursor = first;
  // Skip straight past everything already paid, without emitting it.
  if (s.lastOn && isDay(s.lastOn)) {
    // Bounded for the same reason lib/recurring bounds its walk: a corrupt
    // date must not spin. Sixty years of monthly cycles is far past any real
    // arrangement.
    for (let i = 0; i < 720 && cursor <= s.lastOn; i++) {
      const next = addMonths(cursor, every, s.dayOfMonth);
      if (!next || next <= cursor) return [];
      cursor = next;
    }
    if (cursor <= s.lastOn) return [];
  }

  const out: string[] = [];
  for (let i = 0; i < 720 && out.length < cap; i++) {
    if (cursor > today) break;
    if (s.endsOn && isDay(s.endsOn) && cursor > s.endsOn) break;
    out.push(cursor);
    const next = addMonths(cursor, every, s.dayOfMonth);
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

  const every = Math.max(1, Math.round(s.everyMonths));
  let cursor = firstCycle(s.startsOn, s.dayOfMonth);
  if (!cursor) return "";
  const paidTo = s.lastOn && isDay(s.lastOn) ? s.lastOn : "";
  // Nothing is owed, so the next cycle is the first one past both today and
  // everything already raised. Bounded, for the reason lib/recurring bounds
  // its own walk: a corrupt date must not spin a request.
  for (let i = 0; i < 720; i++) {
    if (cursor > today && (!paidTo || cursor > paidTo)) break;
    const next = addMonths(cursor, every, s.dayOfMonth);
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

/** What a stipend row says on the claim: "Internet stipend - August 2026". */
export function stipendDescription(label: string, cycle: string): string {
  const name = label.trim() || "Stipend";
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
  everyMonths: number; dayOfMonth: number; startsOn: string; endsOn: string;
}): string | null {
  if (!draft.person.trim()) return "Pick who it is for";
  if (!draft.label.trim()) return "Name it - \"Internet stipend\"";
  if (!(draft.amountCents > 0)) return "Enter an amount like 35.00";
  if (draft.everyMonths < 1 || draft.everyMonths > 12) return "Pay it every 1 to 12 months";
  if (draft.dayOfMonth < 1 || draft.dayOfMonth > 31) return "Pick a day of the month between 1 and 31";
  if (!isDay(draft.startsOn)) return "Pick the month it starts";
  if (draft.endsOn && !isDay(draft.endsOn)) return "That end date is not a date";
  if (draft.endsOn && draft.endsOn < draft.startsOn) return "It cannot end before it starts";
  return null;
}

/** The first cycle a freshly-typed stipend would pay, for the form's preview. */
export const previewFirstCycle = (startsOn: string, dayOfMonth: number): string =>
  isDay(startsOn) ? firstCycle(startsOn, dayOfMonth) : "";

/** Re-exported so callers need one import for the whole schedule. */
export { cycleDay, isDay };
