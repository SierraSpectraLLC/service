"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createRestorationProject } from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { RESTORATION_SOURCES, RESTORATION_SOURCE_LABEL } from "@/lib/restoration";

export type RestorableSystem = { id: number; externalId: string; label: string };

/**
 * Start a restoration - which is, in the normal case, how a system COMES TO
 * EXIST: the truck arrives, the receiver stages it under a tag (ACQ-001 by
 * suggestion, theirs to overtype), and Receive builds the record serial by
 * serial. Pointing at a system already on the books stays one tap away for
 * the trade-in or bench unit that has a record before it has a project.
 */
export default function NewRestorationButton({ systems, suggestions }: {
  systems: RestorableSystem[];
  /** source -> the next free staging tag for its prefix. */
  suggestions: Record<string, string>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [source, setSource] = useState<string>("acquired");
  const [stagedId, setStagedId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [name, setName] = useState("");
  const [systemId, setSystemId] = useState(0);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const reset = () => {
    setMode("new"); setSource("acquired");
    setStagedId(suggestions.acquired ?? ""); setIdEdited(false);
    setName(""); setSystemId(0); setError("");
  };

  // Changing the source re-suggests the tag - unless the receiver already
  // typed their own, which nothing may overwrite.
  const pickSource = (s: string) => {
    setSource(s);
    if (!idEdited) setStagedId(suggestions[s] ?? "");
  };

  const problem = mode === "new"
    ? (!stagedId.trim() ? "give the system its staging ID" : null)
    : (!systemId ? "pick the system on the books" : null);

  const file = () => {
    if (problem) return;
    setError("");
    startTransition(async () => {
      const res = await createRestorationProject(source,
        mode === "new" ? { externalId: stagedId, name } : { instrumentId: systemId });
      if (res?.error || !res?.id) { setError(res?.error ?? "That didn't save"); return; }
      const tag = mode === "new" ? stagedId.trim()
        : systems.find((s) => s.id === systemId)?.externalId ?? "the system";
      toast({ message: `Opened receiving on ${tag}` });
      setOpen(false);
      router.push(`/restorations/${res.id}`);
    });
  };

  return (
    <>
      <button className="btn sm primary" onClick={() => { reset(); setOpen(true); }}>
        ＋ New restoration
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Start a restoration"
        context="Receiving opens first: serials, condition, findings, provenance."
        footer={
          <>
            <DialogStatus error={error} problem={problem}
              ok={mode === "new" ? `Stages a new system as ${stagedId.trim() || "…"} and lands on Receive.` : "Lands on Receive."} />
            <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
            <button className="btn accent" onClick={file} disabled={pending || !!problem}>
              {pending ? "Opening..." : "Start receiving"}
            </button>
          </>
        }>
        <label>Where it came from</label>
        <div className="seg" style={{ marginBottom: 8 }}>
          {RESTORATION_SOURCES.map((s) => (
            <button key={s} type="button" aria-pressed={source === s} onClick={() => pickSource(s)}>
              {RESTORATION_SOURCE_LABEL[s]}
            </button>
          ))}
        </div>
        <label>The system</label>
        <div className="seg" style={{ marginBottom: 8 }}>
          <button type="button" aria-pressed={mode === "new"} onClick={() => setMode("new")}>
            Just arrived — stage it
          </button>
          <button type="button" aria-pressed={mode === "existing"} onClick={() => setMode("existing")}>
            Already on the books
          </button>
        </div>
        {mode === "new" ? (
          <>
            <label>Staging ID</label>
            <input className="mono" value={stagedId} autoFocus
              onChange={(e) => { setStagedId(e.target.value); setIdEdited(true); }}
              style={{ maxWidth: 160, marginBottom: 8 }} aria-label="Staging ID" />
            <div className="mut t-meta" style={{ marginBottom: 8 }}>
              The tag on the crate until the record earns a better one - suggested
              from what exists, yours to overtype.
            </div>
            <label>What is it? <span className="mut" style={{ fontWeight: 400 }}>optional</span></label>
            <input value={name} placeholder="Thermo ISQ 7000 GC-MS — refine as serials resolve"
              onChange={(e) => setName(e.target.value)} />
          </>
        ) : (
          <>
            <select value={systemId || ""} aria-label="System" autoFocus
              onChange={(e) => setSystemId(parseInt(e.target.value) || 0)}>
              <option value="">Pick the system being restored</option>
              {systems.map((s) => (
                <option key={s.id} value={s.id}>{s.externalId}{s.label ? ` - ${s.label}` : ""}</option>
              ))}
            </select>
            <div className="mut t-meta" style={{ marginTop: 4 }}>
              One system runs one restoration at a time - anything mid-pipeline
              is not offered here.
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}
