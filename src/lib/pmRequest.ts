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

/** When the work the request files is due. */
export const pmRequestDue = (today: string, key: string) => addDays(today, pmWindow(key).days);

/** The title staff read in a task list. The note leads, because it's the ask. */
export function pmRequestTitle(note: string): string {
  const first = note.trim().split("\n")[0].trim();
  return first ? `Maintenance requested: ${first.slice(0, 120)}` : "Maintenance requested";
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
