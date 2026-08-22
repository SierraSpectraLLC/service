"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addToThread, deleteMessage, leaveThread, markMessagesRead, sendMessage } from "@/app/actions";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { groupMessages, type Msg } from "@/lib/messages";
import { fmtWhen } from "@/lib/when";

type Member = { email: string; name: string; orgName: string; left: boolean };

/**
 * One conversation.
 *
 * Consecutive messages from the same person run together under a single name
 * (see lib/messages.groupMessages) so a back-and-forth reads as a conversation
 * rather than as a stack of identical labels. Opening the page marks it read;
 * the composer keeps focus so a reply is a keystroke away.
 */
export default function ThreadPanel({ threadId, title, named, me, members, messages, addable }: {
  threadId: number;
  title: string;
  /** True when somebody named the group; false when it is named by its people. */
  named: boolean;
  me: string;
  members: Member[];
  messages: Msg[];
  addable: { name: string; email: string; org: string }[];
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const endRef = useRef<HTMLDivElement>(null);

  // Reading it is what opening it means.
  useEffect(() => { void markMessagesRead(threadId); }, [threadId, messages.length]);
  // A conversation is read from the bottom.
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages.length]);

  const send = () => {
    const text = body;
    if (!text.trim()) return;
    setError("");
    // Optimistic in the one way that matters: the box empties immediately, so
    // a slow round-trip never makes somebody wonder whether it sent.
    setBody("");
    startTransition(async () => {
      const res = await sendMessage(threadId, text);
      if (res?.error) { setError(res.error); setBody(text); return; }
      router.refresh();
    });
  };

  const groups = groupMessages(messages);
  const active = members.filter((m) => !m.left);

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
        <div className="card-title">{title}</div>
        {named && active.length > 1 && (
          <span className="mut" style={{ fontSize: 11 }}>
            {active.map((m) => m.name).join(", ")}
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {addable.length > 0 && (
            <button className="btn sm" onClick={() => { setAdding((v) => !v); setError(""); }}>
              {adding ? "Cancel" : "Add someone"}
            </button>
          )}
          <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
            onClick={async () => {
              if (!(await confirmDialog({
                title: "Leave this conversation?",
                body: "What was said stays for the others.",
                action: "Leave conversation", tone: "bad",
              }))) return;
              startTransition(async () => {
                const res = await leaveThread(threadId);
                if (res?.error) { setError(res.error); return; }
                toast({ message: "Left the conversation" });
                router.push("/messages");
              });
            }}>leave</button>
        </span>
      </div>

      {adding && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "#FAFBFD" }}>
          {addable.slice(0, 30).map((p) => (
            <button key={p.email} className="btn sm" disabled={pending}
              onClick={() => startTransition(async () => {
                const res = await addToThread(threadId, p.email);
                if (res?.error) { setError(res.error); return; }
                setAdding(false); router.refresh();
              })}>
              {p.name} <span className="mut">· {p.org}</span>
            </button>
          ))}
        </div>
      )}

      <div style={{ maxHeight: "58vh", overflowY: "auto", padding: "4px 0" }}>
        {groups.map((g) => {
          const first = g[0];
          const mine = first.authorEmail.toLowerCase() === me;
          return (
            <div key={first.id} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: mine ? "var(--navy)" : "var(--ink)" }}>
                  {mine ? "You" : first.authorName}
                </span>
                <span className="mut" style={{ fontSize: 11 }}>{fmtWhen(first.createdAt)}</span>
              </div>
              {g.map((m) => (
                <div key={m.id} style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                  <div style={{
                    fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere",
                    color: m.deletedAt ? "var(--mut)" : "var(--ink)",
                    fontStyle: m.deletedAt ? "italic" : "normal",
                  }}>
                    {m.deletedAt ? "message taken back" : m.body}
                  </div>
                  {mine && !m.deletedAt && (
                    <button className="btn link" style={{ fontSize: 10, opacity: 0.6 }} disabled={pending}
                      title="Take this message back"
                      onClick={() => startTransition(async () => {
                        const res = await deleteMessage(m.id);
                        if (res?.error) { setError(res.error); return; }
                        router.refresh();
                      })}>×</button>
                  )}
                </div>
              ))}
            </div>
          );
        })}
        {messages.length === 0 && <div className="mut" style={{ fontSize: 12.5 }}>Nothing said yet.</div>}
        <div ref={endRef} />
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 8, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} autoFocus
          placeholder="Write a message... (Enter sends, Shift+Enter for a new line)"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          style={{ flex: 1, resize: "vertical", fontSize: 13 }} />
        <button className="btn sm accent" disabled={pending || !body.trim()} onClick={send}>
          {pending ? "Sending..." : "Send"}
        </button>
      </div>
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
    </div>
  );
}
