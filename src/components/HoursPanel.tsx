"use client";

import { useState, useTransition } from "react";
import { promptReason } from "@/lib/reason";
import { logTime, deleteTimeEntry, type WorkTarget } from "@/app/actions";
import { formatHours } from "@/lib/hours";

export type TimeRow = {
  id: number; person: string; date: string; minutes: number; note: string;
};

const mdy = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${parseInt(m)}/${parseInt(d)}/${y.slice(2)}`;
};

/**
 * Hours against this system or unit. The table existed for a year with no way
 * to write to it; this is the missing half. Entries name who did the work -
 * the person defaults to whoever's signed in but is editable, because the
 * person logging is often not the person who turned the wrench.
 */
export default function HoursPanel({ target, entries, people, defaultPerson, today, canEdit, isStaff }: {
  target: WorkTarget;
  entries: TimeRow[];
  people: string[];
  defaultPerson: string;
  today: string;
  canEdit: boolean;
  isStaff: boolean;
}) {
  const [draft, setDraft] = useState({ hours: "", person: defaultPerson, date: today, note: "" });
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  if (!canEdit && entries.length === 0) return null;

  const total = entries.reduce((n, e) => n + e.minutes, 0);

  const submit = () => {
    if (!draft.hours.trim()) return;
    setError("");
    startTransition(async () => {
      const res = await logTime(target, draft);
      if (res?.error) setError(res.error);
      else setDraft({ ...draft, hours: "", note: "" });
    });
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
        <div className="card-title">Hours</div>
        {total > 0 && <span className="mut" style={{ fontSize: 12 }}>{formatHours(total)} logged</span>}
      </div>
      {canEdit && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: entries.length ? 10 : 0 }}>
          <input value={draft.hours} onChange={(e) => setDraft({ ...draft, hours: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="1.5, 1:30 or 45m" inputMode="decimal"
            aria-label="Hours worked" style={{ flex: "0 1 120px", fontSize: 13 }} />
          <input value={draft.person} list="hours-people" onChange={(e) => setDraft({ ...draft, person: e.target.value })}
            placeholder="Who" aria-label="Who did the work" style={{ flex: "0 1 130px", fontSize: 13 }} />
          <datalist id="hours-people">{people.map((p) => <option key={p} value={p} />)}</datalist>
          <input type="date" value={draft.date} max={today} onChange={(e) => setDraft({ ...draft, date: e.target.value })}
            aria-label="Date worked" style={{ width: "auto", fontSize: 13 }} />
          <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="What was done (optional)" style={{ flex: "1 1 160px", fontSize: 13 }} />
          <button className="btn sm accent" onClick={submit} disabled={pending || !draft.hours.trim()}>
            {pending ? "Logging..." : "Log"}
          </button>
        </div>
      )}

      {entries.map((e) => (
        <div key={e.id} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "5px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 700, width: 52 }}>{formatHours(e.minutes)}</span>
          <span style={{ fontSize: 13 }}>{e.person}</span>
          <span className="mut" style={{ fontSize: 12 }}>{mdy(e.date)}</span>
          {e.note && <span className="mut" style={{ fontSize: 12 }}>- {e.note}</span>}
          {isStaff && (
            <button className="btn link" style={{ marginLeft: "auto", color: "#A32D2D", fontSize: 11 }} disabled={pending}
              onClick={() => {
                const why = promptReason(`Remove this ${formatHours(e.minutes)} entry? It stays in the audit history.`);
                if (!why) return;
                startTransition(async () => {
                  const res = await deleteTimeEntry(e.id, why);
                  if (res?.error) setError(res.error);
                });
              }}>remove</button>
          )}
        </div>
      ))}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
    </div>
  );
}
