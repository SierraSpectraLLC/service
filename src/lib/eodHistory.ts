// A record's daily updates, day by day. Pure - the page queries, this decides
// which lines a reader gets and how they gather - so the reading rules can be
// pinned as a table.
//
// Every EOD line is already kept per (system or unit, day, author). The
// record's page showed today's only, so reading last Tuesday's meant finding
// it on /eod by date. This turns the rows into the day-by-day reading the
// record itself can carry.
import { eodAuthorName } from "@/lib/eodLines";

export type HistoryLine = {
  by: string; systemUpdate: string; actionItem: string;
  /** Written for our own bench - staff read it, a client never does. */
  internal: boolean;
  /** Left out of that day's client report. Staff see it said; a client does not see it at all. */
  skipped: boolean;
};
export type HistoryDay = { date: string; lines: HistoryLine[] };

/** How many days a record page shows before it asks whether you want the rest. */
export const RECENT_DAYS = 30;

type Row = {
  date: string; systemUpdate: string; actionItem: string;
  internal: boolean; skipped: boolean;
  author: string; updatedBy: string; person?: string;
  updatedAt: Date;
};

/**
 * Past days only, newest first, each day's lines in the order they were
 * written. A line saying nothing is not a record of anything and is dropped;
 * a day with nothing left to show is dropped with it.
 *
 * STAFF read everything, marked. A CLIENT reads what their report carried:
 * not the internal lines, which were written for the bench, and not the
 * skipped ones, which were left out of the report on purpose - showing them
 * here would be sending the report after all, a day at a time.
 */
export function groupEodHistory(rows: Row[], opts: { today: string; staff: boolean }): HistoryDay[] {
  const days = new Map<string, HistoryLine[]>();
  const kept = rows
    .filter((r) => r.date < opts.today)
    .filter((r) => r.systemUpdate.trim() || r.actionItem.trim())
    .filter((r) => opts.staff || (!r.internal && !r.skipped))
    .sort((a, b) => b.date.localeCompare(a.date) || a.updatedAt.getTime() - b.updatedAt.getTime());
  for (const r of kept) {
    days.set(r.date, [...(days.get(r.date) ?? []), {
      by: eodAuthorName(r), systemUpdate: r.systemUpdate.trim(), actionItem: r.actionItem.trim(),
      internal: r.internal, skipped: r.skipped,
    }]);
  }
  return [...days].map(([date, lines]) => ({ date, lines }));
}

/** "Tue Aug 26", with the year when it is not this year's. */
export function historyDayLabel(iso: string, today: string): string {
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10));
  if (!y || !m || !d) return iso;
  const dt = new Date(y, m - 1, d);
  const sameYear = iso.slice(0, 4) === today.slice(0, 4);
  return dt.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }),
  });
}
