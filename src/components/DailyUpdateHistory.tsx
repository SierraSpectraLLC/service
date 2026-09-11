import Link from "next/link";
import { RECENT_DAYS, historyDayLabel, type HistoryDay } from "@/lib/eodHistory";

/**
 * Past days' updates on one record, newest first, each line with its author.
 *
 * Sits under the editor for today, so the record reads as one diary: what is
 * being written now, then what was written before. Nothing here is editable -
 * a past day is corrected on /eod, where the whole day is in view - and a
 * client reads the same lines their reports carried (lib/eodHistory decides).
 *
 * Thirty days at a time. A record with a year of updates is a page nobody
 * scrolls; the rest is one click, and the click says how many.
 */
export default function DailyUpdateHistory({ days, total, showingAll, allHref, today }: {
  /** The days to render - already cut to RECENT_DAYS unless showingAll. */
  days: HistoryDay[];
  /** How many days there are in all, for the "show the rest" line. */
  total: number;
  showingAll: boolean;
  allHref: string;
  today: string;
}) {
  if (!total) return null;
  const line = (l: HistoryDay["lines"][number], i: number) => (
    <div key={i} className="t-body" style={{ marginTop: 4 }}>
      {l.systemUpdate && <div style={{ whiteSpace: "pre-wrap" }}>{l.systemUpdate}</div>}
      {l.actionItem && (
        <div style={{ marginTop: 4 }}>
          <span className="eyebrow" style={{ marginRight: 8 }}>Action</span>{l.actionItem}
        </div>
      )}
      <div className="mut t-meta" style={{ marginTop: 2, display: "flex", gap: 8, alignItems: "center" }}>
        {l.by && <span>{l.by}</span>}
        {l.internal && <span className="pill warn">internal only</span>}
        {l.skipped && <span className="pill neutral">left off the report</span>}
      </div>
    </div>
  );
  return (
    <div className="card">
      <div className="row-2" style={{ alignItems: "baseline", marginBottom: 4 }}>
        <div className="card-title">Earlier updates</div>
        <span className="mut t-meta">{total} day{total === 1 ? "" : "s"} on record</span>
      </div>
      {days.map((day) => (
        <div key={day.date} style={{ paddingTop: 8, marginTop: 8, borderTop: "1px solid var(--line)" }}>
          <div className="t-small" style={{ fontWeight: 700 }}>{historyDayLabel(day.date, today)}</div>
          {day.lines.map(line)}
          {/* The units that were in the system that day, each under its own
              name. One since moved on says so: its lines are still this
              system's for the days it was here, and the reader should know
              they are looking at a detector that is now somewhere else. */}
          {day.modules.map((m) => (
            <div key={m.assetId} style={{ marginTop: 8, paddingLeft: 12, borderLeft: "2px solid var(--line)" }}>
              <div className="t-small" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <Link href={`/assets/${m.assetId}`} className="mono" style={{ fontWeight: 700, textDecoration: "none" }}>{m.label}</Link>
                {m.leftOn && <span className="pill neutral">was in this system until {historyDayLabel(m.leftOn, today)}</span>}
              </div>
              {m.lines.map(line)}
            </div>
          ))}
        </div>
      ))}
      {!showingAll && total > RECENT_DAYS && (
        <div style={{ marginTop: 12 }}>
          <Link className="btn link" href={allHref}>Show all {total} days</Link>
        </div>
      )}
    </div>
  );
}
