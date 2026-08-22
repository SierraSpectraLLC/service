"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startThread } from "@/app/actions";
import Dialog from "@/components/ui/Dialog";

/**
 * Start a conversation.
 *
 * The picker is the directory - your own organization and the ones you work
 * with - so there is no way to address somebody you could not already see, and
 * no need to know anybody's email address.
 */
export default function NewMessageButton({ people }: {
  people: { name: string; email: string; org: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const toggle = (email: string) =>
    setPicked((p) => (p.includes(email) ? p.filter((x) => x !== email) : [...p, email]));

  const shown = people.filter((p) =>
    `${p.name} ${p.org}`.toLowerCase().includes(filter.trim().toLowerCase()));

  const send = () => {
    setError("");
    startTransition(async () => {
      const res = await startThread(picked, { title, body });
      if (res?.error) { setError(res.error); return; }
      setOpen(false); setPicked([]); setTitle(""); setBody(""); setFilter("");
      if (res.id) router.push(`/messages/${res.id}`);
    });
  };

  if (people.length === 0) {
    return <span className="mut" style={{ fontSize: 11 }}>Nobody to message yet</span>;
  }

  return (
    <>
      <button className="btn sm primary" onClick={() => { setOpen(!open); setError(""); }}>
        {open ? "Cancel" : "New message"}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="New message"
        footer={
          <>
            <span className={`dialog-status${error ? " err" : ""}`}>{error}</span>
            <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn accent" disabled={pending || !picked.length || !body.trim()} onClick={send}>
              {pending ? "Sending..." : "Send message"}
            </button>
          </>
        }>
            <label>To *</label>
            <input value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder="Type to filter people..." style={{ marginBottom: 6 }} />
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", maxHeight: 180, overflowY: "auto", marginBottom: 8 }}>
              {shown.map((p) => (
                <button key={p.email} type="button" className={picked.includes(p.email) ? "btn sm primary" : "btn sm"}
                  onClick={() => toggle(p.email)} style={{ fontSize: 11 }}>
                  {p.name} <span className="mut">· {p.org}</span>
                </button>
              ))}
              {shown.length === 0 && <span className="mut" style={{ fontSize: 11 }}>Nobody matches.</span>}
            </div>

            {/* Only worth naming once it's a group; two people are named by
                each other. */}
            {picked.length > 1 && (
              <>
                <label>Name this group</label>
                <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80}
                  placeholder="Optional - e.g. &quot;Reno trip&quot;" style={{ marginBottom: 8 }} />
              </>
            )}

            <label>Message *</label>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4}
              placeholder="What do you want to say?" style={{ width: "100%", marginBottom: 8, resize: "vertical" }} />

      </Dialog>
    </>
  );
}
