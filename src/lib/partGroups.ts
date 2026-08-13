// A parts list that doesn't grow into a wall.
//
// Two PMs a year, a filter and a pair of seals each time, and after three years a
// system's Parts panel is forty rows deep - all of it true, none of it what
// anybody opened the page to read. The rows that matter today are the ones still
// coming: needed, ordered, in transit. Everything already fitted or pulled is
// history, and history reads by the day it happened.
//
// So: live work stays open, finished work folds into the service visit it belongs
// to, newest visit first and open, older ones collapsed to one line each.
//
// A visit is a calendar day. That is deliberately not "a PM task" - it works on
// rows that already exist, with no linking to do by hand and nothing to backfill,
// and when a PM task WAS completed that day its title labels the group. The one
// thing it gets wrong is a part fitted the same day as a PM but unrelated to it,
// which is a fair thing to call that day's work anyway.

export type PartLike = {
  id: number;
  status: string;
  installedAt: string;   // YYYY-MM-DD, blank when unknown
  removedAt: string;
  /** ISO timestamp; the fallback when a finished row carries no date of its own. */
  createdAt?: string;
};

/** Work that has finished happening. Everything else is still in flight. */
const FINISHED = new Set(["Installed", "Removed"]);

export const isFinished = (p: PartLike) => FINISHED.has(p.status);

/** A calendar day, or "" for anything else. The only date format that sorts. */
export const isoDay = (s: string | undefined | null): string =>
  (/^\d{4}-\d{2}-\d{2}$/.test((s ?? "").trim()) ? (s ?? "").trim() : "");

/**
 * The day a finished row belongs to: when it came out, else when it went in,
 * else the day the row was written.
 *
 * Each candidate is tested in turn rather than the first non-empty one being
 * taken and then checked. That is the whole bug this line used to have: the
 * stamp was written as "Aug 13" - no year, so nothing that can be sorted or
 * grouped - and being non-empty it won, failed the format test, and took the
 * row to "No date recorded" WITH a perfectly good creation date sitting right
 * there behind it. Every part anybody ever installed landed in that bucket.
 */
export function serviceDay(p: PartLike): string {
  return isoDay(p.removedAt) || isoDay(p.installedAt) || isoDay((p.createdAt ?? "").slice(0, 10));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-03-12" -> "12 Mar 2026". Built from the string, never from a Date. */
export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${parseInt(d)} ${MONTHS[parseInt(m) - 1] ?? m} ${y}`;
}

/**
 * A stored lifecycle date, as a person should read it.
 *
 * Dates are stored as calendar days now. Rows written before that carry things
 * like "Aug 13", which is not a date anything can sort but is still what
 * somebody typed or what the old stamp left - so it is shown as it stands
 * rather than blanked or guessed at.
 */
export const dayText = (stored: string): string => {
  const iso = isoDay(stored);
  return iso ? dayLabel(iso) : stored;
};

/** What was completed on a given day, for naming a visit. */
export type ServiceEvent = { day: string; title: string };

export type PartVisit<T> = {
  /** YYYY-MM-DD, or "" for finished rows that never got a date. */
  day: string;
  /** "12 Mar 2026 · Annual PM", or "No date recorded". */
  label: string;
  parts: T[];
};

export type PartGroups<T> = {
  /** Still coming or still open. Never folded away. */
  live: T[];
  /** Finished work, newest visit first. */
  visits: PartVisit<T>[];
};

export function partGroups<T extends PartLike>(
  parts: T[], events: ServiceEvent[] = [],
): PartGroups<T> {
  const live = parts.filter((p) => !isFinished(p));
  const done = parts.filter(isFinished);

  const byDay = new Map<string, T[]>();
  for (const p of done) {
    const day = serviceDay(p);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(p);
    else byDay.set(day, [p]);
  }

  // Newest first; undated last, because it is a data-entry gap rather than a date.
  const days = [...byDay.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : b.localeCompare(a)));

  return {
    live,
    visits: days.map((day) => {
      // Several jobs can close on one day; name them all rather than pick one.
      const named = [...new Set(events.filter((e) => e.day === day).map((e) => e.title.trim()).filter(Boolean))];
      return {
        day,
        label: day === ""
          ? "No date recorded"
          : [dayLabel(day), ...named].join(" · "),
        parts: byDay.get(day)!,
      };
    }),
  };
}

/**
 * The lifecycle dates a save should write.
 *
 * A date somebody typed always wins - that is the whole point of being able to
 * say when the work was really done, which is rarely the day it got recorded.
 * Failing that, entering a state stamps it. Failing that, whatever was stored
 * stays, including the old year-less strings: they read fine on a row, and
 * clearing somebody's note about when a part went in because they edited its
 * price would be a worse answer than leaving it.
 */
export function partDates(
  before: { status: string; receivedAt: string; installedAt: string; removedAt: string },
  status: string,
  given: { installedAt?: string; removedAt?: string },
  today: string,
): { receivedAt: string; installedAt: string; removedAt: string } {
  const entering = (s: string) => status === s && before.status !== s;
  return {
    receivedAt: entering("Received") ? today : before.receivedAt,
    installedAt: isoDay(given.installedAt) || (entering("Installed") ? today : before.installedAt),
    removedAt: isoDay(given.removedAt) || (entering("Removed") ? today : before.removedAt),
  };
}
