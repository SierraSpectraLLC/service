// What a client asking for maintenance turns into.
//
// Reporting a fault and asking for upkeep arrive from the same button and differ
// in one way that matters: a fault is news, a request is a date. The rules worth
// being sure about are here - which horizon was asked for, when the resulting
// work is due, and what the calendar already says - so they are pure and tested
// rather than buried in the action that writes the rows.
//
// What is deliberately NOT here: advancing a cadence. Completing the task a
// request files leaves every schedule where it was. A client asking for a PM
// must not be able to move a contract's maintenance calendar; pulling the real
// schedule forward stays an engineer's press.
import { addDays } from "@/lib/pm";

/**
 * The days a client will have somebody on site.
 *
 * A PREFERENCE, not a booking, and the shape is the point: "we are covered
 * Mondays and Wednesdays" is a standing fact about how a lab runs, and it is
 * both easier to answer and more useful to schedule against than a single
 * date somebody guessed at. It leaves the shop free to route a van the way it
 * routes vans, which a named day does not.
 *
 * Monday to Friday only. Weekend work is an exception a client should ask for
 * in words, where the shop can price it and answer; a seventh checkbox beside
 * the other six would imply it is routine.
 *
 * Numbered the way JavaScript numbers weekdays (0 = Sunday), so the arithmetic
 * below needs no translation table.
 */
export const WEEKDAYS = [
  { key: 1, short: "Mon", label: "Monday" },
  { key: 2, short: "Tue", label: "Tuesday" },
  { key: 3, short: "Wed", label: "Wednesday" },
  { key: 4, short: "Thu", label: "Thursday" },
  { key: 5, short: "Fri", label: "Friday" },
] as const;

/** Whatever arrived off the wire, as a sorted set of days actually offered. */
export function cleanDays(days: readonly number[] | undefined): number[] {
  const offered = new Set<number>(WEEKDAYS.map((d) => d.key));
  return [...new Set((days ?? []).filter((n) => offered.has(n)))].sort((a, b) => a - b);
}

/** The weekday an ISO day falls on. 0 = Sunday, as Date has it. */
const dayOfWeek = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/**
 * The preference in words: "Mon, Wed or Thu". "" when they named none, which
 * is the ordinary case and reads as no constraint rather than as no answer.
 */
export function daysLabel(days: readonly number[] | undefined): string {
  const want = cleanDays(days).map((k) => WEEKDAYS.find((d) => d.key === k)!.short);
  if (want.length <= 1) return want[0] ?? "";
  return `${want.slice(0, -1).join(", ")} or ${want[want.length - 1]}`;
}

/**
 * What a client is asking somebody to come out and DO.
 *
 * Both are planned work with a date on them - neither is an emergency, which
 * is what the severity choices on a fault report are for. They differ in one
 * consequence: asking for maintenance says upkeep is owed, and the system's
 * board should say so; asking for service work says nothing about the
 * maintenance calendar at all.
 */
export const VISIT_KINDS = [
  { key: "pm", label: "Maintenance", hint: "The planned service, nothing is wrong." },
  { key: "service", label: "Service work", hint: "Something to do that is not upkeep." },
] as const;

export type VisitKind = (typeof VISIT_KINDS)[number]["key"];

/** An unrecognized kind is maintenance - the ask this flow was built for. */
export const visitKind = (k: string): VisitKind => (k === "service" ? "service" : "pm");

export const PM_WINDOWS = [
  { key: "now", label: "As soon as you can", days: 0 },
  { key: "month", label: "Within a month", days: 30 },
  { key: "visit", label: "At the next planned visit", days: 90 },
] as const;

export type PmWindow = (typeof PM_WINDOWS)[number];

/**
 * The horizon that was asked for. An unrecognized value falls to a month rather
 * than to "now": a request that arrives with a broken form should not read as an
 * emergency, and should not read as a year away either.
 */
export function pmWindow(key: string): PmWindow {
  return PM_WINDOWS.find((w) => w.key === key) ?? PM_WINDOWS[1];
}

/**
 * When the work the request files is due.
 *
 * The horizon, then FORWARD to the first day they said suits them. Forward
 * rather than to the nearest, because backward is the past: "as soon as you
 * can" on a Friday, from a lab covered Mondays and Wednesdays, means Monday -
 * not last Wednesday. At most six days past the horizon, which is the cost of
 * honouring the preference at all and is a great deal cheaper than a van
 * arriving on a day nobody can let it in.
 *
 * No preference leaves the horizon exactly where it was, which is what every
 * request filed before this existed still gets.
 */
export function pmRequestDue(today: string, key: string, days?: readonly number[]): string {
  const horizon = addDays(today, pmWindow(key).days);
  const want = cleanDays(days);
  if (!want.length) return horizon;
  let day = horizon;
  // Bounded by the week: WEEKDAYS is never empty, so one of the next seven
  // days is always in the set and this cannot run away.
  for (let i = 0; i < 7; i++) {
    if (want.includes(dayOfWeek(day))) return day;
    day = addDays(day, 1);
  }
  return horizon;
}

/**
 * What was asked for, in the words that go on the record - the task body, the
 * discussion post, the audit line and the email, so the four cannot describe
 * one request four ways.
 */
export function askLabel(key: string, days?: readonly number[]): string {
  const horizon = pmWindow(key).label.toLowerCase();
  const want = daysLabel(days);
  return want ? `${horizon}, prefers ${want}` : horizon;
}

/** The title staff read in a task list. The note leads, because it's the ask. */
export function pmRequestTitle(note: string, kind: string = "pm"): string {
  const what = visitKind(kind) === "service" ? "Service" : "Maintenance";
  const first = note.trim().split("\n")[0].trim();
  return first ? `${what} requested: ${first.slice(0, 120)}` : `${what} requested`;
}

export type SchedRow = { title: string; nextDue: string; paused: boolean };

/**
 * The next maintenance already on the calendar for this system, soonest first,
 * paused schedules ignored - they are not going to happen on their own. Told to
 * the client so a request isn't made blind, and put on the task so whoever picks
 * it up can see whether pulling a real schedule forward is the better answer.
 */
export function nextScheduled<T extends SchedRow>(schedules: T[], today: string): { row: T; overdue: boolean } | null {
  const live = schedules.filter((s) => !s.paused);
  if (!live.length) return null;
  const row = [...live].sort((a, b) => a.nextDue.localeCompare(b.nextDue) || a.title.localeCompare(b.title))[0];
  return { row, overdue: row.nextDue <= today };
}

/** One line about the calendar, for a task body or an email. "" when there is none. */
export function scheduleLine(schedules: SchedRow[], today: string): string {
  const next = nextScheduled(schedules, today);
  if (!next) return "";
  return next.overdue
    ? `Scheduled maintenance "${next.row.title}" is already due (${next.row.nextDue}).`
    : `Next scheduled maintenance: "${next.row.title}" on ${next.row.nextDue}.`;
}
