"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createRestorationProject } from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { RESTORATION_SOURCES, RESTORATION_SOURCE_LABEL } from "@/lib/restoration";

export type RestorableSystem = { id: number; externalId: string; label: string };

/**
 * Open a restoration from the queue page. The system must already exist as an
 * instruments row - a restoration is a project ON a system, not a way of
 * creating one - so the dialog offers the workspace's systems not already in
 * the pipeline, and points at the asset registry for a box that has no record
 * yet.
 */
export default function NewRestorationButton({ systems }: { systems: RestorableSystem[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [systemId, setSystemId] = useState(0);
  const [source, setSource] = useState<string>("acquired");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const problem = !systemId ? "pick the system being restored" : null;

  const file = () => {
    if (problem) return;
    setError("");
    startTransition(async () => {
      const res = await createRestorationProject(systemId, source);
      if (res?.error || !res?.id) { setError(res?.error ?? "That didn't save"); return; }
      const chosen = systems.find((s) => s.id === systemId);
      toast({ message: `Opened receiving on ${chosen?.externalId ?? "the system"}` });
      setOpen(false);
      router.push(`/restorations/${res.id}`);
    });
  };

  return (
    <>
      <button className="btn sm primary" onClick={() => { setSystemId(0); setSource("acquired"); setError(""); setOpen(true); }}>
        ＋ New restoration
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Start a restoration"
        context="Receiving opens first: serials, condition, findings, provenance."
        footer={
          <>
            <DialogStatus error={error} problem={problem} ok="Lands on Receive." />
            <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
            <button className="btn accent" onClick={file} disabled={pending || !!problem}>
              {pending ? "Opening..." : "Start receiving"}
            </button>
          </>
        }>
        <label>System</label>
        <select value={systemId || ""} aria-label="System" autoFocus
          onChange={(e) => setSystemId(parseInt(e.target.value) || 0)}>
          <option value="">Pick the system being restored</option>
          {systems.map((s) => (
            <option key={s.id} value={s.id}>{s.externalId}{s.label ? ` - ${s.label}` : ""}</option>
          ))}
        </select>
        <div className="mut t-meta" style={{ marginTop: 4, marginBottom: 8 }}>
          Not on the list? Register it under Assets first - a restoration is a
          project on a system, and one system runs one restoration at a time.
        </div>
        <label>Where it came from</label>
        <div className="seg">
          {RESTORATION_SOURCES.map((s) => (
            <button key={s} type="button" aria-pressed={source === s} onClick={() => setSource(s)}>
              {RESTORATION_SOURCE_LABEL[s]}
            </button>
          ))}
        </div>
      </Dialog>
    </>
  );
}
