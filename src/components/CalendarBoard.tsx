"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { KIND_LABEL, type CalEvent, type CalKind } from "@/lib/calendar";
import { FacetStrip } from "@/components/ui";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * One month of the company's dated facts.
 *
 * A grid where there is room for one, an agenda where there is not - the same
 * events either way, each a link to the record that owns it, because the
 * calendar answers "what is happening" and the record answers everything
 * else. Filters are per-kind and client-side: the page already paid for the
 * events; hiding a kind should not cost a round trip.
 */
export default function CalendarBoard({ ym, weeks, events, today }: {
  ym: string;
  weeks: string[][];
  events: CalEvent[];
  today: string;
}) {
  const [off, setOff] = useState<Set<CalKind>>(new Set());
  const shown = useMemo(() => events.filter((e) => !off.has(e.kind)), [events, off]);
  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const e of shown) { (m.get(e.date) ?? m.set(e.date, []).get(e.date)!).push(e); }
    return m;
  }, [shown]);
  const counts = useMemo(() => {
    const c = new Map<CalKind, number>();
    for (const e of events) c.set(e.kind, (c.get(e.kind) ?? 0) + 1);
    return c;
  }, [events]);

  const toggle = (k: string) =>
    setOff((s) => { const n = new Set(s); const kk = k as CalKind; if (n.has(kk)) n.delete(kk); else n.add(kk); return n; });

  const pill = (e: CalEvent, i: number) => (
    <Link key={i} href={e.href} className={`pill ${e.tone}`}
      style={{ display: "block", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2, fontWeight: 600 }}
      title={`${KIND_LABEL[e.kind]}: ${e.label}`}>
      {e.label}
    </Link>
  );

  return (
    <>
      <FacetStrip
        facets={(Object.keys(KIND_LABEL) as CalKind[])
          .filter((k) => (counts.get(k) ?? 0) > 0)
          .map((k) => ({ key: k, label: KIND_LABEL[k], count: counts.get(k), on: !off.has(k) }))}
        onToggle={toggle}
      />

      {/* The grid: wide screens only - a phone gets the agenda below. */}
      <div className="card cal-grid-wrap" style={{ padding: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
          {DOW.map((d) => (
            <div key={d} className="mut t-meta" style={{ textAlign: "center", fontWeight: 700, padding: "2px 0" }}>{d}</div>
          ))}
          {weeks.flat().map((iso) => {
            const inMonth = iso.slice(0, 7) === ym;
            const evs = byDay.get(iso) ?? [];
            return (
              <div key={iso} style={{
                minHeight: 84, border: "1px solid var(--line)", borderRadius: 6, padding: "3px 4px",
                background: iso === today ? "#EEF6FD" : inMonth ? "var(--card)" : "var(--bg)",
                opacity: inMonth ? 1 : 0.55, minWidth: 0,
              }}>
                <div className={`t-meta ${iso === today ? "" : "mut"}`} style={{ fontWeight: iso === today ? 800 : 600 }}>
                  {parseInt(iso.slice(8), 10)}
                </div>
                {evs.slice(0, 3).map(pill)}
                {evs.length > 3 && <div className="mut t-meta" style={{ marginTop: 2 }}>+{evs.length - 3} more</div>}
              </div>
            );
          })}
        </div>
      </div>

      {/* The agenda: the same month as a list, which is all a phone needs and
          where the +N-more overflow above gets its full accounting. */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 6 }}>Agenda</div>
        {[...byDay.keys()].filter((d) => d.slice(0, 7) === ym).sort().map((d) => (
          <div key={d} style={{ padding: "6px 0", borderTop: "1px solid var(--line)" }}>
            <div className="t-small" style={{ fontWeight: 700, color: d < today ? "var(--t-bad-fg)" : "var(--navy)" }}>
              {parseInt(d.slice(8), 10)} {d === today ? "· today" : d < today ? "· passed" : ""}
            </div>
            {(byDay.get(d) ?? []).map((e, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", padding: "2px 0" }}>
                <span className={`pill ${e.tone}`}>{KIND_LABEL[e.kind]}</span>
                <Link href={e.href} className="t-body" style={{ color: "inherit", minWidth: 0 }}>{e.label}</Link>
              </div>
            ))}
          </div>
        ))}
        {shown.filter((e) => e.date.slice(0, 7) === ym).length === 0 && (
          <div className="mut t-small">Nothing on the calendar this month{off.size ? " (with these filters)" : ""}.</div>
        )}
      </div>
    </>
  );
}
