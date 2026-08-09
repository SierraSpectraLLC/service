"use client";

import { useState, useTransition } from "react";
import { promptReason } from "@/lib/reason";
import type { WorkTarget } from "@/app/actions";
import { addPmSchedule, updatePmSchedule, setPmPaused, removePmSchedule } from "@/app/actions";
import { cadenceLabel } from "@/lib/pm";

export type PmRow = {
  id: number; title: string; body: string; assignee: string;
  everyDays: number; nextDue: string; lastDone: string; paused: boolean;
  /** An open generated task is the schedule "in flight". */
  openTaskId: number | null;
};

const CADENCES = [
  { days: 7, label: "weekly" }, { days: 14, label: "every 2 weeks" },
  { days: 30, label: "monthly" }, { days: 90, label: "quarterly" },
  { days: 180, label: "every 6 months" }, { days: 365, label: "yearly" },
];

const mdy = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${parseInt(m)}/${parseInt(d)}`;
};

/**
 * Recurring maintenance on this system or asset. A due schedule turns into an
 * ordinary task in the Tasks panel; completing that task books the next cycle.
 * This panel is the calendar, not the work.
 */
export default function MaintenancePanel({ target, schedules, people, today, canEdit }: {
  target: WorkTarget; schedules: PmRow[]; people: string[]; today: string; canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ title: "", body: "", assignee: "", everyDays: "90", firstDue: today });
  const [editing, setEditing] = useState<Record<number, { assignee: string; everyDays: string; nextDue: string }>>({});
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  if (!canEdit && schedules.length === 0) return null;

  const submit = () => {
    if (!draft.title.trim()) return;
    setError("");
    startTransition(async () => {
      const res = await addPmSchedule(target, draft);
      if (res?.error) setError(res.error);
      else { setDraft({ title: "", body: "", assignee: "", everyDays: draft.everyDays, firstDue: today }); setOpen(false); }
    });
  };

  const saveEdit = (id: number) => {
    const e = editing[id];
    if (!e) return;
    setError("");
    startTransition(async () => {
      const res = await updatePmSchedule(id, e);
      if (res?.error) setError(res.error);
      else setEditing((m) => { const n = { ...m }; delete n[id]; return n; });
    });
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <div className="card-title">Maintenance</div>
        {canEdit && (
          <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => setOpen((v) => !v)}>
            {open ? "Cancel" : "+ Schedule"}
          </button>
        )}
      </div>
      <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
        Recurring upkeep on a calendar. When one comes due it appears under Tasks; completing that task books
        the next cycle from the day it was done.
      </div>

      {open && (
        <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", marginBottom: 10 }}>
          <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder='What recurs, e.g. "Change pump oil"' style={{ width: "100%", fontSize: 13, marginBottom: 6 }} autoFocus />
          <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={2}
            placeholder="Steps or notes for whoever does it (optional)" style={{ width: "100%", fontSize: 13, marginBottom: 6, resize: "vertical" }} />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <select value={draft.everyDays} onChange={(e) => setDraft({ ...draft, everyDays: e.target.value })}
              style={{ width: "auto", fontSize: 12 }}>
              {CADENCES.map((c) => <option key={c.days} value={c.days}>{c.label}</option>)}
              {!CADENCES.some((c) => String(c.days) === draft.everyDays) && (
                <option value={draft.everyDays}>every {draft.everyDays} days</option>
              )}
            </select>
            <input type="number" min={1} max={3650} value={draft.everyDays}
              onChange={(e) => setDraft({ ...draft, everyDays: e.target.value })}
              aria-label="Cadence in days" style={{ width: 70, fontSize: 12 }} />
            <span className="mut" style={{ fontSize: 11 }}>days</span>
            <span className="mut" style={{ fontSize: 12, marginLeft: 8 }}>first due</span>
            <input type="date" value={draft.firstDue} onChange={(e) => setDraft({ ...draft, firstDue: e.target.value })}
              style={{ width: "auto", fontSize: 12 }} />
            <select value={draft.assignee} onChange={(e) => setDraft({ ...draft, assignee: e.target.value })}
              style={{ width: "auto", fontSize: 12 }}>
              <option value="">unassigned</option>
              {people.map((p) => <option key={p}>{p}</option>)}
            </select>
            <button className="btn sm accent" style={{ marginLeft: "auto" }} onClick={submit}
              disabled={pending || !draft.title.trim()}>
              {pending ? "Saving..." : "Schedule"}
            </button>
          </div>
        </div>
      )}

      {schedules.map((s) => {
        const e = editing[s.id];
        const overdue = !s.paused && s.nextDue < today;
        const dueToday = !s.paused && s.nextDue === today;
        return (
          <div key={s.id} style={{ padding: "7px 0", borderTop: "1px solid var(--line)", opacity: s.paused ? 0.6 : 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{s.title}</span>
              <span className="pill" style={{ background: "#EDEBFA", color: "#4F45A3" }}>{cadenceLabel(s.everyDays)}</span>
              {s.paused ? (
                <span className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>paused</span>
              ) : s.openTaskId !== null ? (
                <span className="pill" style={{ background: "#E7F2FA", color: "#1D6396" }}>task open</span>
              ) : (
                <span className="pill" style={{
                  background: overdue ? "#FBE9E9" : dueToday ? "#FAF0DC" : "#EEF1F5",
                  color: overdue ? "#A32D2D" : dueToday ? "#8A5410" : "#475569",
                }}>
                  {overdue ? `overdue ${mdy(s.nextDue)}` : dueToday ? "due today" : `next ${mdy(s.nextDue)}`}
                </span>
              )}
              {s.assignee && <span className="mut" style={{ fontSize: 11 }}>{s.assignee}</span>}
              {s.lastDone && <span className="mut" style={{ fontSize: 11 }}>last done {mdy(s.lastDone)}</span>}
              {canEdit && (
                <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                  <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
                    onClick={() => setEditing((m) => e ? (() => { const n = { ...m }; delete n[s.id]; return n; })() : ({
                      ...m, [s.id]: { assignee: s.assignee, everyDays: String(s.everyDays), nextDue: s.nextDue },
                    }))}>{e ? "cancel" : "edit"}</button>
                  <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
                    onClick={() => startTransition(async () => {
                      const res = await setPmPaused(s.id, !s.paused);
                      if (res?.error) setError(res.error);
                    })}>{s.paused ? "resume" : "pause"}</button>
                  <button className="btn link" style={{ fontSize: 11, color: "#A32D2D" }} disabled={pending}
                    onClick={() => {
                      const reason = promptReason(`Stop scheduling "${s.title}"? Tasks already created stay.`);
                      if (!reason) return;
                      startTransition(async () => {
                        const res = await removePmSchedule(s.id, reason);
                        if (res?.error) setError(res.error);
                      });
                    }}>remove</button>
                </span>
              )}
            </div>
            {s.body && <div className="mut" style={{ fontSize: 12, marginTop: 2, whiteSpace: "pre-wrap" }}>{s.body}</div>}
            {e && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
                <span className="mut" style={{ fontSize: 11 }}>every</span>
                <input type="number" min={1} max={3650} value={e.everyDays}
                  onChange={(ev) => setEditing((m) => ({ ...m, [s.id]: { ...e, everyDays: ev.target.value } }))}
                  aria-label="Cadence in days" style={{ width: 70, fontSize: 12 }} />
                <span className="mut" style={{ fontSize: 11 }}>days · next due</span>
                <input type="date" value={e.nextDue}
                  onChange={(ev) => setEditing((m) => ({ ...m, [s.id]: { ...e, nextDue: ev.target.value } }))}
                  style={{ width: "auto", fontSize: 12 }} />
                <select value={e.assignee} onChange={(ev) => setEditing((m) => ({ ...m, [s.id]: { ...e, assignee: ev.target.value } }))}
                  style={{ width: "auto", fontSize: 12 }}>
                  <option value="">unassigned</option>
                  {people.map((p) => <option key={p}>{p}</option>)}
                </select>
                <button className="btn sm accent" onClick={() => saveEdit(s.id)} disabled={pending}>Save</button>
              </div>
            )}
          </div>
        );
      })}
      {schedules.length === 0 && !open && (
        <div className="mut" style={{ fontSize: 12 }}>Nothing scheduled yet.</div>
      )}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
    </div>
  );
}
