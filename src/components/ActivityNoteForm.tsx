"use client";

import { useState, useTransition } from "react";
import { addInstrumentNote, type WorkTarget } from "@/app/actions";
import { toast } from "@/components/ui/Toast";

export default function ActivityNoteForm({ target }: { target: WorkTarget }) {
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();

  const post = () => {
    const t = text.trim();
    if (!t) return;
    startTransition(async () => {
      await addInstrumentNote(target, t);
      setText("");
      toast({ message: "Logged the note" });
    });
  };

  return (
    <div className="row-2" style={{ marginBottom: 12 }}>
      <input className="t-small" value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") post(); }}
        placeholder='Log a note... e.g. "No Helium - ordered a refill"' style={{ flex: 1, padding: "5px 9px" }} />
      <button className="btn sm" onClick={post} disabled={pending}>{pending ? "Posting..." : "Post"}</button>
    </div>
  );
}
