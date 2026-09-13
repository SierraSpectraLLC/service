"use client";

import { useState, useTransition } from "react";
import { setMyHomeBase } from "@/app/actions";
import { toast } from "@/components/ui/Toast";
import { Field, Panel } from "@/components/ui";
import AddressField from "@/components/AddressField";

/**
 * The engineer's own home. It lives on THEIR settings page because it is
 * their address; the office can fill it from the intake paperwork too. What
 * the rest of the app ever sees is miles - the trip strip on a work order
 * says "112 mi from your home base", never where the base is. An engineer
 * stationed at a client's lab has that on their file as a site location,
 * separately: the lab is not their home, and this field is not where it goes.
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
      hint="Where you live, and where your trips start unless your file names a site location. Work orders use it to figure road miles to a site - only the miles ever show, never the address.">
      <Field label="Address">
        <AddressField value={draft} ariaLabel="Home base address"
          placeholder="1200 Idlewild Dr, Reno NV 89509"
          onChange={setDraft} />
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
