"use client";

import { useOptimistic, useState, useTransition } from "react";
import { TASK_STATES, TASK_COLOR } from "@/lib/stages";
import {
  createTask, updateTask, deleteTask, setTaskState, assignTask, addChecklistItem,
  toggleChecklistItem, deleteChecklistItem, addItemNote, addTaskNote,
  updateItemNote, deleteItemNote, updateTaskNote, deleteTaskNote, applyTemplate,
} from "@/app/actions";

type Note = { id: number; author: string; text: string; createdAt: string };
type Item = { id: number; text: string; done: boolean; thread: Note[] };
type Task = {
  id: number; title: string; body: string; state: string; assignee: string;
  checklist: Item[]; notes: Note[]; createdAt: string; completedAt: string | null;
};

const PEOPLE = ["", "Joe", "Bill"];
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

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
  return (
    <select value={state} onChange={(e) => startTransition(async () => { setOptimistic(e.target.value); await setTaskState(task.id, e.target.value); })}
      style={{ width: "auto", fontWeight: 700, fontSize: 12 }}>
      {TASK_STATES.map((s) => <option key={s}>{s}</option>)}
    </select>
  );
}

function AssigneeSelect({ task }: { task: Task }) {
  const [, startTransition] = useTransition();
  const [assignee, setOptimistic] = useOptimistic(task.assignee, (_cur: string, next: string) => next);
  return (
    <select value={assignee} onChange={(e) => startTransition(async () => { setOptimistic(e.target.value); await assignTask(task.id, e.target.value); })}
      style={{ width: "auto", fontWeight: 700, fontSize: 12 }}>
      {PEOPLE.map((p) => <option key={p} value={p}>{p || "-"}</option>)}
    </select>
  );
}

