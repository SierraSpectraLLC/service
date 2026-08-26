// When somebody last worked on a system, and how often this year.
//
// "0 VISITS THIS YEAR" WAS NOT "NO VISITS". It was "no closed work orders",
// which is a fact about which table the work happened to land in. Maintenance
// can be recorded three ways in this app and only one of them was being
// counted:
//
//   - a closed work order, from a job worked through or from "Log past work"
//   - a PM aligned to a date it was done, which files a Done task and never a
//     work order (see actions.alignMaintenance)
//   - a generated PM task somebody ticked off
//
// So a shop that ran a client's annual PM and recorded it the way the
// maintenance panel invites you to recorded it in a place three surfaces did
// not look: the landing's visit count, the card's "last visit", and the
// record's "last service by". All three read zero over real work.
//
// A VISIT IS A DAY SOMEBODY COMPLETED WORK ON THE SYSTEM. One sentence,
// checkable against the record, and it dedupes by construction: a PM done
// inside a work order closed the same day is one visit, not two.

/** One thing finishing on one system, from whichever table recorded it. */
export type Completion = {
  instrumentId: number;
  /** YYYY-MM-DD in shop time. */
  day: string;
  /**
   * Scheduled upkeep rather than something that went wrong. A PM is planned by
   * definition; a work order is planned when its severity says so.
   */
  planned: boolean;
};

export type Visit = { instrumentId: number; day: string; planned: boolean };

/**
 * The distinct days work finished, worst-first within a day.
 *
 * A day is UNPLANNED if anything unplanned finished on it. The reverse rule -
 * planned wins - would let a routine PM ticked off during an emergency callout
 * report the callout as scheduled maintenance, which is the more expensive
 * error of the two: it hides that something broke.
 */
export function visitsOf(completions: Completion[]): Visit[] {
  const byDay = new Map<string, Visit>();
  for (const c of completions) {
    if (!c.day) continue;
    const key = `${c.instrumentId}|${c.day}`;
    const seen = byDay.get(key);
    if (!seen) byDay.set(key, { instrumentId: c.instrumentId, day: c.day, planned: c.planned });
    else if (!c.planned) seen.planned = false;
  }
  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/** Visits that fall in the calendar year `today` is in. */
export const visitsThisYear = (visits: Visit[], today: string): Visit[] =>
  visits.filter((v) => v.day >= `${today.slice(0, 4)}-01-01` && v.day <= today);

/** The most recent day work finished on each system. */
export function lastVisitBy(visits: Visit[]): Map<number, string> {
  const out = new Map<number, string>();
  // visitsOf sorts newest first, so the first sighting of a system wins.
  for (const v of visits) if (!out.has(v.instrumentId)) out.set(v.instrumentId, v.day);
  return out;
}

/** A timestamp as a shop day, for rows that store one. */
export const dayOf = (at: Date | null): string =>
  at === null ? "" : at.toISOString().slice(0, 10);
