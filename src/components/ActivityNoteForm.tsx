"use client";

import { useState, useTransition } from "react";
import { addInstrumentNote } from "@/app/actions";

export default function ActivityNoteForm({ instrumentId }: { instrumentId: number }) {
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();

  const post = () => {
    const t = text.trim();
    if (!t) return;
    startTransition(async () => {
      await addInstrumentNote(instrumentId, t);
      setText("");
    });
  };

  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
      <input value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") post(); }}
        placeholder='Log a note... e.g. "No Helium - ordered a refill"' style={{ flex: 1, fontSize: 12, padding: "5px 9px" }} />
      <button className="btn sm" onClick={post} disabled={pending}>{pending ? "Posting..." : "Post"}</button>
    </div>
  );
}
