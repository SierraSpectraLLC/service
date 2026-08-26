// Which days of the week a digest fires - pure, so the settings forms can use
// the same parsing in the browser that the schedule applies on the server
// (digest.ts imports the database and cannot be imported by a client form).
//
// Stored as a comma list of JS weekday numbers (0 = Sunday), "" meaning every
// day - which is what every organization meant before the setting existed.
// The blank default matters the same way it does for appearance: an org that
// never expressed a preference follows the default if it ever moves.

/** Sunday-first, matching Date.getUTCDay. */
export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Monday-first, which is how a working week reads on a form. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** The stored list as sorted unique weekday numbers. [] = every day. */
export function parseDigestDays(stored: string): number[] {
  const seen = new Set<number>();
  for (const part of stored.split(",")) {
    const n = parseInt(part.trim(), 10);
    if (Number.isInteger(n) && n >= 0 && n <= 6) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * For the column. All seven days stores as blank - "every day" is the absence
 * of a restriction, not a list that happens to be complete.
 */
export function serializeDigestDays(days: number[]): string {
  const clean = [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  return clean.length === 0 || clean.length === 7 ? "" : clean.join(",");
}

/** May a digest fire on this weekday, per the stored setting? */
export function digestDayEnabled(stored: string, weekday: number): boolean {
  const days = parseDigestDays(stored);
  return days.length === 0 || days.includes(weekday);
}

/**
 * The weekday of a shop-day string. Parsed at UTC noon so the date-only
 * string names the same day whatever the server's own zone is.
 */
export function weekdayOfShopDay(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "2026-08-26" -> "Tue Aug 26". The date a digest names itself by.
 *
 * Built from the STRING, never by formatting a Date in a timezone. The shop
 * day is already a calendar day - re-interpreting it as an instant is how a
 * subject line ends up one day behind the edition it is on, which is the exact
 * bug that matters now that the subject and the thread root both carry the
 * date and have to agree.
 */
export function dayLabelOfShopDay(iso: string): string {
  const [, m, d] = iso.split("-");
  const day = parseInt(d, 10);
  const mon = MONTHS[parseInt(m, 10) - 1];
  if (!mon || Number.isNaN(day)) return iso;
  return `${WEEKDAYS[weekdayOfShopDay(iso)]} ${mon} ${day}`;
}

/**
 * How many days the next edition must reach back: from the last send to
 * today, floor one. This is what makes skipped days WORK rather than lose
 * work - a digest that fires Monday after resting since Friday covers three
 * days, so the weekend's completions arrive Monday instead of never.
 *
 * Capped at a week: an organization whose digest slept a month should come
 * back with a week of catch-up, not a month of archaeology.
 */
export function digestGapDays(lastSentOn: string, today: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastSentOn)) return 1;
  const ms = Date.parse(`${today}T12:00:00Z`) - Date.parse(`${lastSentOn}T12:00:00Z`);
  const days = Math.round(ms / 86400000);
  return Math.min(7, Math.max(1, days));
}

/**
 * What the work section calls its window. One day is the ordinary morning;
 * Friday-to-Monday is the weekend by name; anything else names the day the
 * window opens, which is also what a skipped holiday reads as.
 */
export function windowLabel(gapDays: number, sinceWeekday: number): string {
  if (gapDays <= 1) return "Since yesterday";
  if (sinceWeekday === 5 && gapDays === 3) return "Over the weekend";
  return `Since ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][sinceWeekday]}`;
}
