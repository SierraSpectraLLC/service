"use client";

import Link from "next/link";
import { promptReason } from "@/lib/reason";
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { TASK_STATES, TASK_TONE } from "@/lib/stages";
import type { WorkTarget } from "@/app/actions";
import { fmtWhen } from "@/lib/when";
import {
  createTask, updateTask, deleteTask, setTaskState, assignTask, addChecklistItem,
  toggleChecklistItem, deleteChecklistItem, addItemNote, addTaskNote, setTaskWorkOrder,
  updateItemNote, deleteItemNote, updateTaskNote, deleteTaskNote, setTaskDue, setTaskAsset, copyTasksTo,
  recordTaskResult,
} from "@/app/actions";
import { RESULT_LABEL } from "@/lib/checkout";
import { evaluateResult, resultIsRecorded, toleranceBand } from "@/lib/testResult";
import { checklistProgress } from "@/lib/checklist";
import MentionBox from "./MentionBox";
import type { Candidate } from "@/lib/mentions";
import Dialog from "@/components/ui/Dialog";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";

type Note = { id: number; author: string; text: string; createdAt: string };
type Item = { id: number; text: string; done: boolean; heading?: boolean; thread: Note[] };
/** The catalog's spec, when the procedure behind this task is a test. */
type TestSpec = { resultType: string; target: string | null; tolerancePct: string | null };
type TaskResult = {
  value: string; passed: boolean | null; note: string; recordedBy: string; recordedAt: string;
};
type Task = {
  id: number; title: string; body: string; state: string; assignee: string; dueDate: string;
  assetId: number | null; origin: string; workOrderId?: number | null;
  checklist: Item[]; notes: Note[]; createdAt: string; completedAt: string | null;
  test?: TestSpec | null; result?: TaskResult | null;
};
type SystemAsset = { id: number; label: string };

const when = (iso: string) => fmtWhen(iso);

/** Due-date chip: red when overdue, amber today/tomorrow, plain otherwise. Dates are shop-day strings. */
function DueChip({ due, done, today }: { due: string; done: boolean; today: string }) {
  if (!due) return null;
  const [y, m, d] = due.split("-");
  const label = `${parseInt(m)}/${parseInt(d)}`;
  const overdue = !done && due < today;
  const soon = !done && due === today;
  const tone = overdue ? "bad" : soon ? "warn" : "neutral";
  return (
    <span className={`pill ${tone}`} title={`Due ${y}-${m}-${d}`}>
      {overdue ? "overdue " : soon ? "due today" : "due "}{soon ? "" : label}
    </span>
  );
}

// Small optimistic wrappers so taps register instantly; the server action and
// revalidation reconcile behind them.
function ItemCheckbox({ item, canEdit }: { item: Item; canEdit: boolean }) {
  const [, startTransition] = useTransition();
  const [done, setOptimistic] = useOptimistic(item.done, (_cur: boolean, next: boolean) => next);
  return (
    <input type="checkbox" checked={done} disabled={!canEdit}
      onChange={() => startTransition(async () => { setOptimistic(!done); await toggleChecklistItem(item.id); })}
      style={{ width: 16, height: 16, accentColor: "var(--coral)", cursor: canEdit ? "pointer" : "default" }} />
  );
}

function TaskStateSelect({ task }: { task: Task }) {
  const [, startTransition] = useTransition();
  const [state, setOptimistic] = useOptimistic(task.state, (_cur: string, next: string) => next);
  // The server can refuse a Done (a test with no result). Say why, rather than
  // letting the select snap back on its own and look like a glitch.
  const [refused, setRefused] = useState("");
  return (
    <>
      <select value={state} onChange={(e) => startTransition(async () => {
        setOptimistic(e.target.value);
        setRefused("");
        const res = await setTaskState(task.id, e.target.value);
        if (res?.error) setRefused(res.error);
      })} style={{ width: "auto", fontWeight: 700, fontSize: 12 }}>
        {TASK_STATES.map((s) => <option key={s}>{s}</option>)}
      </select>
      {refused && <span style={{ fontSize: 11, color: "#A32D2D", flexBasis: "100%" }}>{refused}</span>}
    </>
  );
}

/**
 * Where the number goes.
 *
 * A test used to be finished with the same checkbox as "tighten the fitting",
 * with its target sitting in the body as prose. The reading it produced went
 * into somebody's notebook, or into a file uploaded later, or nowhere. So this
 * sits above the status control on any task the catalog calls a test: enter
 * what it read, get the verdict against the band the catalog set, and only then
 * can the task close.
 *
 * A failure records and closes like anything else. The point is the number, and
 * a task held open by a bad reading just files the failure where nobody looks.
 */
