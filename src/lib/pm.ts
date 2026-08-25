// Preventive-maintenance cadence math. Pure and tested, because the whole
// feature is one rule applied on two sides - "is this schedule due today?"
// when generating, "when is it due next?" when a task completes - and a
// mistake in either direction is maintenance silently skipped or a shop
// nagged for work it just did.
//
// Dates are YYYY-MM-DD strings in shop time throughout (see lib/shopday), so
// the arithmetic here goes through UTC epoch days and never touches the
// runtime timezone.

export const PM_MIN_DAYS = 1;
export const PM_MAX_DAYS = 3650; // ten years; past that it's not a schedule

export const isIsoDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** `iso` plus `days`, calendar-correct across month ends and leap years. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Due means due-or-overdue: a missed day must not un-schedule the work. */
export const isDue = (nextDue: string, today: string) => nextDue <= today;

/**
 * Where the schedule lands after the work is done: `everyDays` after the day
 * it was actually completed, not after the day it was planned. Doing a
 * 90-day flush 10 days late doesn't owe the shop the next one 10 days early.
 */
export const advance = (doneDay: string, everyDays: number) => addDays(doneDay, everyDays);

/** "every 90 days", "weekly", "monthly" - the label for a cadence. */
export function cadenceLabel(everyDays: number): string {
  if (everyDays === 1) return "daily";
  if (everyDays === 7) return "weekly";
  if (everyDays === 14) return "every 2 weeks";
  if (everyDays === 30) return "monthly";
  if (everyDays === 90) return "quarterly";
  if (everyDays === 180) return "every 6 months";
  if (everyDays === 365) return "yearly";
  return `every ${everyDays} days`;
}

/** Validated cadence or an error message; whitespace and floats rejected. */
export function parseCadence(raw: string | number): { days: number } | { error: string } {
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < PM_MIN_DAYS || n > PM_MAX_DAYS) {
    return { error: `Cadence must be a whole number of days between ${PM_MIN_DAYS} and ${PM_MAX_DAYS}` };
  }
  return { days: n };
}

/**
 * What a schedule's status pill should say, appointment included.
 *
 * The appointment answers the complaint a due date cannot: the client asked
 * for a specific day, so until that day the row is INFORMATION ("booked
 * 9/12"), not a nag - and the truth is preserved, because nextDue still says
 * when the cycle actually fell due. A booked day that passes unworked turns
 * back into the loudest state of all, wearing the missed date, since a missed
 * appointment is worse than a missed cycle.
 */
export type PmStanding =
  | { kind: "paused" }
  | { kind: "booked"; on: string }
  | { kind: "missed"; on: string }
  | { kind: "overdue"; since: string }
  | { kind: "dueToday" }
  | { kind: "upcoming"; on: string };

export function pmStanding(
  s: { paused: boolean; nextDue: string; bookedOn?: string },
  today: string,
): PmStanding {
  if (s.paused) return { kind: "paused" };
  const booked = (s.bookedOn ?? "").trim();
  if (booked) {
    return booked >= today ? { kind: "booked", on: booked } : { kind: "missed", on: booked };
  }
  if (s.nextDue < today) return { kind: "overdue", since: s.nextDue };
  if (s.nextDue === today) return { kind: "dueToday" };
  return { kind: "upcoming", on: s.nextDue };
}