export default function TasksPanel({ instrumentId, tasks, templates, canEdit, isStaff }: {
  instrumentId: number; tasks: Task[]; templates: { id: number; name: string }[]; canEdit: boolean; isStaff: boolean;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [draft, setDraft] = useState({ title: "", body: "", assignee: "" });
  const [editing, setEditing] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState({ title: "", body: "" });
  const [inputs, setInputs] = useState<Record<string, string | boolean>>({});
  const [pending, startTransition] = useTransition();
  const setInput = (k: string, v: string | boolean) => setInputs((s) => ({ ...s, [k]: v }));

  const active = tasks.filter((t) => t.state !== "Done");
  const complete = tasks.filter((t) => t.state === "Done");

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
          {isStaff && !isEditing && (
            <>
              {" "}<button className="btn link" style={{ fontSize: 11 }} onClick={() => setInput(key, m.text)}>edit</button>
              <button className="btn link" style={{ fontSize: 11, color: "#A32D2D", padding: "0 4px" }}
                onClick={() => {
                  if (!window.confirm("Delete this note?")) return;
                  startTransition(() => (kind === "item" ? deleteItemNote(m.id) : deleteTaskNote(m.id)));
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
      await createTask(instrumentId, draft);
      setDraft({ title: "", body: "", assignee: "" });
      setShowNew(false);
    });
  };

  const renderTask = (t: Task, isDone: boolean) => {
    const open = expanded === t.id;
    const done = t.checklist.filter((c) => c.done).length;
    return (
      <div key={t.id} style={{ border: "1px solid var(--line)", borderRadius: 10, marginBottom: 8, overflow: "hidden", opacity: isDone && !open ? 0.7 : 1 }}>
        <div className="row-hover" onClick={() => setExpanded(open ? null : t.id)}
          style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", flexWrap: "wrap" }}>
          <span className="pill" style={{ background: TASK_COLOR[t.state]?.bg, color: TASK_COLOR[t.state]?.fg }}>{t.state}</span>
          <span style={{ fontSize: 13, fontWeight: 700, flex: "1 1 160px", minWidth: 0, textDecoration: isDone ? "line-through" : "none", color: isDone ? "var(--mut)" : "var(--ink)" }}>{t.title}</span>
          {t.checklist.length > 0 && <span className="mut" style={{ fontSize: 11 }}>{done}/{t.checklist.length}</span>}
          <span style={{ fontSize: 12, fontWeight: 700, color: t.assignee ? "var(--navy)" : "var(--mut)" }}>{t.assignee || "-"}</span>
          <span className="mut" style={{ fontSize: 12 }}>{open ? "▾" : "▸"}</span>
        </div>

        {open && (
          <div style={{ borderTop: "1px solid var(--line)", padding: 12, background: "#FAFBFD" }}>
            {editing === t.id ? (
              <div className="dash-form" style={{ marginBottom: 12 }}>
                <label>Title *</label>
                <input value={editDraft.title} onChange={(e) => setEditDraft({ ...editDraft, title: e.target.value })} style={{ marginBottom: 8 }} />
                <label>Body</label>
                <textarea value={editDraft.body} onChange={(e) => setEditDraft({ ...editDraft, body: e.target.value })} rows={2} style={{ marginBottom: 8, resize: "vertical" }} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn sm accent" disabled={pending || !editDraft.title.trim()}
                    onClick={() => startTransition(async () => { await updateTask(t.id, editDraft); setEditing(null); })}>
                    {pending ? "Saving..." : "Save"}
                  </button>
                  <button className="btn sm" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              t.body && <div style={{ fontSize: 13, marginBottom: 10 }}>{t.body}</div>
            )}
            {canEdit && editing !== t.id && (
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                <span className="mut" style={{ fontSize: 12 }}>Status:</span>
                <TaskStateSelect task={t} />
                <span className="mut" style={{ fontSize: 12 }}>Assignee:</span>
                <AssigneeSelect task={t} />
                <button className="btn link" onClick={() => { setEditDraft({ title: t.title, body: t.body }); setEditing(t.id); }}>edit</button>
                {isStaff && (
                  <button className="btn link" style={{ marginLeft: "auto", color: "#A32D2D", fontSize: 12, fontWeight: 700 }}
                    onClick={() => {
                      if (!window.confirm(`Delete task "${t.title}"? Its checklist and notes go with it.`)) return;
                      startTransition(async () => { await deleteTask(t.id); setExpanded(null); });
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
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <ItemCheckbox item={c} canEdit={canEdit} />
                    <span style={{ fontSize: 13, flex: 1, textDecoration: c.done ? "line-through" : "none", color: c.done ? "var(--mut)" : "var(--ink)" }}>{c.text}</span>
                    <button className="btn link" onClick={() => setInput("threadopen-" + c.id, !tOpen)} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      {n > 0 && <span className="pill" style={{ background: "#E7F2FA", color: "#1D6396", padding: "1px 7px" }}>{n}</span>}
                      {tOpen ? "hide" : n > 0 ? "notes" : "+ note"}
                    </button>
                    {isStaff && (
                      <button className="btn link" title="Remove item" style={{ color: "#A32D2D", padding: "0 4px" }}
                        onClick={() => {
                          if (n > 0 && !window.confirm(`Remove "${c.text}" and its ${n} note${n > 1 ? "s" : ""}?`)) return;
                          startTransition(() => deleteChecklistItem(c.id));
                        }}>×</button>
                    )}
                  </div>
                  {tOpen && (
                    <div style={{ marginLeft: 24, marginTop: 6, borderLeft: "2px solid var(--line)", paddingLeft: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                      {c.thread.map((m) => renderNote(m, "item"))}
                      {canEdit && (
                        <div style={{ display: "flex", gap: 6 }}>
                          <input value={(inputs["itemnote-" + c.id] as string) || ""}
                            onChange={(e) => setInput("itemnote-" + c.id, e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") { startTransition(() => addItemNote(c.id, (inputs["itemnote-" + c.id] as string) || "")); setInput("itemnote-" + c.id, ""); } }}
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
                <input value={(inputs["note-" + t.id] as string) || ""}
                  onChange={(e) => setInput("note-" + t.id, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { startTransition(() => addTaskNote(t.id, (inputs["note-" + t.id] as string) || "")); setInput("note-" + t.id, ""); } }}
                  placeholder="Add a note..." style={{ flex: 1, fontSize: 12, padding: "5px 9px" }} />
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
            {templates.length > 0 && (
              <select value="" disabled={pending}
                onChange={(e) => { const id = parseInt(e.target.value); if (id) startTransition(() => applyTemplate(instrumentId, id)); }}
                style={{ width: "auto", fontSize: 12 }}>
                <option value="">Apply template...</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
            <button className="btn sm primary" onClick={() => setShowNew((v) => !v)}>
              {showNew ? "Cancel" : "+ New task"}
            </button>
          </div>
        )}
      </div>

      {showNew && (
        <div className="dash-form">
          <label>Title *</label>
          <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. Perform Reserpine tests" style={{ marginBottom: 8 }} />
          <label>Body</label>
          <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={2}
            placeholder="What, for whom, done means what. e.g. Test/compile Reserpine for GMI, submit to Pradeep." style={{ marginBottom: 8, resize: "vertical" }} />
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="mut" style={{ fontSize: 12 }}>Assign:</span>
            <select value={draft.assignee} onChange={(e) => setDraft({ ...draft, assignee: e.target.value })} style={{ width: "auto" }}>
              {PEOPLE.map((p) => <option key={p} value={p}>{p || "-"}</option>)}
            </select>
            <button className="btn sm accent" style={{ marginLeft: "auto" }} onClick={submitNew} disabled={pending}>
              {pending ? "Creating..." : "Create task"}
            </button>
          </div>
        </div>
      )}

      {active.map((t) => renderTask(t, false))}
      {active.length === 0 && complete.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No tasks yet.</div>}
      {active.length === 0 && complete.length > 0 && <div className="mut" style={{ fontSize: 13, marginBottom: 8 }}>All tasks complete.</div>}

      {complete.length > 0 && (
        <div style={{ marginTop: active.length ? 8 : 0 }}>
          <button onClick={() => setShowDone((v) => !v)}
            style={{ cursor: "pointer", width: "100%", textAlign: "left", background: "#F5F7FA", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px", display: "flex", alignItems: "center", gap: 8 }}>
            <span className="mut" style={{ fontSize: 12 }}>{showDone ? "▾" : "▸"}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--slate)" }}>Completed</span>
            <span className="pill" style={{ background: "#E5F3E5", color: "#2E6B2E" }}>{complete.length}</span>
          </button>
          {showDone && <div style={{ marginTop: 8 }}>{complete.map((t) => renderTask(t, true))}</div>}
        </div>
      )}
    </div>
  );
}
