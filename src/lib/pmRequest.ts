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
import { isDay } from "@/lib/calendarNotes";

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
 * A DAY THEY PICKED wins over the horizon, which is the point of letting them
 * pick one: "the 14th, we have the bay free" is a better thing for the shop to
 * schedule around than "within a month". A day already behind us is not
 * honoured - it would file work that is late the moment it exists - and falls
 * back to the horizon, which is the honest reading of a stale form.
 */
export function pmRequestDue(today: string, key: string, preferredOn?: string): string {
  const want = (preferredOn ?? "").trim();
  if (isDay(want) && want >= today) return want;
  return addDays(today, pmWindow(key).days);
}

/**
 * What was asked for, in the words that go on the record. The picked day when
 * there is one, because that is the ask - the horizon it fell inside is not.
 */
export function askLabel(key: string, preferredOn?: string, today = ""): string {
  const want = (preferredOn ?? "").trim();
  if (isDay(want) && (!today || want >= today)) return `asked for ${want}`;
  return pmWindow(key).label.toLowerCase();
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