function TestResultBlock({ task, canEdit }: { task: Task; canEdit: boolean }) {
  const spec = task.test!;
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(!task.result);
  const [value, setValue] = useState(task.result?.value ?? "");
  const [note, setNote] = useState(task.result?.note ?? "");
  const [error, setError] = useState("");

  const band = toleranceBand(spec);
  const live = evaluateResult(spec, value);
  const r = task.result;
  const verdictTone = (p: boolean | null) =>
    p === true ? "good" : p === false ? "bad" : "neutral";

  const save = () => {
    setError("");
    startTransition(async () => {
      const res = await recordTaskResult(task.id, { value, note });
      if (res?.error) { setError(res.error); return; }
      setEditing(false);
    });
  };

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10, marginBottom: 12, background: "#fff" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginBottom: 6 }}>
        <span className="eyebrow">Result</span>
        <span className="mut" style={{ fontSize: 11 }}>
          {RESULT_LABEL[spec.resultType] ?? spec.resultType}
          {spec.target ? ` · target ${spec.target}` : ""}
          {band ? ` · passes ${band}` : ""}
        </span>
      </div>

      {/* Recorded: the reading, what it means, and who stands behind it. */}
      {r && !editing && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className={`pill ${
            /^replaced$/i.test(r.value) ? "warn"
              : /^inspected$/i.test(r.value) ? "info"
              : verdictTone(r.passed)
          }`}>
            {r.passed === true ? "Pass" : r.passed === false ? "Fail"
              : /^(inspected|replaced)$/i.test(r.value) ? r.value : "Recorded"}
          </span>
          {!/^(inspected|replaced)$/i.test(r.value) && <span style={{ fontSize: 13, fontWeight: 600 }}>{r.value}</span>}
          {band && <span className="mut" style={{ fontSize: 11 }}>of {band}</span>}
          {r.note && <span className="mut" style={{ fontSize: 12 }}>- {r.note}</span>}
          <span className="mut" style={{ fontSize: 11, marginLeft: "auto" }}>
            {r.recordedBy}{r.recordedAt ? ` · ${when(r.recordedAt)}` : ""}
          </span>
          {canEdit && <button className="btn link" onClick={() => setEditing(true)}>correct it</button>}
        </div>
      )}

      {canEdit && editing && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
          {spec.resultType === "pass_fail" || spec.resultType === "inspect_replace" ? (
            <div className="seg" role="group" aria-label="Result">
              {(spec.resultType === "pass_fail" ? ["Pass", "Fail"] : ["Inspected", "Replaced"]).map((v) => (
                <button key={v} type="button" aria-pressed={value === v} onClick={() => setValue(v)}>{v}</button>
              ))}
            </div>
          ) : (
            <input value={value} onChange={(e) => setValue(e.target.value)} aria-label="What it read"
              placeholder={spec.resultType === "note" ? "What you found" : spec.target ? `e.g. ${spec.target}` : "e.g. 5.2 mL/min"}
              style={{ width: "auto", flex: "1 1 140px", fontSize: 13 }} />
          )}
          <input value={note} onChange={(e) => setNote(e.target.value)} aria-label="Conditions or anything odd"
            placeholder={spec.resultType === "inspect_replace"
              ? value === "Replaced" ? "What went in - part #, serial (optional)" : "What you found (optional)"
              : "Conditions, anything odd (optional)"}
            style={{ width: "auto", flex: "2 1 180px", fontSize: 13 }} />
          <button className="btn sm accent" disabled={pending || !resultIsRecorded(spec.resultType, value)} onClick={save}>
            {pending ? "Recording..." : "Record"}
          </button>
          {r && <button className="btn sm" onClick={() => { setEditing(false); setValue(r.value); setNote(r.note); setError(""); }}>Cancel</button>}
          {/* The verdict before it is committed, so a bad reading is obvious
              while the instrument is still in front of you. */}
          {live.why && live.passed !== null && (
            <span className={`pill ${verdictTone(live.passed)}`} style={{ flexShrink: 0 }}>
              {live.passed ? "in band" : "out of band"}
            </span>
          )}
        </div>
      )}

      {!canEdit && !r && <div className="mut" style={{ fontSize: 12 }}>Not recorded yet.</div>}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
    </div>
  );
}

function AssigneeSelect({ task, people }: { task: Task; people: string[] }) {
  const [, startTransition] = useTransition();
  const [assignee, setOptimistic] = useOptimistic(task.assignee, (_cur: string, next: string) => next);
  // Keep a legacy assignee visible even if they've left the roster.
  const options = ["", ...people, ...(assignee && !people.includes(assignee) ? [assignee] : [])];
  return (
    <select value={assignee} onChange={(e) => startTransition(async () => { setOptimistic(e.target.value); await assignTask(task.id, e.target.value); })}
      style={{ width: "auto", fontWeight: 700, fontSize: 12 }}>
      {options.map((p) => <option key={p} value={p}>{p || "-"}</option>)}
    </select>
  );
}

