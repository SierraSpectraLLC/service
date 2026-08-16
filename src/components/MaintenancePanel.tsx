"use client";

import { useState, useTransition } from "react";
import { promptReason } from "@/lib/reason";
import type { WorkTarget } from "@/app/actions";
import {
  addPmSchedule, updatePmSchedule, setPmPaused, removePmSchedule, requestPmPart, runPmNow,
} from "@/app/actions";
import { cadenceLabel } from "@/lib/pm";
import { pmGroups } from "@/lib/pmGroups";

export type PmRow = {
  id: number; title: string; body: string; assignee: string;
  everyDays: number; nextDue: string; lastDone: string; paused: boolean;
  /** All parts the job takes (procedure-stamped or the hand-made single pair). */
  parts: { name: string; number: string }[];
  /** Set when a schedule shown on a system page actually lives on one of its assets. */
  onAsset?: string;
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
export default function MaintenancePanel({ target, schedules, people, today, canEdit, catalogHint = false }: {
  target: WorkTarget; schedules: PmRow[]; people: string[]; today: string; canEdit: boolean;
  /** Staff only: point at the catalog, where per-model upkeep is defined ONCE. */
  catalogHint?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ title: "", body: "", assignee: "", everyDays: "90", firstDue: today, partName: "", partNumber: "" });
  const [requested, setRequested] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<number, { assignee: string; everyDays: string; nextDue: string }>>({});
  const [error, setError] = useState("");
  const [showLater, setShowLater] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!canEdit && schedules.length === 0) return null;

  // What's owed stays on screen; the rest folds into the month it falls in. A
  // system whose upkeep is all done reads as one line and the month it's next
  // due, rather than as a screenful of work nobody has to do yet.
  const { active, months, paused, next, allClear } = pmGroups(schedules, today);
  const laterCount = months.reduce((n, m) => n + m.rows.length, 0) + paused.length;

  const submit = () => {
    if (!draft.title.trim()) return;
    setError("");
    startTransition(async () => {
      const res = await addPmSchedule(target, draft);
      if (res?.error) setError(res.error);
      else { setDraft({ title: "", body: "", assignee: "", everyDays: draft.everyDays, firstDue: today, partName: "", partNumber: "" }); setOpen(false); }
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

  /**
   * One schedule, wherever it appears - owed now, folded into a month, or paused.
   * Same row either way: what is folded is which rows are on screen, not how much
   * of them, so opening a month gives the full controls rather than a summary.
   */
  const renderRow = (s: PmRow) => {
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
          {s.onAsset && <span className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>{s.onAsset}</span>}
          {s.assignee && <span className="mut" style={{ fontSize: 11 }}>{s.assignee}</span>}
          {s.lastDone && <span className="mut" style={{ fontSize: 11 }}>last done {mdy(s.lastDone)}</span>}
          {canEdit && (
            <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
              {/* A schedule was only a promise without this: the first cycle
                  lands a full cadence out, the generator only fires on what is
                  due, so a yearly job had nothing to work on for a year. An
                  engineer standing at the instrument is the reason it exists. */}
              {!s.paused && s.openTaskId === null && (
                <button className="btn sm" disabled={pending}
                  onClick={() => {
                    setError("");
                    startTransition(async () => {
                      const res = await runPmNow(s.id);
                      setError(res?.error ?? "");
                    });
                  }}>{overdue || dueToday ? "Start" : "Do it now"}</button>
              )}
              {s.openTaskId !== null && (
                <span className="mut" style={{ fontSize: 11 }}>in Tasks</span>
              )}
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
        {s.parts.filter((pt) => pt.number).map((pt) => {
          const key = `${s.id}:${pt.number}`;
          return (
            <div key={key} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 3, flexWrap: "wrap" }}>
              <span className="mono mut" style={{ fontSize: 11 }}>
                {pt.name ? `${pt.name} · ` : ""}PN {pt.number}
              </span>
              {canEdit && (requested[key]
                ? <span style={{ fontSize: 11, color: requested[key] === "ok" ? "#2E6B2E" : "#A32D2D" }}>
                    {requested[key] === "ok" ? "Requested - see Parts" : requested[key]}
                  </span>
                : <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
                    onClick={() => startTransition(async () => {
                      const res = await requestPmPart(s.id, pt.number);
                      setRequested((m) => ({ ...m, [key]: res?.error ?? "ok" }));
                    })}>request part</button>
              )}
            </div>
          );
        })}
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
      {/* A hand-made schedule here covers THIS record only. Ten similar systems
          means ten copies - which is exactly what the catalog exists to avoid. */}
      {catalogHint && (
        <div className="mut" style={{ fontSize: 11, marginBottom: 8 }}>
          Schedules added here cover only this record. Upkeep every unit of a model or
          system type needs is defined once in{" "}
          <a href="/settings/procedures" style={{ color: "var(--link)" }}>Settings → Procedures &amp; maintenance</a>{" "}
          and lands on every matching unit automatically.
        </div>
      )}

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
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
            <input value={draft.partName} onChange={(e) => setDraft({ ...draft, partName: e.target.value })}
              placeholder="Part it takes (optional)" style={{ flex: "1 1 140px", fontSize: 12 }} />
            <input className="mono" value={draft.partNumber} onChange={(e) => setDraft({ ...draft, partNumber: e.target.value })}
              placeholder="Part number" style={{ flex: "1 1 120px", fontSize: 12 }} />
            <button className="btn sm accent" style={{ marginLeft: "auto" }} onClick={submit}
              disabled={pending || !draft.title.trim()}>
              {pending ? "Saving..." : "Schedule"}
            </button>
          </div>
        </div>
      )}

      {active.map(renderRow)}

      {/* The fold. One line when nothing is owed - which is what a system looks
          like most of the time - and the month it comes back around. */}
      {laterCount > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5, fontWeight: allClear ? 700 : 400 }}>
            {allClear ? "All maintenance done" : `${laterCount} not due yet`}
          </span>
          {next && (
            <span className="pill" style={{ background: "#E5F3E5", color: "#2E6B2E" }}>next due {next.label}</span>
          )}
          <button className="btn link" style={{ marginLeft: "auto", fontSize: 11 }}
            onClick={() => setShowLater((v) => !v)}>{showLater ? "hide" : "show"}</button>
        </div>
      )}

      {showLater && months.map((m) => (
        <div key={m.key}>
          <div className="eyebrow" style={{ marginTop: 6 }}>{m.label}</div>
          {m.rows.map(renderRow)}
        </div>
      ))}
      {showLater && paused.length > 0 && (
        <div>
          <div className="eyebrow" style={{ marginTop: 6 }}>Paused</div>
          {paused.map(renderRow)}
        </div>
      )}

      {schedules.length === 0 && !open && (
        <div className="mut" style={{ fontSize: 12 }}>Nothing scheduled yet.</div>
      )}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
    </div>
  );
}
