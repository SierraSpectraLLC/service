"use client";

import { useState, useTransition } from "react";
import { addVocabTerm, renameAssetModel } from "@/app/actions";
import { toast } from "@/components/ui/Toast";

type Pending = { kind: string; model: string; count: number };

/**
 * Models recorded on real units that the catalog has never heard of - the
 * other half of "never block anyone from adding a module". The shop floor
 * types what's on the machine; this queue is where a super user either
 * accepts the name into the book or folds it into the spelling the book
 * already has. Both resolutions clear the row.
 */
export default function PendingModelsCard({ pending, modelOptions, makers }: {
  pending: Pending[];
  /** Existing catalog models per module type, for the fold-into picker. */
  modelOptions: Record<string, string[]>;
  makers: string[];
}) {
  const [makerDraft, setMakerDraft] = useState<Record<string, string>>({});
  const [foldTo, setFoldTo] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [pendingT, startTransition] = useTransition();
  const key = (r: Pending) => `${r.kind}|${r.model}`;

  if (!pending.length) return null;

  const accept = (r: Pending) => {
    setError(""); setNote("");
    startTransition(async () => {
      const res = await addVocabTerm("model", r.kind, r.model, [], makerDraft[key(r)] ?? "");
      if (res?.error) { setError(res.error); return; }
      setNote(`"${r.model}" is in the catalog now - tag its system types there when you get a chance`);
      toast({ message: `Accepted ${r.model} into the catalog` });
    });
  };

  const fold = (r: Pending) => {
    const to = foldTo[key(r)];
    if (!to) return;
    setError(""); setNote("");
    startTransition(async () => {
      const res = await renameAssetModel(r.kind, r.model, to);
      if (res?.error) { setError(res.error); return; }
      setNote(`${res.changed} unit${res.changed === 1 ? "" : "s"} moved from "${r.model}" to "${to}"`);
      toast({ message: `Folded ${r.model} into ${to}` });
    });
  };

  return (
    <div className="card" style={{ borderLeft: "3px solid var(--t-warn-fg)" }}>
      <div className="card-title" style={{ marginBottom: 4 }}>Models awaiting review</div>
      <div className="mut t-meta" style={{ marginBottom: 8 }}>
        Recorded on real units, not in the catalog yet. Accept the name into the book, or fold it into a model that&apos;s already there (that renames the units).
      </div>
      {pending.map((r) => (
        <div key={key(r)} style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
          <div className="row-2" style={{ alignItems: "baseline" }}>
            <span className="t-body" style={{ fontWeight: 700 }}>{r.model}</span>
            <span className="mut t-meta">{r.kind} · {r.count} unit{r.count === 1 ? "" : "s"}</span>
          </div>
          <div className="row-2" style={{ marginTop: 6 }}>
            <input value={makerDraft[key(r)] ?? ""} list="maker-book" placeholder="Maker (optional)"
              aria-label={`Maker for ${r.model}`}
              onChange={(e) => setMakerDraft((m) => ({ ...m, [key(r)]: e.target.value }))}
              className="t-small" style={{ flex: "0 1 150px" }} />
            <button className="btn sm accent" disabled={pendingT} onClick={() => accept(r)}>Accept into catalog</button>
            <span className="mut t-meta">or</span>
            <select value={foldTo[key(r)] ?? ""} aria-label={`Fold ${r.model} into`}
              onChange={(e) => setFoldTo((m) => ({ ...m, [key(r)]: e.target.value }))}
              className="t-small" style={{ width: "auto" }}>
              <option value="">Fold into existing...</option>
              {(modelOptions[r.kind] ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button className="btn sm" disabled={pendingT || !foldTo[key(r)]} onClick={() => fold(r)}>Apply</button>
          </div>
        </div>
      ))}
      <datalist id="maker-book">{makers.map((m) => <option key={m} value={m} />)}</datalist>
      {note && <div className="t-small" style={{ color: "var(--t-good-fg)", fontWeight: 700, marginTop: 8 }}>{note} ✓</div>}
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
