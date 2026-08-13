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

/** The day a finished row belongs to: when it came out, else when it went in. */
export function serviceDay(p: PartLike): string {
  const day = p.removedAt || p.installedAt || (p.createdAt ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-03-12" -> "12 Mar 2026". Built from the string, never from a Date. */
export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${parseInt(d)} ${MONTHS[parseInt(m) - 1] ?? m} ${y}`;
}

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
