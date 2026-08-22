"use client";

import { confirmReason } from "@/components/ui/ConfirmDialog";
import { useState, useTransition } from "react";
import { postDiscussion, deleteDiscussionPost, updateDiscussionPost } from "@/app/actions";
import { fmtWhen } from "@/lib/when";
import ThreadSeen from "./ThreadSeen";
import MentionBox from "./MentionBox";
import type { Candidate } from "@/lib/mentions";

export type Post = {
  id: number; author: string; authorEmail: string; body: string; createdAt: string;
  /** Who the author was speaking for, shown so a multi-party thread stays legible. */
  authorParty: string;
  internal: boolean;
};

const when = (iso: string) => fmtWhen(iso);

/** Bold @mentions so pings stand out. */
const renderBody = (body: string) =>
  body.split(/(@[\w'.-]+)/g).map((part, i) =>
    part.startsWith("@")
      ? <b key={i} style={{ color: "var(--navy)" }}>{part}</b>
      : <span key={i}>{part}</span>
  );

/**
 * One thread. Every post is either shared with everyone who can see the thread
 * or internal to the party that wrote it - and an internal post is invisible to
 * everyone else, the operator included, so the composer says plainly which of
 * the two you are about to write.
 */
export default function DiscussionPanel({
  instrumentId, posts, canEdit, newCount = 0, title, subtitle,
  threadId, roomOrgId = null, partyName, sharedWith, people = [],
}: {
  instrumentId: number | null; posts: Post[]; canEdit: boolean; newCount?: number;
  title?: string; subtitle?: string;
  /** Read-marker id; see lib/discussionScope.roomThreadId. */
  threadId: number;
  /** General board only: which room a new post goes into. */
  roomOrgId?: number | null;
  /** The viewer's own party - who "internal" keeps a post inside. */
  partyName: string;
  /** Who a shared post reaches, for the composer's hint. */
  sharedWith: string;
  /** Who can be @mentioned from this board. */
  people?: Candidate[];
}) {
  const [draft, setDraft] = useState("");
  const [internal, setInternal] = useState(false);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [pending, startTransition] = useTransition();

  const saveEdit = (id: number) => {
    const text = (edits[id] ?? "").trim();
    if (text) startTransition(() => updateDiscussionPost(id, text));
    setEdits((e) => { const n = { ...e }; delete n[id]; return n; });
  };

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    startTransition(async () => {
      await postDiscussion(instrumentId, text, { audience: internal ? "internal" : "all", roomOrgId });
      setDraft("");
    });
  };

  return (
    <div className="card">
      <ThreadSeen threadId={threadId} hasNew={newCount > 0} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: subtitle ? 4 : 10 }}>
        <div className="card-title">{title ?? "Discussion"}</div>
        {newCount > 0 && (
          <span className="pill info">{newCount} new</span>
        )}
      </div>
      {subtitle && <div className="mut t-small" style={{ marginBottom: 12 }}>{subtitle}</div>}

      {posts.length === 0 && <div className="mut t-body" style={{ marginBottom: 8 }}>No posts yet.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 12 }}>
        {posts.map((p) => {
          const editing = typeof edits[p.id] === "string";
          return (
            <div key={p.id} style={p.internal ? {
              borderLeft: "3px solid #EAD9B0", background: "#FDF8EE", borderRadius: 6, padding: "4px 8px", margin: "0 -8px",
            } : undefined}>
              <div className="t-small">
                <b style={{ color: "var(--navy)" }}>{p.author}</b>
                {p.authorParty && <span className="mut t-meta"> · {p.authorParty}</span>}{" "}
                <span className="mut t-meta">{when(p.createdAt)}</span>
                {p.internal && (
                  <>{" "}<span className="pill warn">internal</span></>
                )}
                {canEdit && !editing && (
                  <>
                    {" "}<button className="btn link"
                      onClick={() => setEdits((e) => ({ ...e, [p.id]: p.body }))}>edit</button>
                    <button className="btn link" style={{ color: "var(--t-bad-fg)", padding: "0 4px" }} disabled={pending}
                      onClick={async () => {
                        const reason = await confirmReason({
                          title: "Delete this post?",
                          body: "It stays in the audit history.",
                          action: "Delete", tone: "bad",
                        });
                        if (!reason) return;
                        startTransition(async () => { await deleteDiscussionPost(p.id, reason); });
                      }}>×</button>
                  </>
                )}
              </div>
              {editing ? (
                <div style={{ display: "flex", gap: 6, marginTop: 3 }}>
                  <textarea value={edits[p.id]} rows={2} autoFocus
                    onChange={(e) => setEdits((s) => ({ ...s, [p.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveEdit(p.id);
                      if (e.key === "Escape") setEdits((s) => { const n = { ...s }; delete n[p.id]; return n; });
                    }}
                    className="t-body" style={{ flex: 1, resize: "vertical" }} />
                  <button className="btn sm" onClick={() => saveEdit(p.id)}>Save</button>
                </div>
              ) : (
                <div className="t-body" style={{ whiteSpace: "pre-wrap" }}>{renderBody(p.body)}</div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
        {/* Cmd/Ctrl+Enter posts; plain Enter is a newline here, so MentionBox
            gets no onEnter and only steals the key while its list is open. */}
        <MentionBox multiline people={people} value={draft} onChange={setDraft} rows={2}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
          placeholder="Write an update or question... @name to notify someone"
          className="t-body" style={{ flex: 1, resize: "vertical" }} />
        <button className="btn sm accent" onClick={submit} disabled={pending || !draft.trim()}>
          {pending ? "Posting..." : "Post"}
        </button>
      </div>
      <label className="t-small" style={{ display: "flex", alignItems: "flex-start", gap: 6, margin: "8px 0 0", fontWeight: 400, color: "var(--ink)" }}>
        <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)}
          style={{ width: "auto", marginTop: 2 }} />
        <span>
          Internal to {partyName}
          <span className="mut t-meta" style={{ display: "block" }}>
            {internal
              ? `Only ${partyName} can read this - nobody else on the thread, and no email leaves ${partyName}.`
              : `Off, this goes to ${sharedWith}.`}
          </span>
        </span>
      </label>
    </div>
  );
}
