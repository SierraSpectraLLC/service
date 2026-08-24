"use client";

import { useState, useTransition } from "react";
import { setMyHomeBase } from "@/app/actions";
import { toast } from "@/components/ui/Toast";
import { Field, Panel } from "@/components/ui";

/**
 * The engineer's own point zero. It is their home address, so it lives on
 * THEIR settings page and nobody types it for them. What the rest of the app
 * ever sees is miles - the trip strip on a work order says "112 mi from your
 * home base", never where the base is.
 */
export default function HomeBaseCard({ address, placed }: {
  address: string;
  /** Whether the saved address geocoded - routed miles need a point, not a string. */
  placed: boolean;
}) {
  const [draft, setDraft] = useState(address);
  const [msg, setMsg] = useState("");
  const [pending, startTransition] = useTransition();

  const save = () => {
    setMsg("");
    startTransition(async () => {
      const res = await setMyHomeBase(draft);
      if (res?.error) { setMsg(res.error); return; }
      toast({ message: draft.trim() ? "Home base saved" : "Home base cleared" });
      if (res?.label) setMsg(`Placed as: ${res.label}`);
    });
  };

  return (
    <Panel title="Home base"
      hint="Where your trips start. Work orders use it to figure road miles to a site - only the miles ever show, never the address.">
      <Field label="Address">
        <input className="t-body" value={draft} placeholder="1200 Idlewild Dr, Reno NV 89509"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
      </Field>
      <div className="row-2" style={{ alignItems: "center", marginTop: 8 }}>
        <button className="btn sm accent" onClick={save} disabled={pending || draft === address}>
          {pending ? "Placing..." : draft.trim() ? "Save" : "Clear"}
        </button>
        {!msg && address && (
          <span className="mut t-small">{placed ? "On the map ✓" : "Saved, but not placeable - routed miles are off"}</span>
        )}
        {msg && <span className="t-small" style={{ color: msg.startsWith("Placed") ? "var(--t-good-fg)" : "var(--t-bad-fg)" }}>{msg}</span>}
      </div>
    </Panel>
  );
}
