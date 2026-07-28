"use client";

import { useState, useTransition } from "react";
import { postDiscussion, deleteDiscussionPost } from "@/app/actions";

export type Post = { id: number; author: string; authorEmail: string; body: string; createdAt: string };

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Bold @mentions so pings stand out. */
const renderBody = (body: string) =>
  body.split(/(@[\w'.-]+)/g).map((part, i) =>
    part.startsWith("@")
      ? <b key={i} style={{ color: "var(--navy)" }}>{part}</b>
      : <span key={i}>{part}</span>
  );

export default function DiscussionPanel({ instrumentId, posts, isStaff, title, subtitle }: {
  instrumentId: number | null; posts: Post[]; isStaff: boolean; title?: string; subtitle?: string;
}) {
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    startTransition(async () => {
      await postDiscussion(instrumentId, text);
      setDraft("");
    });
  };

  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: subtitle ? 4 : 10 }}>{title ?? "Discussion"}</div>
      {subtitle && <div className="mut" style={{ fontSize: 12, marginBottom: 12 }}>{subtitle}</div>}

      {posts.length === 0 && <div className="mut" style={{ fontSize: 13, marginBottom: 8 }}>No posts yet.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 12 }}>
        {posts.map((p) => (
          <div key={p.id}>
            <div style={{ fontSize: 12 }}>
              <b style={{ color: "var(--navy)" }}>{p.author}</b>{" "}
              <span className="mut" style={{ fontSize: 11 }}>{when(p.createdAt)}</span>
              {isStaff && (
                <button className="btn link" style={{ fontSize: 11, color: "#A32D2D", padding: "0 4px" }} disabled={pending}
                  onClick={() => {
                    if (!window.confirm("Delete this post? It stays in the audit history.")) return;
                    startTransition(() => deleteDiscussionPost(p.id));
                  }}>×</button>
              )}
            </div>
            <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{renderBody(p.body)}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
          placeholder="Write an update or question... @name to notify someone"
          style={{ flex: 1, fontSize: 13, resize: "vertical" }} />
        <button className="btn sm accent" onClick={submit} disabled={pending || !draft.trim()}>
          {pending ? "Posting..." : "Post"}
        </button>
      </div>
    </div>
  );
}
