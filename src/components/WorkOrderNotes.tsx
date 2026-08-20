"use client";

import { useState, useTransition } from "react";
import { addWorkOrderNote } from "@/app/actions";
import { fmtWhen } from "@/lib/when";

export type WoNote = { id: number; author: string; text: string; createdAt: string };

/**
 * The conversation on the job - above any one task. "Client says it ran fine
 * over the weekend", "bring the long torx": context whoever drives out needs
 * to have read, which fits neither a task's checklist nor the close-out.
 *
 * Comments are append-only here on purpose: this thread is part of what the
 * job's record says happened, and the audit line each post writes would
 * disagree with an edited bubble.
 */
export default function WorkOrderNotes({ workOrderId, notes, canPost }: {
  workOrderId: number; notes: WoNote[]; canPost: boolean;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
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
      {notes.map((n) => (
        <div key={n.id} style={{ padding: "7px 0", borderTop: "1px solid var(--line)" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span style={{ fontSize: 12.5, fontWeight: 700 }}>{n.author}</span>
            <span className="mut" style={{ fontSize: 11 }}>{fmtWhen(n.createdAt)}</span>
          </div>
          <div style={{ fontSize: 13, whiteSpace: "pre-wrap", marginTop: 2 }}>{n.text}</div>
        </div>
      ))}
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
