"use client";

import { useState, useTransition } from "react";
import { formatHours } from "@/lib/hours";
import { logTime, deleteTimeEntry } from "@/app/actions";

export type TimeRow = { id: number; person: string; date: string; minutes: number; note: string; assetId: number | null };

export default function TimePanel({ instrumentId, entries, today, people, systemAssets, canEdit, isStaff }: {
  instrumentId: number; entries: TimeRow[]; today: string; people: string[];
  systemAssets: { id: number; label: string }[]; canEdit: boolean; isStaff: boolean;
}) {
  const assetLabel = (id: number | null) => systemAssets.find((a) => a.id === id)?.label ?? null;
  const [draft, setDraft] = useState({ person: "", date: today, hours: "", note: "", assetId: null as number | null });
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const total = entries.reduce((n, e) => n + e.minutes, 0);
  const byPerson = new Map<string, number>();
  for (const e of entries) byPerson.set(e.person, (byPerson.get(e.person) ?? 0) + e.minutes);

  const submit = () => {
    setError("");
    startTransition(async () => {
      const res = await logTime(instrumentId, draft);
      if (res?.error) setError(res.error);
      else setDraft({ person: draft.person, date: today, hours: "", note: "", assetId: draft.assetId });
    });
  };

  if (!canEdit && entries.length === 0) return null;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <div className="card-title">Time</div>
        <b style={{ fontSize: 13 }}>{formatHours(total)}</b>
        {byPerson.size > 0 && (
          <span className="mut" style={{ fontSize: 12 }}>
            {[...byPerson].map(([p, m]) => `${p} ${formatHours(m)}`).join(" · ")}
          </span>
        )}
        {canEdit && (
          <button className="btn sm primary" style={{ marginLeft: "auto" }} onClick={() => setOpen((v) => !v)}>
            {open ? "Cancel" : "+ Log time"}
          </button>
        )}
      </div>

      {open && canEdit && (
        <div className="dash-form">
          <div className="pf3" style={{ marginBottom: 8 }}>
            <div>
              <label>Who</label>
              <select value={draft.person} onChange={(e) => setDraft({ ...draft, person: e.target.value })}>
                <option value="">Me</option>
                {people.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div><label>Date</label><input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} /></div>
            <div><label>Hours</label><input value={draft.hours} onChange={(e) => setDraft({ ...draft, hours: e.target.value })} placeholder="1.5 or 1:30" /></div>
          </div>
          <div className="pf2" style={{ marginBottom: 10 }}>
            <div>
              <label>Note</label>
              <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="e.g. source cleaning + retune" />
            </div>
            <div>
              <label>For asset</label>
              <select value={draft.assetId ?? ""} onChange={(e) => setDraft({ ...draft, assetId: e.target.value ? parseInt(e.target.value) : null })}>
                <option value="">Whole system</option>
                {systemAssets.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </div>
          </div>
          {error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 8 }}>{error}</div>}
          <button className="btn sm accent" onClick={submit} disabled={pending || !draft.hours.trim()}>
            {pending ? "Saving..." : "Log time"}
          </button>
        </div>
      )}

      {entries.map((e) => (
        <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderTop: "1px solid var(--line)", fontSize: 13, flexWrap: "wrap" }}>
          <span className="mono mut" style={{ fontSize: 11 }}>{e.date}</span>
          <b>{formatHours(e.minutes)}</b>
          <span>{e.person}</span>
          {assetLabel(e.assetId) && <span className="pill" style={{ background: "#EDEBFA", color: "#4F45A3" }}>{assetLabel(e.assetId)}</span>}
          {e.note && <span className="mut" style={{ fontSize: 12 }}>{e.note}</span>}
          {isStaff && (
            <button className="btn link" style={{ marginLeft: "auto", color: "#A32D2D", fontSize: 11 }} disabled={pending}
              onClick={() => { if (window.confirm("Remove this time entry?")) startTransition(() => deleteTimeEntry(e.id)); }}>×</button>
          )}
        </div>
      ))}
      {entries.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No time logged yet.</div>}
    </div>
  );
}
