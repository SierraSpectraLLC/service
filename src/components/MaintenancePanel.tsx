"use client";

import { useState, useTransition } from "react";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import type { WorkTarget } from "@/app/actions";
import {
  addPmSchedule, updatePmSchedule, setPmPaused, removePmSchedule, requestPmPart, runPmNow,
  alignMaintenance, undoRunPmNow, logPastPm, setPmPosture,
} from "@/app/actions";
import { addDays, cadenceLabel } from "@/lib/pm";
import { postureIsDefault, type PmPosture } from "@/lib/pmPosture";
import { partLabel, type ProcPart } from "@/lib/procedures";
import { pmAssetGroups, pmFolds, pmGroups } from "@/lib/pmGroups";
import PartNumberField from "./PartNumberField";

export type PmRow = {
  id: number; title: string; body: string; assignee: string;
  everyDays: number; nextDue: string; lastDone: string; paused: boolean;
  /** All parts the job takes (procedure-stamped or the hand-made single pair). */
  parts: ProcPart[];
  /** Set when a schedule shown on a system page actually lives on one of its assets. */
  onAsset?: string;
  /** The unit it lives on, for grouping. Null/absent = the system itself. */
  assetId?: number | null;
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
export default function MaintenancePanel({ target, schedules, people, today, canEdit, catalogHint = false, posture }: {
  target: WorkTarget; schedules: PmRow[]; people: string[]; today: string; canEdit: boolean;
  /** Staff only: point at the catalog, where per-model upkeep is defined ONCE. */
  catalogHint?: boolean;
  /**
   * Scheduled vs advisory (lib/pmPosture). `effective` decides how due dates
   * read; the rest drives the toggle, offered only where `instrumentId` and
   * `canToggle` say the viewer may. Absent = scheduled, exactly as before.
   */
  posture?: { effective: PmPosture; stored: string; note: string; instrumentId: number | null; canToggle: boolean };
}) {
  const [open, setOpen] = useState(false);
  // Yearly by default, like the procedure catalog: most upkeep worth writing
  // down is annual, and the form already remembers the last cadence used
  // (see the reset below) for shops whose rhythm is something else.
  const [draft, setDraft] = useState({ title: "", body: "", assignee: "", everyDays: "365", firstDue: today, partName: "", partNumber: "" });
  const [requested, setRequested] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<number, { assignee: string; everyDays: string; nextDue: string; lastDone: string }>>({});
  const [error, setError] = useState("");
  // The whole panel rolls up; a stacked system's upkeep is most of its page.
  const [panelOpen, setPanelOpen] = useState(true);
  /**
   * Per-month fold state. Nothing here until somebody clicks: the DEFAULT is
   * derived - a month with work owed starts open, a quiet one starts folded -
   * so the page opens showing exactly the rows that need someone, and a click
   * is remembered over the derivation from then on.
   */
  const [foldOpen, setFoldOpen] = useState<Record<string, boolean>>({});
  const [aligning, setAligning] = useState(false);
  const [alignDraft, setAlignDraft] = useState<{ mode: "lastDone" | "visit"; date: string; fileRecord: boolean }>({ mode: "lastDone", date: today, fileRecord: false });
  // Per-schedule backfill: one past completion, filed as the Done task it
  // would have left behind.
  const [logging, setLogging] = useState<number | null>(null);
  const [logDraft, setLogDraft] = useState({ date: "", note: "", doneBy: "", advanceSchedule: true });
  const [pending, startTransition] = useTransition();

  if (!canEdit && schedules.length === 0) return null;

  // The list reads as the shop plans: one fold per month, chronological -
  // overdue stragglers, then the month being worked, then the calendar, then
  // paused. A month with work owed starts open; the rest are one line each.
  // Inside a month, rows sub-group under the unit they belong to, which is
  // what makes an aligned visit on a stacked system readable: the pump's
  // five jobs sit under the pump. `active`/`next` feed the rolled-up summary.
  const { active, next } = pmGroups(schedules, today);
  const folds = pmFolds(schedules, today);
  const advisory = posture?.effective === "advisory";

  const submit = () => {
    if (!draft.title.trim()) return;
    setError("");
    startTransition(async () => {
      const res = await addPmSchedule(target, draft);
      if (res?.error) setError(res.error);
      else { setDraft({ title: "", body: "", assignee: "", everyDays: draft.everyDays, firstDue: today, partName: "", partNumber: "" }); setOpen(false); toast({ message: "Added the schedule" }); }
    });
  };

  const saveEdit = (id: number) => {
    const e = editing[id];
    if (!e) return;
    setError("");
    startTransition(async () => {
      const res = await updatePmSchedule(id, e);
      if (res?.error) setError(res.error);
      else { setEditing((m) => { const n = { ...m }; delete n[id]; return n; }); toast({ message: "Saved the schedule" }); }
    });
  };

  /**
   * One schedule, wherever it appears - owed now, folded into a month, or paused.
   * Same row either way: what is folded is which rows are on screen, not how much
   * of them, so opening a month gives the full controls rather than a summary.
   */
  const renderRow = (s: PmRow, inGroup = false) => {
    const e = editing[s.id];
    const overdue = !s.paused && s.nextDue < today;
    const dueToday = !s.paused && s.nextDue === today;
    return (
      <div key={s.id} style={{ padding: "7px 0", borderTop: "1px solid var(--line)", opacity: s.paused ? 0.6 : 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="t-body" style={{ fontWeight: 700 }}>{s.title}</span>
          <span className="pill accent">{cadenceLabel(s.everyDays)}</span>
          {s.paused ? (
            <span className="pill neutral">paused</span>
          ) : s.openTaskId !== null ? (
            <span className="pill info">task open</span>
          ) : (
            /* Advisory: the same date without the siren. A passed date on a
               reseller's bench is information ("a cycle has elapsed"), not a
               failure, so it never goes red and never says "overdue". */
            advisory ? (
              <span className="pill neutral">
                {overdue || dueToday ? `cycle elapsed ${mdy(s.nextDue)}` : `next cycle ${mdy(s.nextDue)}`}
              </span>
            ) : (
            <span className={`pill ${overdue ? "bad" : dueToday ? "warn" : "neutral"}`}>
              {overdue ? `overdue ${mdy(s.nextDue)}` : dueToday ? "due today" : `next ${mdy(s.nextDue)}`}
            </span>
            )
          )}
          {s.onAsset && !inGroup && <span className="pill neutral">{s.onAsset}</span>}
          {s.assignee && <span className="mut t-meta">{s.assignee}</span>}
          {s.lastDone && <span className="mut t-meta">last done {mdy(s.lastDone)}</span>}
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
                      if (!res?.error) toast({ message: "Created the task" });
                    });
                  }}>{!advisory && (overdue || dueToday) ? "Start" : "Do it now"}</button>
              )}
              {s.openTaskId !== null && (
                <span className="mut t-meta">in Tasks</span>
              )}
              {/* An early start that nobody has touched can simply be taken
                  back - the click created a task, never moved the dates. */}
              {canEdit && s.openTaskId !== null && !s.paused && s.nextDue > today && (
                <button className="btn link" disabled={pending}
                  title="Removes the task the early start created. The schedule's due date was never touched."
                  onClick={() => startTransition(async () => {
                    const res = await undoRunPmNow(s.id);
                    if (res?.error) setError(res.error);
                    else toast({ message: "Removed the task" });
                  })}>undo start</button>
              )}
              {canEdit && (
                <button className="btn link" disabled={pending}
                  title="File a completion that happened before the software was watching"
                  onClick={() => {
                    setLogging(logging === s.id ? null : s.id);
                    setLogDraft({ date: "", note: "", doneBy: "", advanceSchedule: true });
                  }}>log past done</button>
              )}
              <button className="btn link" disabled={pending}
                onClick={() => setEditing((m) => e ? (() => { const n = { ...m }; delete n[s.id]; return n; })() : ({
                  ...m, [s.id]: { assignee: s.assignee, everyDays: String(s.everyDays), nextDue: s.nextDue, lastDone: s.lastDone },
                }))}>{e ? "cancel" : "edit"}</button>
              <button className="btn link" disabled={pending}
                onClick={() => startTransition(async () => {
                  const res = await setPmPaused(s.id, !s.paused);
                  if (res?.error) setError(res.error);
                  else toast({ message: s.paused ? "Resumed the schedule" : "Paused the schedule" });
                })}>{s.paused ? "resume" : "pause"}</button>
              <button className="btn link" style={{ color: "var(--t-bad-fg)" }} disabled={pending}
                onClick={async () => {
                  const reason = await confirmReason({
                    title: `Stop scheduling "${s.title}"?`,
                    body: "Tasks already created stay.",
                    action: "Stop scheduling", tone: "bad",
                  });
                  if (!reason) return;
                  startTransition(async () => {
                    const res = await removePmSchedule(s.id, reason);
                    if (res?.error) setError(res.error);
                    else toast({ message: "Removed the schedule" });
                  });
                }}>remove</button>
            </span>
          )}
        </div>
        {s.body && <div className="mut t-small" style={{ marginTop: 2, whiteSpace: "pre-wrap" }}>{s.body}</div>}
        {/* One past completion, filed as the Done task it would have left
            behind - so the vendor's 2024 visit exists as history, not memory. */}
        {logging === s.id && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 6, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "#FAFBFD" }}>
            <input type="date" value={logDraft.date} aria-label="Date it was done"
              onChange={(ev) => setLogDraft({ ...logDraft, date: ev.target.value })}
              className="t-small" style={{ width: "auto" }} />
            <input value={logDraft.doneBy} placeholder="By (vendor or engineer, optional)"
              onChange={(ev) => setLogDraft({ ...logDraft, doneBy: ev.target.value })}
              className="t-small" style={{ width: "auto", flex: "1 1 130px" }} />
            <input value={logDraft.note} placeholder="Note (optional)"
              onChange={(ev) => setLogDraft({ ...logDraft, note: ev.target.value })}
              className="t-small" style={{ width: "auto", flex: "2 1 150px" }} />
            <label className="t-meta" style={{ display: "flex", alignItems: "center", gap: 4, margin: 0, fontWeight: 400 }}>
              <input type="checkbox" checked={logDraft.advanceSchedule} style={{ width: 14, height: 14 }}
                onChange={(ev) => setLogDraft({ ...logDraft, advanceSchedule: ev.target.checked })} />
              set next due from it
            </label>
            <button className="btn sm accent" disabled={pending || !logDraft.date}
              onClick={() => startTransition(async () => {
                const res = await logPastPm(s.id, logDraft);
                if (res?.error) { setError(res.error); return; }
                setLogging(null);
                toast({ message: "Logged the maintenance" });
              })}>File</button>
          </div>
        )}
        {s.parts.filter((pt) => pt.number).map((pt) => {
          const key = `${s.id}:${pt.number}`;
          return (
            <div key={key} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 3, flexWrap: "wrap" }}>
              {/* partLabel rather than a second spelling of it: this line sits
                  next to the button that actually orders the part, so it is the
                  last place that should disagree with the task about how many. */}
              <span className="mono mut t-meta">{partLabel(pt)}</span>
              {canEdit && (requested[key]
                ? <span className="t-meta" style={{ color: requested[key] === "ok" ? "#2E6B2E" : "#A32D2D" }}>
                    {requested[key] === "ok" ? "Requested - see Parts" : requested[key]}
                  </span>
                : <button className="btn link" disabled={pending}
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
            <span className="mut t-meta">every</span>
            <input type="number" min={1} max={3650} value={e.everyDays}
              onChange={(ev) => setEditing((m) => ({ ...m, [s.id]: { ...e, everyDays: ev.target.value } }))}
              aria-label="Cadence in days" className="t-small" style={{ width: 70 }} />
            <span className="mut t-meta">days · next due</span>
            <input type="date" value={e.nextDue}
              onChange={(ev) => setEditing((m) => ({ ...m, [s.id]: { ...e, nextDue: ev.target.value } }))}
              className="t-small" style={{ width: "auto" }} />
            {/* The date off the sticker, or the seller's word at intake.
                Setting it re-suggests next due one cadence later - still
                editable, because "we know when, not by whom" is the fact
                being recorded and the calendar is a consequence of it. */}
            <span className="mut t-meta">last done</span>
            <input type="date" value={e.lastDone} aria-label="Last done"
              onChange={(ev) => {
                const lastDone = ev.target.value;
                const days = parseInt(e.everyDays);
                setEditing((m) => ({ ...m, [s.id]: {
                  ...e, lastDone,
                  nextDue: lastDone && Number.isFinite(days) && days > 0 ? addDays(lastDone, days) : e.nextDue,
                } }));
              }}
              className="t-small" style={{ width: "auto" }} />
            <select value={e.assignee} onChange={(ev) => setEditing((m) => ({ ...m, [s.id]: { ...e, assignee: ev.target.value } }))}
              className="t-small" style={{ width: "auto" }}>
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
        <button onClick={() => setPanelOpen((v) => !v)} aria-expanded={panelOpen}
          style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", padding: 0, cursor: "pointer" }}>
          <span aria-hidden className="t-meta" style={{ color: "var(--mut)", width: 12 }}>{panelOpen ? "\u25BE" : "\u25B8"}</span>
          <span className="card-title">Maintenance</span>
        </button>
        {/* Rolled up, the header keeps the two answers the panel exists for:
            is anything owed, and when is the next thing. */}
        {!panelOpen && schedules.length > 0 && (
          <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {active.length > 0 ? (
              <span className={`pill ${advisory ? "neutral" : "bad"}`}>
                {active.length} {advisory ? "cycled" : "due now"}
              </span>
            ) : next ? (
              <span className="pill good">
                {advisory ? `next cycle ${next.label}` : `next due ${next.label}`}
              </span>
            ) : null}
            <span className="mut t-meta">{schedules.length} schedule{schedules.length === 1 ? "" : "s"}</span>
          </span>
        )}
        {canEdit && panelOpen && (
          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            {schedules.length > 0 && (
              <button className="btn sm" onClick={() => { setAligning((v) => !v); setError(""); }}>
                {aligning ? "Cancel" : "Align dates"}
              </button>
            )}
            <button className="btn sm" onClick={() => setOpen((v) => !v)}>
              {open ? "Cancel" : "+ Schedule"}
            </button>
          </span>
        )}
      </div>
      {panelOpen && (<>

      {/* Every schedule here, anchored to one real date - because a new
          system's dates anchor to the day the record was made, and the PM
          almost never happened that day. Two anchors, the two facts somebody
          actually knows: when it was last done, or when the visit is booked. */}
      {aligning && (
        <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", marginBottom: 10, background: "#FAFBFD" }}>
          <div className="seg" role="group" aria-label="Anchor" style={{ marginBottom: 8, flexWrap: "wrap" }}>
            <button type="button" aria-pressed={alignDraft.mode === "lastDone"}
              onClick={() => setAlignDraft({ ...alignDraft, mode: "lastDone" })}>PM was done on...</button>
            <button type="button" aria-pressed={alignDraft.mode === "visit"}
              onClick={() => setAlignDraft({ ...alignDraft, mode: "visit" })}>Next PM visit is...</button>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input type="date" value={alignDraft.date}
              onChange={(e) => setAlignDraft({ ...alignDraft, date: e.target.value })}
              className="t-body" style={{ width: "auto" }} aria-label="Anchor date" />
            <button className="btn sm accent" disabled={pending || !alignDraft.date}
              onClick={() => startTransition(async () => {
                const res = await alignMaintenance(target, alignDraft);
                if (res?.error) { setError(res.error); return; }
                setAligning(false);
                toast({ message: `Aligned ${schedules.length} schedule${schedules.length === 1 ? "" : "s"}` });
              })}>
              {pending ? "Aligning..." : `Apply to ${schedules.length} schedule${schedules.length === 1 ? "" : "s"}`}
            </button>
          </div>
          {alignDraft.mode === "lastDone" && (
            <label className="t-small" style={{ display: "flex", alignItems: "center", gap: 6, margin: "8px 0 0", fontWeight: 400 }}>
              <input type="checkbox" checked={alignDraft.fileRecord} style={{ width: 15, height: 15 }}
                onChange={(e) => setAlignDraft({ ...alignDraft, fileRecord: e.target.checked })} />
              Also file the completed work as records on that date
              <span className="mut">- the visit becomes history, not just a date</span>
            </label>
          )}
          <div className="mut t-meta" style={{ marginTop: 6 }}>
            {alignDraft.mode === "lastDone"
              ? "Marks every schedule last done that day - each comes due its own cadence later (quarterly work in 3 months, annual next year)."
              : "Everything falls due together on that day, like a PM visit; each advances by its own cadence once completed."}
            {" "}Generated tasks still sitting Open from the old dates are removed; anything In progress stays.
          </div>
        </div>
      )}
      {/* Which of the schedule's two meanings applies here: the knowledge
          always, the obligation only on a scheduled system. lib/pmPosture. */}
      {posture && (advisory || !postureIsDefault(posture.stored)) && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8, padding: "7px 10px", borderRadius: 8, background: advisory ? "#F5F7FA" : "#E7F2FA" }}>
          <span className={`pill ${advisory ? "neutral" : "info"}`}>
            {advisory ? "reference only" : "on a schedule"}
          </span>
          <span className="mut" style={{ fontSize: 11.5, flex: "1 1 200px" }}>{posture.note}</span>
          {posture.canToggle && posture.instrumentId !== null && (
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className="btn link" disabled={pending}
                onClick={() => startTransition(async () => {
                  const res = await setPmPosture(posture.instrumentId!, advisory ? "scheduled" : "advisory");
                  if (res?.error) setError(res.error);
                  else toast({ message: advisory ? "Put maintenance on a schedule" : "Made maintenance reference only" });
                })}>{advisory ? "put on a schedule" : "make reference only"}</button>
              {!postureIsDefault(posture.stored) && (
                <button className="btn link" disabled={pending}
                  title="Follow the owning organization again"
                  onClick={() => startTransition(async () => {
                    const res = await setPmPosture(posture.instrumentId!, "");
                    if (res?.error) setError(res.error);
                    else toast({ message: "Restored the owner default" });
                  })}>use owner default</button>
              )}
            </span>
          )}
        </div>
      )}
      {/* The quiet counterpart: a scheduled-by-default system offers the way
          out without a banner about a state it is already in. */}
      {posture && !advisory && postureIsDefault(posture.stored) && posture.canToggle && posture.instrumentId !== null && schedules.length > 0 && (
        <div className="mut t-meta" style={{ marginBottom: 8 }}>
          Due work turns into tasks.{" "}
          <button className="btn link" disabled={pending}
            title="Keep every schedule as reference - nothing comes due, nothing nags"
            onClick={() => startTransition(async () => {
              const res = await setPmPosture(posture.instrumentId!, "advisory");
              if (res?.error) setError(res.error);
              else toast({ message: "Made maintenance reference only" });
            })}>Make reference only</button>
        </div>
      )}
      {/* A hand-made schedule here covers THIS record only. Ten similar systems
          means ten copies - which is exactly what the catalog exists to avoid. */}
      {catalogHint && (
        <div className="mut t-meta" style={{ marginBottom: 8 }}>
          Schedules added here cover only this record. Upkeep every unit of a model or
          system type needs is defined once in{" "}
          <a href="/settings/procedures" style={{ color: "var(--link)" }}>Settings → Procedures &amp; maintenance</a>{" "}
          and lands on every matching unit automatically.
        </div>
      )}

      {open && (
        <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", marginBottom: 10 }}>
          <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder='What recurs, e.g. "Change pump oil"' className="t-body" style={{ width: "100%", marginBottom: 6 }} autoFocus />
          <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={2}
            placeholder="Steps or notes for whoever does it (optional)" className="t-body" style={{ width: "100%", marginBottom: 6, resize: "vertical" }} />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <select value={draft.everyDays} onChange={(e) => setDraft({ ...draft, everyDays: e.target.value })}
              className="t-small" style={{ width: "auto" }}>
              {CADENCES.map((c) => <option key={c.days} value={c.days}>{c.label}</option>)}
              {!CADENCES.some((c) => String(c.days) === draft.everyDays) && (
                <option value={draft.everyDays}>every {draft.everyDays} days</option>
              )}
            </select>
            <input type="number" min={1} max={3650} value={draft.everyDays}
              onChange={(e) => setDraft({ ...draft, everyDays: e.target.value })}
              aria-label="Cadence in days" className="t-small" style={{ width: 70 }} />
            <span className="mut t-meta">days</span>
            <span className="mut t-small" style={{ marginLeft: 8 }}>first due</span>
            <input type="date" value={draft.firstDue} onChange={(e) => setDraft({ ...draft, firstDue: e.target.value })}
              className="t-small" style={{ width: "auto" }} />
            <select value={draft.assignee} onChange={(e) => setDraft({ ...draft, assignee: e.target.value })}
              className="t-small" style={{ width: "auto" }}>
              <option value="">unassigned</option>
              {people.map((p) => <option key={p}>{p}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
            <PartNumberField value={draft.partName} insert="name" className="" ariaLabel="Part it takes"
              placeholder="Part it takes (optional)" style={{ flex: "1 1 140px", fontSize: 12 }}
              onChange={(partName) => setDraft({ ...draft, partName })}
              onPick={(part) => setDraft((d) => ({
                ...d, partName: part.name || part.partNumber,
                partNumber: d.partNumber.trim() || part.partNumber,
              }))} />
            <PartNumberField value={draft.partNumber} style={{ flex: "1 1 120px", fontSize: 12 }}
              onChange={(partNumber) => setDraft({ ...draft, partNumber })}
              onPick={(part) => setDraft((d) => ({
                ...d, partNumber: part.partNumber, partName: d.partName.trim() || part.name,
              }))} />
            <button className="btn sm accent" style={{ marginLeft: "auto" }} onClick={submit}
              disabled={pending || !draft.title.trim()}>
              {pending ? "Saving..." : "Schedule"}
            </button>
          </div>
        </div>
      )}

      {folds.map((f) => {
        const isOpen = foldOpen[f.key] ?? f.owed > 0;
        // Inside a month, the unit is the subhead - a label, not a third
        // chevron. Two interactive levels is the budget; past that, opening
        // the work costs more clicks than reading it. One unit means the
        // subhead has nothing to add.
        const units = pmAssetGroups(f.rows, today);
        const subheads = units.length > 1;
        const owedPill = f.owed > 0 ? (
          advisory ? (
            <span className="pill neutral">{f.owed} cycled</span>
          ) : f.state === "overdue" ? (
            <span className="pill bad">{f.owed} overdue</span>
          ) : f.state === "due" ? (
            <span className="pill warn">{f.owed} due</span>
          ) : (
            <span className="pill info">{f.owed} in flight</span>
          )
        ) : null;
        return (
          <div key={f.key} style={{ borderTop: "1px solid var(--line)" }}>
            <button onClick={() => setFoldOpen((m) => ({ ...m, [f.key]: !isOpen }))} aria-expanded={isOpen}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", background: "none", border: "none", padding: "8px 0", cursor: "pointer", textAlign: "left", flexWrap: "wrap" }}>
              <span aria-hidden style={{ fontSize: 10, color: "var(--mut)", width: 12 }}>{isOpen ? "\u25BE" : "\u25B8"}</span>
              <span className="t-body" style={{ fontWeight: 700, color: f.state === "paused" ? "var(--mut)" : "var(--navy)" }}>{f.label}</span>
              <span className="mut t-meta">{f.rows.length}</span>
              {owedPill}
            </button>
            {isOpen && (
              <div style={{ paddingLeft: 20 }}>
                {subheads
                  ? units.map((u) => (
                      <div key={u.key}>
                        <div className="eyebrow" style={{ marginTop: 4 }}>{u.label} · {u.rows.length}</div>
                        {u.rows.map((r) => renderRow(r, true))}
                      </div>
                    ))
                  : f.rows.map((r) => renderRow(r))}
              </div>
            )}
          </div>
        );
      })}

      {schedules.length === 0 && !open && (
        <div className="mut t-small">Nothing scheduled yet.</div>
      )}
      </>)}
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
    </div>
  );
}