export default function TasksPanel({
  target, tasks, people, systemAssets, today, canEdit, isStaff, copyTargets = [], procedureChoices = [], jobs = [], mentionable = [],
}: {
  target: WorkTarget; tasks: Task[]; people: string[];
  systemAssets: SystemAsset[]; today: string; canEdit: boolean; isStaff: boolean;
  /** Records this person may write to, for copying a batch of tasks across. */
  copyTargets?: { key: string; label: string }[];
  /**
   * Catalog procedures that apply to this record, offered as starting points
   * for a new task: picking one pre-fills the form, and the server stamps its
   * checklist and carries its test spec (pass/fail, target) onto the task.
   */
  procedureChoices?: { id: number; title: string; body: string; brings: string }[];
  /**
   * Open work orders on this record. When given, tasks belonging to a job fold
   * under one band per job instead of reading as loose shop tasks - the job is
   * the unit of work here, and its internals are one click away, not fifteen
   * rows deep. The job's own page passes nothing and stays flat.
   */
  jobs?: { id: number; number: string; title: string; state: string }[];
  /**
   * The directory with emails and orgs, for the @mention dropdown. `people`
   * stays the plain name list the assignee selects want; this is the same
   * folks with enough detail to tell two Nicks apart.
   */
  mentionable?: Candidate[];
}) {
  const assetLabel = (id: number | null) => systemAssets.find((a) => a.id === id)?.label ?? null;
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [openJobs, setOpenJobs] = useState<number[]>([]);
  const [jobNote, setJobNote] = useState<null | { id: number; text: string }>(null);
  // Arriving from a system's job band: #task-N names which one to open. Read
  // once on mount rather than watched, because after that the person is
  // working the page and a stale hash must not keep yanking it about.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current) return;
    landed.current = true;
    const m = /^#task-(\d+)$/.exec(window.location.hash);
    if (!m) return;
    const id = parseInt(m[1]);
    if (!tasks.some((t) => t.id === id)) return;
    setExpanded(id);
    // After the row has unfolded, or it scrolls to where it used to be.
    requestAnimationFrame(() => {
      document.getElementById(`task-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, [tasks]);

  const toggleJob = (id: number) =>
    setOpenJobs((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));
  const [draft, setDraft] = useState({ title: "", body: "", assignee: "", dueDate: "", assetId: null as number | null, resultType: "", procedureId: null as number | null });
  const [editing, setEditing] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState({ title: "", body: "" });
  const [inputs, setInputs] = useState<Record<string, string | boolean>>({});
  // Copying is a mode rather than a permanent column of checkboxes: a list of
  // twenty tasks is read far more often than it is copied, and a checkbox on
  // every row would be in the way every other time.
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [copyTo, setCopyTo] = useState("");
  const [copyNote, setCopyNote] = useState("");
  const [pending, startTransition] = useTransition();
  const setInput = (k: string, v: string | boolean) => setInputs((s) => ({ ...s, [k]: v }));

  // Auto-generated checkout tests sit under their own header until done.
  const checkout = tasks.filter((t) => t.state !== "Done" && t.origin === "checkout");
  // A task inside a listed job renders under that job's band, not loose - the
  // system's list answers "what does the shop owe", and the answer is the JOB,
  // not its internals. Tasks of jobs not listed (closed, or none given) stay
  // loose so nothing ever disappears.
  const jobOf = (t: Task) => jobs.find((j) => j.id === t.workOrderId);
  const undone = tasks.filter((t) => t.state !== "Done" && t.origin !== "checkout");
  const active = undone.filter((t) => !jobOf(t));
  const jobBands = jobs
    .map((j) => ({ job: j, rows: tasks.filter((t) => t.workOrderId === j.id) }))
    .filter((b) => b.rows.length > 0);
  const complete = tasks.filter((t) => t.state === "Done" && !jobOf(t));

  // One renderer for both note threads; staff get inline edit / delete.
  const renderNote = (m: Note, kind: "item" | "task") => {
    const key = `editnote-${kind}-${m.id}`;
    const noteDraft = inputs[key];
    const isEditing = typeof noteDraft === "string";
    const save = () => {
      const v = (noteDraft as string).trim();
      if (v) startTransition(() => (kind === "item" ? updateItemNote(m.id, v) : updateTaskNote(m.id, v)));
      setInput(key, false);
    };
    return (
      <div key={m.id} style={{ marginBottom: kind === "task" ? 6 : 0 }}>
        <div style={{ fontSize: 12 }}>
          <b style={{ color: "var(--navy)" }}>{m.author}</b>{" "}
          <span className="mut" style={{ fontSize: 11 }}>{when(m.createdAt)}</span>
          {canEdit && !isEditing && (
            <>
              {" "}<button className="btn link" style={{ fontSize: 11 }} onClick={() => setInput(key, m.text)}>edit</button>
              <button className="btn link" style={{ fontSize: 11, color: "#A32D2D", padding: "0 4px" }}
                onClick={async () => {
                  if (!(await confirmDialog({ title: "Delete this note?", action: "Delete note", tone: "bad" }))) return;
                  startTransition(async () => {
                    await (kind === "item" ? deleteItemNote(m.id) : deleteTaskNote(m.id));
                    toast({ message: "Deleted the note" });
                  });
                }}>×</button>
            </>
          )}
        </div>
        {isEditing ? (
          <div style={{ display: "flex", gap: 6, marginTop: 3 }}>
            <input value={noteDraft as string} onChange={(e) => setInput(key, e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setInput(key, false); }}
              autoFocus style={{ flex: 1, fontSize: 12, padding: "5px 9px" }} />
            <button className="btn sm" onClick={save}>Save</button>
          </div>
        ) : (
          <div style={{ fontSize: 13 }}>{m.text}</div>
        )}
      </div>
    );
  };

  const submitNew = () => {
    if (!draft.title.trim()) return;
    startTransition(async () => {
      // Spread, not rebuild: this panel also sits on a work order's page, and
      // rebuilding the target from named fields silently dropped workOrderId -
      // so a task filed from the job landed on the system but not the job.
      const res = await createTask(
        { ...target, assetId: draft.assetId ?? target.assetId },
        { title: draft.title, body: draft.body, assignee: draft.assignee, dueDate: draft.dueDate, resultType: draft.resultType, procedureId: draft.procedureId },
      );
      if (res?.error) return;
      setDraft({ title: "", body: "", assignee: "", dueDate: "", assetId: null, resultType: "", procedureId: null });
      setShowNew(false);
    });
  };

  const toggle = (id: number) =>
    setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  /**
   * One task row. `linkTo` turns it into a signpost instead of a workbench:
   * inside a job's band on a system page the row does not unfold, it takes you
   * to that task on the job's own page. A job's work is done in one place, and
   * a half-editable copy of it on the system was two.
   */
  const renderTask = (t: Task, isDone: boolean, linkTo?: string) => {
    const open = !linkTo && expanded === t.id;
    // Headings are labels, not boxes - counting them reports a finished job as
    // 12/14 forever. See lib/checklist.
    const progress = checklistProgress(t.checklist);
    const rowStyle = { display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", flexWrap: "wrap" } as const;
    const inner = (<>
          {picking && (
            <input type="checkbox" checked={picked.has(t.id)} readOnly tabIndex={-1}
              aria-label={`Copy ${t.title}`} style={{ width: 15, height: 15, flexShrink: 0, pointerEvents: "none" }} />
          )}
          <span className={`pill ${TASK_TONE[t.state] ?? "neutral"}`}>{t.state}</span>
          <span style={{ fontSize: 13, fontWeight: 700, flex: "1 1 160px", minWidth: 0, textDecoration: isDone ? "line-through" : "none", color: isDone ? "var(--mut)" : "var(--ink)" }}>{t.title}</span>
          {progress.total > 0 && (
            <span className="mut" style={{ fontSize: 11 }}>{progress.done}/{progress.total}</span>
          )}
          {/* A test reads as a test in a list of twenty, and carries its verdict
              once it has one - the reading is the outcome, not the checkbox. */}
          {t.test && (
            <span className={`pill ${
              t.result?.passed === true ? "good"
              : t.result?.passed === false ? "bad"
              : t.result && /^replaced$/i.test(t.result.value) ? "warn"
              : t.result && /^inspected$/i.test(t.result.value) ? "info"
              : t.result ? "neutral"
              : "warn"
            }`}>
              {/* For a pass/fail the value IS the verdict, so printing both
                  read "fail Fail". The verdict word alone for those; for a
                  measurement the number, with its verdict when there is one. */}
              {t.result ? (t.result.passed === true ? (/^pass$/i.test(t.result.value) ? "Pass" : `pass ${t.result.value}`)
                  : t.result.passed === false ? (/^fail$/i.test(t.result.value) ? "Fail" : `fail ${t.result.value}`)
                  : t.result.value)
                : t.test.resultType === "inspect_replace" ? "outcome needed" : "no result"}
            </span>
          )}
          {assetLabel(t.assetId) && <span className="pill accent">{assetLabel(t.assetId)}</span>}
          {/* Work the client asked for, rather than work we found. Reads differently
              in a list of twenty, and answers "who is waiting on this". */}
          {(t.origin === "issue" || t.origin === "pm_request") && (
            <span className="pill warn">
              {t.origin === "issue" ? "reported" : "requested"}
            </span>
          )}
          <DueChip due={t.dueDate} done={isDone} today={today} />
          <span style={{ fontSize: 12, fontWeight: 700, color: t.assignee ? "var(--navy)" : "var(--mut)" }}>{t.assignee || "-"}</span>
          <span className="mut" style={{ fontSize: 12 }}>{linkTo ? "→" : open ? "▾" : "▸"}</span>
      </>);
    return (
      <div key={t.id} id={`task-${t.id}`}
        style={{ border: "1px solid var(--line)", borderRadius: 10, marginBottom: 8, overflow: "hidden", opacity: isDone && !open ? 0.7 : 1 }}>
        {linkTo ? (
          <Link href={linkTo} className="row-hover" style={{ ...rowStyle, textDecoration: "none", color: "inherit" }}>
            {inner}
          </Link>
        ) : (
          <div className="row-hover" onClick={() => (picking ? toggle(t.id) : setExpanded(open ? null : t.id))} style={rowStyle}>
            {inner}
          </div>
        )}

        {open && (
          <div style={{ borderTop: "1px solid var(--line)", padding: 12, background: "#FAFBFD" }}>
            {editing === t.id && (
              <Dialog open onClose={() => setEditing(null)} title="Edit task"
                footer={
                  <>
                    <span className="dialog-status" />
                    <button className="btn" onClick={() => setEditing(null)} disabled={pending}>Cancel</button>
                    <button className="btn accent" disabled={pending || !editDraft.title.trim()}
                      onClick={() => startTransition(async () => {
                        await updateTask(t.id, editDraft);
                        setEditing(null);
                        toast({ message: "Saved the task" });
                      })}>
                      {pending ? "Saving..." : "Save task"}
                    </button>
                  </>
                }>
                <label>Title *</label>
                <input value={editDraft.title} onChange={(e) => setEditDraft({ ...editDraft, title: e.target.value })} style={{ marginBottom: 8 }} />
                <label>Body</label>
                <textarea value={editDraft.body} onChange={(e) => setEditDraft({ ...editDraft, body: e.target.value })} rows={2} style={{ marginBottom: 8, resize: "vertical" }} />
              </Dialog>
            )}
            {editing !== t.id && t.body && <div style={{ fontSize: 13, marginBottom: 10 }}>{t.body}</div>}
            {t.test && <TestResultBlock task={t} canEdit={canEdit} />}
            {canEdit && editing !== t.id && (
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                <span className="mut" style={{ fontSize: 12 }}>Status:</span>
                <TaskStateSelect task={t} />
                {/* Which job this belongs to, if any. The common case is a job
                    that grew - the order was opened and the tasks answering it
                    were written before anybody filed them under it - and it is
                    also how work predating the work-order tag gets adopted. */}
                {jobs.length > 0 && (
                  <>
                    <span className="mut" style={{ fontSize: 12 }}>Job:</span>
                    <select value={t.workOrderId ?? ""} aria-label={`Job for ${t.title}`}
                      onChange={(e) => {
                        const to = e.target.value ? parseInt(e.target.value) : null;
                        // Unfold the band it lands in, or the task appears to
                        // vanish: it hops out of the loose list into a fold
                        // that is closed by default.
                        if (to !== null) setOpenJobs((o) => (o.includes(to) ? o : [...o, to]));
                        startTransition(async () => {
                          const res = await setTaskWorkOrder(t.id, to);
                          if (res?.error) setJobNote({ id: t.id, text: res.error });
                          else setJobNote(null);
                        });
                      }}
                      style={{ width: "auto", maxWidth: 200, fontSize: 12 }}>
                      <option value="">on its own</option>
                      {jobs.map((j) => <option key={j.id} value={j.id}>{j.number}</option>)}
                    </select>
                    {jobNote?.id === t.id && (
                      <span style={{ fontSize: 11, color: "#A32D2D" }}>{jobNote.text}</span>
                    )}
                  </>
                )}
                <span className="mut" style={{ fontSize: 12 }}>Assignee:</span>
                <AssigneeSelect task={t} people={people} />
                {systemAssets.length > 0 && (
                  <>
                    <span className="mut" style={{ fontSize: 12 }}>For:</span>
                    <select value={t.assetId ?? ""} onChange={(e) => startTransition(() => setTaskAsset(t.id, e.target.value ? parseInt(e.target.value) : null))}
                      style={{ width: "auto", maxWidth: 180, fontSize: 12 }}>
                      <option value="">Whole system</option>
                      {systemAssets.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                    </select>
                  </>
                )}
                <span className="mut" style={{ fontSize: 12 }}>Due:</span>
                <input type="date" value={t.dueDate} onChange={(e) => startTransition(() => setTaskDue(t.id, e.target.value))}
                  style={{ width: "auto", fontSize: 12, padding: "3px 6px" }} />
                <button className="btn link" onClick={() => { setEditDraft({ title: t.title, body: t.body }); setEditing(t.id); }}>edit</button>
                {(isStaff || t.origin === "checkout") && (
                  <button className="btn link" style={{ marginLeft: "auto", color: "#A32D2D", fontSize: 12, fontWeight: 700 }}
                    onClick={() => {
                      const msg = t.origin === "checkout"
                        ? `Delete checkout item "${t.title}"? Use this for items that don't apply here.`
                        : `Delete task "${t.title}"? Its checklist and notes go with it.`;
                      const reason = promptReason(msg);
                      if (!reason) return;
                      startTransition(async () => { await deleteTask(t.id, reason); setExpanded(null); });
                    }}>Delete</button>
                )}
              </div>
            )}

            <div className="eyebrow" style={{ marginBottom: 6 }}>Checklist</div>
            {t.checklist.map((c) => {
              const tOpen = !!inputs["threadopen-" + c.id];
              const n = c.thread.length;
              return (
                <div key={c.id} style={{ marginBottom: 6 }}>
                  {c.heading ? (
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 8 }}>
                      <span className="eyebrow" style={{ flex: 1 }}>{c.text.replace(/:$/, "")}</span>
                      {isStaff && (
                        <button className="btn link" title="Remove heading" style={{ color: "#A32D2D", padding: "0 4px" }}
                          onClick={() => startTransition(() => deleteChecklistItem(c.id))}>×</button>
                      )}
                    </div>
                  ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <ItemCheckbox item={c} canEdit={canEdit} />
                    <span style={{ fontSize: 13, flex: 1, textDecoration: c.done ? "line-through" : "none", color: c.done ? "var(--mut)" : "var(--ink)" }}>{c.text}</span>
                    <button className="btn link" onClick={() => setInput("threadopen-" + c.id, !tOpen)} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      {n > 0 && <span className="pill info" style={{ padding: "1px 7px" }}>{n}</span>}
                      {tOpen ? "hide" : n > 0 ? "notes" : "+ note"}
                    </button>
                    {isStaff && (
                      <button className="btn link" title="Remove item" style={{ color: "#A32D2D", padding: "0 4px" }}
                        onClick={async () => {
                          if (n > 0 && !(await confirmDialog({
                            title: `Remove "${c.text}"?`,
                            body: `Its ${n} note${n > 1 ? "s go" : " goes"} with it.`,
                            action: "Remove item", tone: "bad",
                          }))) return;
                          startTransition(async () => {
                            await deleteChecklistItem(c.id);
                            toast({ message: "Removed the item" });
                          });
                        }}>×</button>
                    )}
                  </div>
                  )}
                  {!c.heading && tOpen && (
                    <div style={{ marginLeft: 24, marginTop: 6, borderLeft: "2px solid var(--line)", paddingLeft: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                      {c.thread.map((m) => renderNote(m, "item"))}
                      {canEdit && (
                        <div style={{ display: "flex", gap: 6 }}>
                          <MentionBox people={mentionable} value={(inputs["itemnote-" + c.id] as string) || ""}
                            onChange={(v) => setInput("itemnote-" + c.id, v)}
                            onEnter={() => { startTransition(() => addItemNote(c.id, (inputs["itemnote-" + c.id] as string) || "")); setInput("itemnote-" + c.id, ""); }}
                            placeholder={n > 0 ? "Reply on this item..." : 'e.g. "passed at 101% of spec"'} style={{ flex: 1, fontSize: 12, padding: "5px 9px" }} />
                          <button className="btn sm" onClick={() => { startTransition(() => addItemNote(c.id, (inputs["itemnote-" + c.id] as string) || "")); setInput("itemnote-" + c.id, ""); }}>Post</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {canEdit && (
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <input value={(inputs["item-" + t.id] as string) || ""}
                  onChange={(e) => setInput("item-" + t.id, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { startTransition(() => addChecklistItem(t.id, (inputs["item-" + t.id] as string) || "")); setInput("item-" + t.id, ""); } }}
                  placeholder="Add checklist item..." style={{ flex: 1, fontSize: 12, padding: "5px 9px" }} />
                <button className="btn sm" onClick={() => { startTransition(() => addChecklistItem(t.id, (inputs["item-" + t.id] as string) || "")); setInput("item-" + t.id, ""); }}>Add</button>
              </div>
            )}

            <div className="eyebrow" style={{ margin: "14px 0 6px" }}>Notes</div>
            {t.notes.map((m) => renderNote(m, "task"))}
            {t.notes.length === 0 && <div className="mut" style={{ fontSize: 12, marginBottom: 6 }}>No notes yet.</div>}
            {canEdit && (
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <MentionBox people={mentionable} value={(inputs["note-" + t.id] as string) || ""}
                  onChange={(v) => setInput("note-" + t.id, v)}
                  onEnter={() => { startTransition(() => addTaskNote(t.id, (inputs["note-" + t.id] as string) || "")); setInput("note-" + t.id, ""); }}
                  placeholder="Add a note... @name to notify" style={{ flex: 1, fontSize: 12, padding: "5px 9px" }} />
                <button className="btn sm" onClick={() => { startTransition(() => addTaskNote(t.id, (inputs["note-" + t.id] as string) || "")); setInput("note-" + t.id, ""); }}>Post</button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <div className="card-title">Tasks</div>
        {canEdit && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            {copyTargets.length > 0 && tasks.length > 0 && (
              <button className="btn sm" onClick={() => {
                setPicking((v) => !v); setPicked(new Set()); setCopyNote(""); setExpanded(null); setShowNew(false);
              }}>{picking ? "Cancel" : "Copy to..."}</button>
            )}
            <button className="btn sm primary" onClick={() => setShowNew((v) => !v)}>
              {showNew ? "Cancel" : "+ New task"}
            </button>
          </div>
        )}
      </div>

      {picking && (
        <div className="dash-form" style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, fontWeight: 700 }}>
              {picked.size === 0 ? "Tick the tasks to copy" : `${picked.size} selected`}
            </span>
            <button className="btn link" style={{ fontSize: 11 }}
              onClick={() => setPicked(new Set(tasks.filter((t) => t.title.trim()).map((t) => t.id)))}>all</button>
            <button className="btn link" style={{ fontSize: 11 }} onClick={() => setPicked(new Set())}>none</button>
            <select value={copyTo} onChange={(e) => setCopyTo(e.target.value)} aria-label="Copy to"
              style={{ width: "auto", maxWidth: 260, fontSize: 12 }}>
              <option value="">Choose where...</option>
              {copyTargets.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
            <button className="btn sm accent" disabled={pending || !picked.size || !copyTo}
              onClick={() => {
                setCopyNote("");
                const [kind, idStr] = copyTo.split(":");
                const to = kind === "i"
                  ? { instrumentId: parseInt(idStr), assetId: null }
                  : { instrumentId: null, assetId: parseInt(idStr) };
                startTransition(async () => {
                  const res = await copyTasksTo([...picked], to);
                  if (res?.error) { setCopyNote(res.error); return; }
                  const where = copyTargets.find((d) => d.key === copyTo)?.label ?? "there";
                  setCopyNote(`${res.copied} task${res.copied === 1 ? "" : "s"} copied to ${where} ✓`);
                  setPicked(new Set());
                });
              }}>{pending ? "Copying..." : "Copy"}</button>
          </div>
          <div className="mut" style={{ fontSize: 11, marginTop: 6 }}>
            Copies arrive open, with nothing ticked and no maintenance schedule attached.
          </div>
          {copyNote && <div style={{ fontSize: 12, marginTop: 6, fontWeight: 700, color: copyNote.endsWith("✓") ? "#2E6B2E" : "#A32D2D" }}>{copyNote}</div>}
        </div>
      )}

      {showNew && (
        <Dialog open onClose={() => setShowNew(false)} title="New task"
          footer={
            <>
              <span className="dialog-status" />
              <button className="btn" onClick={() => setShowNew(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={submitNew} disabled={pending}>
                {pending ? "Creating..." : "Create task"}
              </button>
            </>
          }>
          {procedureChoices.length > 0 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
              <label style={{ margin: 0 }}>Start from</label>
              <select value={draft.procedureId ?? ""} aria-label="Start from a procedure"
                onChange={(e) => {
                  const id = e.target.value ? parseInt(e.target.value) : null;
                  const c = procedureChoices.find((x) => x.id === id);
                  // Pre-fill, don't lock: the engineer sharpens the ask ("...on
                  // the LEFT pump") and the catalog still brings its checklist.
                  setDraft((d) => ({
                    ...d, procedureId: id,
                    title: c ? c.title : d.title,
                    body: c ? c.body : d.body,
                    resultType: id ? "" : d.resultType,
                  }));
                }}
                style={{ width: "auto", maxWidth: 320, fontSize: 12 }}>
                <option value="">scratch</option>
                {procedureChoices.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
              {draft.procedureId !== null && (
                <span className="mut" style={{ fontSize: 11 }}>
                  {procedureChoices.find((x) => x.id === draft.procedureId)?.brings}
                </span>
              )}
            </div>
          )}
          <label>Title *</label>
          <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. Perform Reserpine tests" style={{ marginBottom: 8 }} />
          <label>Body</label>
          <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={2}
            placeholder="What, for whom, done means what. e.g. Test/compile Reserpine for GMI, submit to Pradeep." style={{ marginBottom: 8, resize: "vertical" }} />
          {/* Wraps. A select sized `auto` is as wide as its longest option, so
              one module called "Mass Spec - ACQUITY SQD" used to push Create
              task clean off the card and underneath the next column, where it
              could not be seen or clicked. The widths are capped for the same
              reason: no single label may decide the layout. */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span className="mut" style={{ fontSize: 12 }}>Assign:</span>
              <select value={draft.assignee} onChange={(e) => setDraft({ ...draft, assignee: e.target.value })}
                style={{ width: "auto", maxWidth: 150 }}>
                {["", ...people].map((p) => <option key={p} value={p}>{p || "-"}</option>)}
              </select>
            </span>
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span className="mut" style={{ fontSize: 12 }}>Due:</span>
              <input type="date" value={draft.dueDate} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
                style={{ width: "auto", fontSize: 12 }} />
            </span>
            {systemAssets.length > 0 && (
              <span style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
                <span className="mut" style={{ fontSize: 12 }}>For:</span>
                <select value={draft.assetId ?? ""} onChange={(e) => setDraft({ ...draft, assetId: e.target.value ? parseInt(e.target.value) : null })}
                  style={{ width: "auto", maxWidth: 180, fontSize: 12 }}>
                  <option value="">Whole system</option>
                  {systemAssets.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </span>
            )}
            {/* What closing this task requires. A checkbox is the default;
                the rest demand a recorded outcome before Done, exactly like a
                procedure's test - "note whether the button toggles" is a
                pass/fail with a note, not a tick. */}
            {draft.procedureId === null && (
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span className="mut" style={{ fontSize: 12 }}>Done means:</span>
              <select value={draft.resultType} aria-label="Done means"
                onChange={(e) => setDraft({ ...draft, resultType: e.target.value })}
                style={{ width: "auto", fontSize: 12 }}>
                <option value="">ticking it off</option>
                <option value="pass_fail">recording pass / fail</option>
                <option value="measured">recording a measurement</option>
                <option value="note">writing down what was found</option>
              </select>
            </span>
            )}
          </div>
        </Dialog>
      )}

      {checkout.length > 0 && (
        <div style={{ marginBottom: active.length ? 12 : 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span className="eyebrow">Checkout</span>
            <span className="pill accent">{checkout.length}</span>
          </div>
          {checkout.map((t) => renderTask(t, false))}
          {active.length > 0 && <div className="eyebrow" style={{ margin: "10px 0 6px" }}>Tasks</div>}
        </div>
      )}
      {jobBands.map(({ job, rows }) => {
        const done = rows.filter((t) => t.state === "Done").length;
        const unfolded = openJobs.includes(job.id);
        return (
          <div key={`job-${job.id}`} style={{ border: "1px solid var(--line)", borderRadius: 8, marginBottom: 8, overflow: "hidden" }}>
            {/* The whole header toggles, with the same ▸/▾ every other fold in
                this panel uses - a word saying "fold" is a control nobody has
                to learn twice. A div rather than a button because the job
                number inside is a link, and a link inside a button is invalid
                markup that swallows its own clicks; the link stops the event
                so tapping the number still opens the job. */}
            <div role="button" tabIndex={0} aria-expanded={unfolded}
              aria-label={`${job.number} ${job.title}, ${done} of ${rows.length} done`}
              className="row-hover"
              onClick={() => toggleJob(job.id)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                toggleJob(job.id);
              }}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#F5F7FA", flexWrap: "wrap", cursor: "pointer" }}>
              <a href={`/work/${job.id}`} className="mono" onClick={(e) => e.stopPropagation()}
                style={{ fontWeight: 700, fontSize: 12, color: "var(--navy)", textDecoration: "none" }}>{job.number}</a>
              <span style={{ fontSize: 13, flex: "1 1 140px" }}>{job.title}</span>
              <span className={`pill ${done === rows.length ? "good" : "neutral"}`}>
                {done} of {rows.length} done
              </span>
              <span className="mut" style={{ fontSize: 12 }}>{unfolded ? "▾" : "▸"}</span>
            </div>
            {unfolded && rows.map((t) => renderTask(t, t.state === "Done", `/work/${job.id}#task-${t.id}`))}
          </div>
        );
      })}
      {active.map((t) => renderTask(t, false))}
      {checkout.length === 0 && active.length === 0 && jobBands.length === 0 && complete.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No tasks yet.</div>}
      {checkout.length === 0 && active.length === 0 && jobBands.length === 0 && complete.length > 0 && <div className="mut" style={{ fontSize: 13, marginBottom: 8 }}>All tasks complete.</div>}

      {complete.length > 0 && (
        <div style={{ marginTop: active.length ? 8 : 0 }}>
          <button onClick={() => setShowDone((v) => !v)}
            style={{ cursor: "pointer", width: "100%", textAlign: "left", background: "#F5F7FA", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px", display: "flex", alignItems: "center", gap: 8 }}>
            <span className="mut" style={{ fontSize: 12 }}>{showDone ? "▾" : "▸"}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--slate)" }}>Completed</span>
            <span className="pill good">{complete.length}</span>
          </button>
          {showDone && <div style={{ marginTop: 8 }}>{complete.map((t) => renderTask(t, true))}</div>}
        </div>
      )}
    </div>
  );
}
