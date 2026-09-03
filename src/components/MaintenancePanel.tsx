"use client";

import { useState, useTransition } from "react";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import type { WorkTarget } from "@/app/actions";
import {
  addPmSchedule, updatePmSchedule, setPmPaused, removePmSchedule, requestPmPart, runPmNow,
  alignMaintenance, undoRunPmNow, logPastPm, setPmPosture,
  schedulePmVisit, unschedulePmVisit, completePmNow, undoPmComplete,
} from "@/app/actions";
import { addDays, cadenceLabel, pmStanding } from "@/lib/pm";
import { postureIsDefault, type PmPosture } from "@/lib/pmPosture";
import { partLabel, type ProcPart } from "@/lib/procedures";
import { pmAssetGroups, pmGroups } from "@/lib/pmGroups";
import RowActions, { type RowAction } from "@/components/ui/RowActions";
import PartNumberField from "./PartNumberField";

export type PmRow = {
  id: number; title: string; body: string; assignee: string;
  everyDays: number; nextDue: string; lastDone: string; paused: boolean;
  /** The appointment, when the client has picked a day. */
  bookedOn?: string; bookedNote?: string;
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

/** What the ✓ means here: this cycle was completed today, by whichever path. */
const doneToday = (s: PmRow, today: string) => !s.paused && s.lastDone === today;

/**
 * A system's upkeep, read the way it is worked: by MODULE, in procedure order,
 * with a run mode for the visit itself.
 *
 * The old panel was one row of buttons per schedule - six verbs each, twenty
 * nine times on a stacked system's annual - which buried the two answers the
 * page exists for under a wall of controls. Now the rows carry only what a
 * reader scans (sequence, name, standing, cadence) and everything DONE to a
 * schedule lives behind the row: tap to open, verbs inside. Order within a
 * module is creation order, which for procedure-stamped schedules is the
 * procedure's own step order - the sequence an engineer actually works.
 *
 * A PM RUN is the visit as a gesture: start it, and the sequence box turns
 * into a thumb-sized control - tap it and the step is done on the spot, record
 * filed, calendar advanced (completePmNow); tap it again to take that back.
 * The row itself keeps opening the detail, in a run as outside one, so the
 * spec can always be read before the work. Next step highlighted, progress on
 * the bar. "Done" during a run is not
 * UI state: it is lastDone === today, read off the same rows, so a phone that
 * dies mid-PM picks the run back up exactly where the work stands.
 */
export default function MaintenancePanel({ target, schedules, people, today, canEdit, catalogHint = false, posture, twoBox = false }: {
  target: WorkTarget; schedules: PmRow[]; people: string[]; today: string; canEdit: boolean;
  /**
   * custody.twoBox: completing or backfilling a PM asks for findings (which
   * travel with the machine) and a private note (which does not) instead of
   * one note. Off leaves the one-tap and the single note exactly as they were.
   */
  twoBox?: boolean;
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
   * Per-module fold state. Nothing here until somebody clicks: the DEFAULT is
   * derived - a module with work owed starts open, a quiet one folded - so
   * the page opens on exactly the rows that need someone, and a click is
   * remembered over the derivation from then on.
   */
  const [moduleOpen, setModuleOpen] = useState<Record<string, boolean>>({});
  /** Which rows are expanded to their detail. */
  const [taskOpen, setTaskOpen] = useState<Record<number, boolean>>({});
  /**
   * The visit as a mode. Nothing about the run is stored - completions are
   * real rows the moment they happen - so this is only "taps complete".
   */
  const [runMode, setRunMode] = useState(false);
  /**
   * Undo handles for taps made THIS session. undoPmComplete needs the record
   * task's id and the calendar as it stood, and the row we just rendered is
   * the honest source of both - so undo is offered only for completions this
   * screen made. An older completion is corrected with edit, as before.
   */
  const [undoable, setUndoable] = useState<Record<number, {
    taskId: number; prior: { nextDue: string; lastDone: string; bookedOn: string; bookedNote: string };
  }>>({});
  const [aligning, setAligning] = useState(false);
  const [alignDraft, setAlignDraft] = useState<{ mode: "lastDone" | "visit"; date: string; fileRecord: boolean }>({ mode: "lastDone", date: today, fileRecord: false });
  // Per-schedule backfill: one past completion, filed as the Done task it
  // would have left behind.
  const [logging, setLogging] = useState<number | null>(null);
  const [booking, setBooking] = useState<number | null>(null);
  const [bookDraft, setBookDraft] = useState({ date: "", note: "" });
  const [logDraft, setLogDraft] = useState({ date: "", note: "", doneBy: "", advanceSchedule: true, findings: "" });
  /* Under twoBox a completion is not one tap: the tap opens this, and filing
     is the second tap. Two words that travel are worth one more press. */
  const [finishing, setFinishing] = useState<number | null>(null);
  const [finishDraft, setFinishDraft] = useState({ findings: "", note: "" });
  const [pending, startTransition] = useTransition();

  if (!canEdit && schedules.length === 0) return null;

  const { active, next } = pmGroups(schedules, today);
  const advisory = posture?.effective === "advisory";

  /*
   * Procedure order, not date order. Stamped schedules are inserted in the
   * procedure's own step order, so id order IS the sequence the SOP works the
   * module in - drain before refill, leak test before seals. Urgency still
   * reads off every row (the dot, the standing), so nothing is lost by not
   * sorting on it; what is gained is a list that matches the binder.
   */
  const ordered = [...schedules].sort((a, b) => a.id - b.id);
  const modules = pmAssetGroups(ordered, today);
  const grouped = modules.length > 1;

  /* The order a RUN walks: module by module, as drawn - not raw id order,
     which interleaves the modules a stamped stack was built asset by asset. */
  const walk = modules.flatMap((m) => m.rows);
  const unpaused = walk.filter((s) => !s.paused);
  const doneCount = unpaused.filter((s) => doneToday(s, today)).length;
  /** The run's next step: first unpaused row in walk order not yet done today. */
  const nextRun = unpaused.find((s) => !doneToday(s, today)) ?? null;

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

  /** The one-tap complete. The whole run is this, once per wrench. */
  const complete = (s: PmRow, split?: { findings: string; note: string }) => {
    if (twoBox && !split) {
      // First tap opens the two boxes; the File button below calls back here
      // with them. The calendar is not touched until then.
      setFinishing(s.id); setFinishDraft({ findings: "", note: "" });
      setTaskOpen((m) => ({ ...m, [s.id]: true }));
      return;
    }
    startTransition(async () => {
      setError("");
      // Flag off: the identical call it always made, so nothing about the
      // one-tap changes for anybody who has not turned the split on.
      const res = split ? await completePmNow(s.id, split.note, split.findings) : await completePmNow(s.id);
      if (res?.error) { setError(res.error); setTaskOpen((m) => ({ ...m, [s.id]: true })); return; }
      if (!res.viaOpenTask && res.taskId) {
        setUndoable((m) => ({
          ...m,
          [s.id]: {
            taskId: res.taskId!,
            prior: { nextDue: s.nextDue, lastDone: s.lastDone, bookedOn: s.bookedOn ?? "", bookedNote: s.bookedNote ?? "" },
          },
        }));
      }
      setTaskOpen((m) => ({ ...m, [s.id]: false }));
      setFinishing(null);
      toast({ message: `Logged: ${s.title}` });
    });
  };

  const undoComplete = (s: PmRow) => {
    const u = undoable[s.id];
    if (!u) return;
    startTransition(async () => {
      setError("");
      const res = await undoPmComplete(s.id, u.taskId, u.prior);
      if (res?.error) { setError(res.error); return; }
      setUndoable((m) => { const n = { ...m }; delete n[s.id]; return n; });
      toast({ message: "Took it back" });
    });
  };

  /** The dot: one glance per row. Done and future are calm; owed is not. */
  const dotFor = (s: PmRow): string => {
    if (s.paused) return "var(--line)";
    if (doneToday(s, today)) return "var(--t-good-fg)";
    const st = pmStanding(s, today);
    if (advisory) return "var(--line)";
    if (st.kind === "overdue" || st.kind === "missed") return "var(--t-bad-fg)";
    if (st.kind === "dueToday") return "var(--t-warn-fg)";
    return "var(--t-good-fg)";
  };

  /** The row's one line of standing, in words rather than a second pill. */
  const metaFor = (s: PmRow): string => {
    if (doneToday(s, today)) return `Done today${s.assignee ? ` · ${s.assignee}` : ""}`;
    if (s.paused) return "Paused";
    const st = pmStanding(s, today);
    const tail = s.lastDone ? ` · last ${mdy(s.lastDone)}` : "";
    if (st.kind === "booked") return `Booked ${mdy(st.on)}${s.nextDue < st.on ? ` (was due ${mdy(s.nextDue)})` : ""}`;
    if (st.kind === "missed") return `Missed the ${mdy(st.on)} visit`;
    if (advisory) return `${st.kind === "upcoming" ? "Next cycle" : "Cycle elapsed"} ${mdy(s.nextDue)}${tail}`;
    if (st.kind === "overdue") return `Overdue ${mdy(st.since)}${tail}`;
    if (st.kind === "dueToday") return `Due today${tail}`;
    return `Next ${mdy(s.nextDue)}${tail}${s.openTaskId !== null ? " · task open" : ""}`;
  };

  /**
   * One row: the scan line, and everything else behind it.
   *
   * TWO gestures, never one. The BOX is the work - it completes the step, or
   * takes the tap back - and only during a run, so browsing can never complete
   * anything. The ROW always opens the detail, in a run exactly as outside one,
   * because the parts, the spec and the notes are what an engineer reads BEFORE
   * the wrench; a run that hides them to protect its own gesture is a run
   * nobody can work from. (The mockup had one gesture and this defect with it.)
   */
  const renderTask = (s: PmRow, seq: number) => {
    const e = editing[s.id];
    const isOpen = !!taskOpen[s.id];
    const done = doneToday(s, today);
    const isNext = runMode && nextRun?.id === s.id;
    /* A paused step is skipped by a run, and a completion this screen did not
       make has no honest undo - so neither offers a tap. */
    const tappable = runMode && canEdit && !s.paused && (!done || !!undoable[s.id]);
    /* Thumb-sized while it is a control, quiet marginalia the rest of the time. */
    const big = runMode && canEdit;
    const boxStyle = {
      flex: "none", width: big ? 34 : 22, height: big ? 34 : 22, borderRadius: big ? 10 : 7,
      border: `1px ${s.paused ? "dashed" : "solid"} ${done ? "var(--t-good-fg)" : "var(--line)"}`,
      background: done ? "var(--t-good-fg)" : "transparent",
      color: done ? "#fff" : "var(--mut)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 0, fontSize: 11, fontWeight: 700,
      cursor: tappable ? "pointer" : "default",
    } as const;
    return (
      <div key={s.id} style={{
        borderTop: "1px solid var(--line)",
        background: isNext ? "#EEF3F9" : undefined,
        boxShadow: isNext ? "inset 3px 0 0 var(--navy)" : undefined,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 2px", opacity: s.paused ? 0.55 : 1 }}>
          {/* The sequence box: the procedure's own numbering, ✓ once today's
              cycle is in. Numbered even when paused - the step exists, it is
              simply skipped - dashed so a run reads past it. */}
          {tappable ? (
            <button type="button" disabled={pending} style={boxStyle}
              aria-label={done ? `Undo completion of ${s.title}` : `Complete ${s.title}`}
              onClick={() => (done ? undoComplete(s) : complete(s))}>
              {done ? "✓" : seq}
            </button>
          ) : (
            <span aria-hidden style={boxStyle}>{done ? "✓" : seq}</span>
          )}
          <div role="button" tabIndex={0} aria-expanded={isOpen}
            aria-label={`${s.title}${done ? ", done today" : ""}`}
            className="row-hover"
            onClick={() => setTaskOpen((m) => ({ ...m, [s.id]: !isOpen }))}
            onKeyDown={(ev) => {
              if (ev.key !== "Enter" && ev.key !== " ") return;
              ev.preventDefault();
              setTaskOpen((m) => ({ ...m, [s.id]: !isOpen }));
            }}
            style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="t-body" style={{
                display: "block", fontWeight: 600,
                color: done ? "var(--mut)" : undefined,
                textDecoration: done ? "line-through" : undefined,
              }}>{s.title}</span>
              <span className="mut t-meta" style={{ display: "block" }}>{metaFor(s)}</span>
            </span>
            <span className="pill neutral" style={{ flex: "none" }}>{cadenceLabel(s.everyDays)}</span>
            <span aria-hidden style={{ flex: "none", width: 8, height: 8, borderRadius: 99, background: dotFor(s) }} />
          </div>
        </div>

        {isOpen && (
          <div style={{ padding: `0 2px 10px ${big ? 44 : 34}px` }}>
            {s.body && <div className="mut t-small" style={{ whiteSpace: "pre-wrap", marginBottom: 4 }}>{s.body}</div>}
            <div className="mut t-meta" style={{ marginBottom: 6 }}>
              {cadenceLabel(s.everyDays)}
              {s.lastDone ? ` · last done ${mdy(s.lastDone)}` : " · never done yet"}
              {s.assignee ? ` · ${s.assignee}` : ""}
              {s.bookedOn ? ` · booked ${mdy(s.bookedOn)}${s.bookedNote ? ` (${s.bookedNote})` : ""}` : ""}
              {s.openTaskId !== null ? " · open in Tasks" : ""}
            </div>

            {s.parts.filter((pt) => pt.number).map((pt) => {
              const key = `${s.id}:${pt.number}`;
              return (
                <div key={key} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 3, flexWrap: "wrap" }}>
                  {/* partLabel rather than a second spelling of it: this line
                      sits next to the button that actually orders the part. */}
                  <span className="mono mut t-meta">{partLabel(pt)}</span>
                  {canEdit && (requested[key]
                    ? <span className="t-meta" style={{ color: requested[key] === "ok" ? "var(--t-good-fg)" : "var(--t-bad-fg)" }}>
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

            {canEdit && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
                {done ? (
                  undoable[s.id] ? (
                    <button className="btn sm" disabled={pending} onClick={() => undoComplete(s)}>
                      Undo today&apos;s completion
                    </button>
                  ) : (
                    <span className="mut t-small">Done today. A slip is fixed with edit.</span>
                  )
                ) : !s.paused && (
                  <button className="btn sm accent" disabled={pending} onClick={() => complete(s)}>
                    Complete now
                  </button>
                )}
                {!done && (
                  <button className="btn sm" disabled={pending}
                    title="File a completion that happened before the software was watching"
                    onClick={() => {
                      setLogging(logging === s.id ? null : s.id);
                      setLogDraft({ date: "", note: "", doneBy: "", advanceSchedule: true, findings: "" });
                    }}>Log past</button>
                )}
                {/* An early start that nobody has touched can simply be taken
                    back - the click created a task, never moved the dates. */}
                {s.openTaskId !== null && !s.paused && s.nextDue > today && (
                  <button className="btn link" disabled={pending}
                    title="Removes the task the early start created. The schedule's due date was never touched."
                    onClick={() => startTransition(async () => {
                      const res = await undoRunPmNow(s.id);
                      if (res?.error) setError(res.error);
                      else toast({ message: "Removed the task" });
                    })}>undo start</button>
                )}
                <RowActions inline={0} menuLabel={`Actions for ${s.title}`} items={[
                  /* "Start as task" is the long way kept on purpose: it is how
                     a job gets ASSIGNED, worked against its checklist, and how
                     a measured test records its number. */
                  ...(!s.paused && s.openTaskId === null && !done
                    ? [{ label: "Start as task", onClick: () => startTransition(async () => {
                        const res = await runPmNow(s.id);
                        setError(res?.error ?? "");
                        if (!res?.error) toast({ message: "Created the task - it is in Tasks" });
                      }) }] : []),
                  ...(!s.paused ? [{
                    label: s.bookedOn ? "Rebook the visit" : "Schedule the visit",
                    onClick: () => {
                      setBooking(booking === s.id ? null : s.id);
                      setBookDraft({ date: s.bookedOn || "", note: s.bookedNote || "" });
                    },
                  }] : []),
                  ...(!s.paused && s.bookedOn ? [{
                    label: "Unbook", onClick: () => startTransition(async () => {
                      const res = await unschedulePmVisit(s.id);
                      if (res?.error) setError(res.error);
                      else toast({ message: "Called the visit off - back on the cycle date" });
                    }),
                  }] : []),
                  {
                    label: e ? "Close edit" : "Edit", onClick: () =>
                      setEditing((m) => e ? (() => { const n = { ...m }; delete n[s.id]; return n; })() : ({
                        ...m, [s.id]: { assignee: s.assignee, everyDays: String(s.everyDays), nextDue: s.nextDue, lastDone: s.lastDone },
                      })),
                  },
                  {
                    label: s.paused ? "Resume" : "Pause", onClick: () => startTransition(async () => {
                      const res = await setPmPaused(s.id, !s.paused);
                      if (res?.error) setError(res.error);
                      else toast({ message: s.paused ? "Resumed the schedule" : "Paused the schedule" });
                    }),
                  },
                  {
                    label: "Remove", tone: "bad" as const, onClick: async () => {
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
                    },
                  },
                ] satisfies RowAction[]} />
              </div>
            )}

            {booking === s.id && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 6, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "#FAFBFD" }}>
                <input type="date" value={bookDraft.date} min={today} aria-label="Visit day"
                  onChange={(ev) => setBookDraft({ ...bookDraft, date: ev.target.value })}
                  className="t-small" style={{ width: "auto" }} />
                <input value={bookDraft.note} placeholder='Note - "per J. Alvarez, window 9-12" (optional)'
                  onChange={(ev) => setBookDraft({ ...bookDraft, note: ev.target.value })}
                  className="t-small" style={{ width: "auto", flex: "1 1 180px" }} />
                <button className="btn sm accent" disabled={pending || !bookDraft.date}
                  onClick={() => startTransition(async () => {
                    const res = await schedulePmVisit(s.id, bookDraft);
                    if (res?.error) { setError(res.error); return; }
                    setBooking(null);
                    toast({ message: `Booked for ${bookDraft.date} - the due date was not touched` });
                  })}>
                  Book the visit
                </button>
                <span className="mut t-meta">
                  Quiet until the day; the cycle still reads as due {mdy(s.nextDue)}.
                </span>
              </div>
            )}
            {finishing === s.id && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 6, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "#FAFBFD" }}>
                <div className="field" style={{ flex: "2 1 220px", marginBottom: 0 }}>
                  <label>Findings</label>
                  <input value={finishDraft.findings} placeholder="What was found - travels with the machine"
                    onChange={(ev) => setFinishDraft({ ...finishDraft, findings: ev.target.value })}
                    className="t-small" style={{ width: "100%" }} />
                </div>
                <div className="field" style={{ flex: "2 1 220px", marginBottom: 0 }}>
                  <label>Private note <span className="field-opt">(stays)</span></label>
                  <input value={finishDraft.note} placeholder="Lot, cost, who to call - never leaves here"
                    onChange={(ev) => setFinishDraft({ ...finishDraft, note: ev.target.value })}
                    className="t-small" style={{ width: "100%" }} />
                </div>
                <button className="btn sm accent" disabled={pending} onClick={() => complete(s, finishDraft)}>
                  File it
                </button>
                <button className="btn sm" disabled={pending} onClick={() => setFinishing(null)}>Cancel</button>
              </div>
            )}
            {logging === s.id && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 6, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "#FAFBFD" }}>
                <input type="date" value={logDraft.date} aria-label="Date it was done"
                  onChange={(ev) => setLogDraft({ ...logDraft, date: ev.target.value })}
                  className="t-small" style={{ width: "auto" }} />
                <input value={logDraft.doneBy} placeholder="By (vendor or engineer, optional)"
                  onChange={(ev) => setLogDraft({ ...logDraft, doneBy: ev.target.value })}
                  className="t-small" style={{ width: "auto", flex: "1 1 130px" }} />
                {twoBox && (
                  <input value={logDraft.findings} placeholder="Findings - travels with the machine"
                    aria-label="Findings, which travel with the machine"
                    onChange={(ev) => setLogDraft({ ...logDraft, findings: ev.target.value })}
                    className="t-small" style={{ width: "auto", flex: "2 1 150px" }} />
                )}
                <input value={logDraft.note} placeholder={twoBox ? "Private note (stays)" : "Note (optional)"}
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
                  className="t-small" style={{ width: "auto" }} aria-label="Assignee">
                  <option value="">unassigned</option>
                  {people.map((p) => <option key={p}>{p}</option>)}
                </select>
                <button className="btn sm accent" onClick={() => saveEdit(s.id)} disabled={pending}>Save</button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  /** The chip on a module header: owed first, then progress, then size. */
  const moduleChip = (rows: PmRow[], due: number) => {
    const act = rows.filter((r) => !r.paused);
    const dn = act.filter((r) => doneToday(r, today)).length;
    if (act.length > 0 && dn === act.length) return <span className="pill good">complete ✓</span>;
    if (due > 0) return <span className={`pill ${advisory ? "neutral" : "bad"}`}>{due} {advisory ? "cycled" : "due"}</span>;
    if (dn > 0) return <span className="pill good">{dn} of {act.length} done</span>;
    return <span className="mut t-meta">{rows.length} task{rows.length === 1 ? "" : "s"}</span>;
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <button onClick={() => setPanelOpen((v) => !v)} aria-expanded={panelOpen}
          style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", padding: 0, cursor: "pointer" }}>
          <span aria-hidden className="t-meta" style={{ color: "var(--mut)", width: 12 }}>{panelOpen ? "▾" : "▸"}</span>
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

      {/* The visit, as a strip: progress across every unpaused schedule, and
          the run toggle. Progress is derived (done today / all), so it reads
          the same on a phone that just rebooted mid-PM. Shown only while it
          says something - a quiet Tuesday needs no 0/29. */}
      {schedules.length > 0 && canEdit && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8, padding: "8px 10px", borderRadius: 10, background: runMode ? "#EEF3F9" : "#F7F9FC", border: "1px solid var(--line)" }}>
          <button className={`btn sm ${runMode ? "" : "primary"}`} disabled={pending}
            onClick={() => setRunMode((v) => !v)}>
            {runMode ? "End PM run" : "Start PM run"}
          </button>
          {(runMode || doneCount > 0) && (
            <>
              <span style={{ flex: "1 1 120px", height: 6, borderRadius: 99, background: "var(--line)", overflow: "hidden" }}
                role="progressbar" aria-valuemin={0} aria-valuemax={unpaused.length} aria-valuenow={doneCount}
                aria-label="PM run progress">
                <span style={{ display: "block", height: "100%", width: `${unpaused.length ? (doneCount / unpaused.length) * 100 : 0}%`, background: "var(--t-good-fg)" }} />
              </span>
              <span className="mut t-small" style={{ fontVariantNumeric: "tabular-nums" }}>
                {doneCount}/{unpaused.length}
              </span>
            </>
          )}
          <span className="mut t-small" style={{ flex: "1 1 180px" }}>
            {runMode
              ? nextRun
                ? "Tap the box to complete a step - record filed, next cycle booked. Tap the name to read it first."
                : "Every step is in. End the run and file the visit report from Tasks."
              : doneCount > 0
                ? `${doneCount} completed today.`
                : "A run walks the steps in procedure order, one tap each."}
          </span>
        </div>
      )}

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
          <span className="mut" style={{ fontSize: 12, flex: "1 1 200px" }}>{posture.note}</span>
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
            placeholder="Steps, spec or notes for whoever does it (optional)" className="t-body" style={{ width: "100%", marginBottom: 6, resize: "vertical" }} />
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

      {/* By MODULE, the way the binder reads and the way a visit walks the
          stack. One module (a bare asset page, an unstacked system) skips the
          accordion - a fold with nothing to tell apart is a click tax. */}
      {grouped ? modules.map((m) => {
        /* Open by default when something is owed here, or when the run's next
           step is inside - a run must never highlight a row nobody can see. */
        const holdsNext = runMode && nextRun !== null && m.rows.some((r) => r.id === nextRun.id);
        const isOpen = holdsNext || (moduleOpen[m.key] ?? m.due > 0);
        return (
          <div key={m.key} style={{ border: "1px solid var(--line)", borderRadius: 10, marginBottom: 8, overflow: "hidden" }}>
            <button onClick={() => setModuleOpen((x) => ({ ...x, [m.key]: !isOpen }))} aria-expanded={isOpen}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", background: "#F7F9FC", border: "none", padding: "9px 12px", cursor: "pointer", textAlign: "left", flexWrap: "wrap" }}>
              <span aria-hidden style={{ fontSize: 10, color: "var(--mut)", width: 12 }}>{isOpen ? "▾" : "▸"}</span>
              <span className="t-body" style={{ fontWeight: 700, flex: "1 1 140px", minWidth: 0 }}>{m.label}</span>
              {moduleChip(m.rows, m.due)}
            </button>
            {isOpen && (
              <div style={{ padding: "0 10px" }}>
                {m.rows.map((r, i) => renderTask(r, i + 1))}
              </div>
            )}
          </div>
        );
      }) : ordered.map((r, i) => renderTask(r, i + 1))}

      {schedules.length === 0 && !open && (
        <div className="mut t-small">Nothing scheduled yet.</div>
      )}
      </>)}
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
    </div>
  );
}
