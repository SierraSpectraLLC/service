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
/**
 * A unit's lines under the system it was in that day. `leftOn` is set when
 * the unit has since left the system - the last day it was here - so the
 * reader knows they are looking at a detector that is now somewhere else.
 */
export type HistoryModule = { assetId: number; label: string; leftOn: string | null; lines: HistoryLine[] };
export type HistoryDay = { date: string; lines: HistoryLine[]; modules: HistoryModule[] };

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
  return groupEodHistoryWithModules(rows, [], opts);
}

/** A unit's row, with the unit it was written on, already known to have been in the system that day. */
export type ModuleRow = { row: Row; assetId: number; label: string; leftOn: string | null };

/** The same reading, with the system's units' lines under each day. */
export function groupEodHistoryWithModules(
  rows: Row[], moduleRows: ModuleRow[], opts: { today: string; staff: boolean },
): HistoryDay[] {
  const keep = (r: Row) =>
    r.date < opts.today
    && !!(r.systemUpdate.trim() || r.actionItem.trim())
    && (opts.staff || (!r.internal && !r.skipped));
  const byWritten = (a: Row, b: Row) => a.updatedAt.getTime() - b.updatedAt.getTime();
  const lineOf = (r: Row): HistoryLine => ({
    by: eodAuthorName(r), systemUpdate: r.systemUpdate.trim(), actionItem: r.actionItem.trim(),
    internal: r.internal, skipped: r.skipped,
  });

  const days = new Map<string, HistoryDay>();
  const dayFor = (date: string) => {
    let d = days.get(date);
    if (!d) days.set(date, (d = { date, lines: [], modules: [] }));
    return d;
  };
  for (const r of rows.filter(keep).sort(byWritten)) dayFor(r.date).lines.push(lineOf(r));
  // Units: grouped under their day, one block per unit in label order, the
  // unit's lines in the order they were written.
  const kept = moduleRows.filter((m) => keep(m.row)).sort((a, b) =>
    a.label.localeCompare(b.label) || a.assetId - b.assetId || byWritten(a.row, b.row));
  for (const m of kept) {
    const d = dayFor(m.row.date);
    let block = d.modules.find((x) => x.assetId === m.assetId);
    if (!block) d.modules.push((block = { assetId: m.assetId, label: m.label, leftOn: m.leftOn, lines: [] }));
    block.lines.push(lineOf(m.row));
  }
  return [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
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
