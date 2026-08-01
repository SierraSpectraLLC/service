"use client";

import { useState, useTransition } from "react";
import { pushInstrumentToSheet } from "@/app/actions";

/** Staff-only: add this system to the client's Google Sheet as a new row. */
export default function PushToSheetButton({ instrumentId, externalId }: { instrumentId: number; externalId: string }) {
  const [msg, setMsg] = useState("");
  const [pending, startTransition] = useTransition();

  const push = () => {
    if (!window.confirm(`Add ${externalId} to the client's Google Sheet as a new row?`)) return;
    setMsg("");
    startTransition(async () => {
      const res = await pushInstrumentToSheet(instrumentId);
      setMsg(res?.error ?? "Added to the sheet ✓");
    });
  };

  return (
    <>
      <button className="btn sm" onClick={push} disabled={pending} style={{ flexShrink: 0 }}>
        {pending ? "Adding..." : "Add to sheet"}
      </button>
      {msg && (
        <span style={{ fontSize: 11, color: msg.endsWith("✓") ? "#2E6B2E" : "#A32D2D" }}>{msg}</span>
      )}
    </>
  );
}
