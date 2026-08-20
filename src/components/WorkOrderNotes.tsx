"use client";

import { useState, useTransition } from "react";
import { addWorkOrderNote, deleteWorkOrderNote, updateWorkOrderNote } from "@/app/actions";
import { canDeleteNote, canEditNote } from "@/lib/notes";
import { fmtWhen } from "@/lib/when";

export type WoNote = {
  id: number; author: string; authorEmail: string; text: string;
  createdAt: string; editedAt: string | null;
};

/**
 * The conversation on the job - above any one task. "Client says it ran fine
 * over the weekend", "bring the long torx": context whoever drives out needs
 * to have read, which fits neither a task's checklist nor the close-out.
 *
 * Who may change what somebody already posted is lib/notes, not this file:
 * your own words are yours to fix or withdraw, the house may withdraw
 * anything, and nobody rewrites anybody else's sentence. An edited comment
 * says so - a client reads this thread, and a changed line shown as the
 * original would be the one dishonest thing a service record could do.
 */
export default function WorkOrderNotes({ workOrderId, notes, canPost, me }: {
  workOrderId: number; notes: WoNote[]; canPost: boolean;
  /** The signed-in reader, for deciding which comments they may touch. */
  me: { email: string; name: string; isHouse: boolean };
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  // Which comment is open for editing, and the draft in its box.
  const [editing, setEditing] = useState<null | { id: number; draft: string }>(null);
  const [pending, startTransition] = useTransition();

  const post = () => {
    if (!text.trim()) return;
    setError("");
    startTransition(async () => {
      const res = await addWorkOrderNote(workOrderId, text);
      if (res?.error) { setError(res.error); return; }
      setText("");
    });
  };

  if (!canPost && notes.length === 0) return null;

  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 6 }}>Comments</div>
      {notes.map((n) => {
        const mine = canEditNote(n, me);
        const removable = canDeleteNote(n, me);
        const open = editing?.id === n.id;
        const save = () => {
          const v = (editing?.draft ?? "").trim();
          if (!v) return;
          setError("");
          startTransition(async () => {
            const res = await updateWorkOrderNote(n.id, v);
            if (res?.error) { setError(res.error); return; }
            setEditing(null);
          });
        };
        return (
          <div key={n.id} style={{ padding: "7px 0", borderTop: "1px solid var(--line)" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12.5, fontWeight: 700 }}>{n.author}</span>
              <span className="mut" style={{ fontSize: 11 }}>{fmtWhen(n.createdAt)}</span>
              {n.editedAt && (
                <span className="mut" style={{ fontSize: 11 }} title={`Edited ${fmtWhen(n.editedAt)}`}>· edited</span>
              )}
              {!open && (mine || removable) && (
                <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  {mine && (
                    <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
                      onClick={() => { setError(""); setEditing({ id: n.id, draft: n.text }); }}>edit</button>
                  )}
                  {removable && (
                    <button className="btn link" style={{ fontSize: 11, color: "#A32D2D" }} disabled={pending}
                      onClick={() => {
                        if (!window.confirm(mine ? "Delete your comment?" : `Delete ${n.author}'s comment?`)) return;
                        setError("");
                        startTransition(async () => {
                          const res = await deleteWorkOrderNote(n.id);
                          if (res?.error) setError(res.error);
                        });
                      }}>delete</button>
                  )}
                </span>
              )}
            </div>
            {open ? (
              <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                <textarea value={editing.draft} rows={2} autoFocus
                  onChange={(e) => setEditing({ id: n.id, draft: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setEditing(null);
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
                  }}
                  style={{ flex: "1 1 240px", fontSize: 13, resize: "vertical" }} />
                <span style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                  <button className="btn sm accent" onClick={save} disabled={pending || !editing.draft.trim()}>Save</button>
                  <button className="btn sm" onClick={() => setEditing(null)} disabled={pending}>Cancel</button>
                </span>
              </div>
            ) : (
              <div style={{ fontSize: 13, whiteSpace: "pre-wrap", marginTop: 2 }}>{n.text}</div>
            )}
          </div>
        );
      })}
      {notes.length === 0 && <div className="mut" style={{ fontSize: 12.5, marginBottom: 6 }}>Nothing yet. @mention somebody to make sure they see it.</div>}
      {canPost && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment... @name to notify"
            onKeyDown={(e) => { if (e.key === "Enter") post(); }} style={{ flex: 1, fontSize: 13 }} />
          <button className="btn sm primary" onClick={post} disabled={pending || !text.trim()}>
            {pending ? "Posting..." : "Post"}
          </button>
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
    </div>
  );
}
