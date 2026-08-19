"use client";

import { useState, useTransition } from "react";
import { addVocabTerm, renameAssetModel } from "@/app/actions";

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
    });
  };

  return (
    <div className="card" style={{ borderLeft: "3px solid #8A5410" }}>
      <div className="card-title" style={{ marginBottom: 4 }}>Models awaiting review</div>
      <div className="mut" style={{ fontSize: 11, marginBottom: 8 }}>
        Recorded on real units, not in the catalog yet. Accept the name into the book, or fold it into a model that&apos;s already there (that renames the units).
      </div>
      {pending.map((r) => (
        <div key={key(r)} style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{r.model}</span>
            <span className="mut" style={{ fontSize: 11 }}>{r.kind} · {r.count} unit{r.count === 1 ? "" : "s"}</span>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
            <input value={makerDraft[key(r)] ?? ""} list="maker-book" placeholder="Maker (optional)"
              aria-label={`Maker for ${r.model}`}
              onChange={(e) => setMakerDraft((m) => ({ ...m, [key(r)]: e.target.value }))}
              style={{ flex: "0 1 150px", fontSize: 12 }} />
            <button className="btn sm accent" disabled={pendingT} onClick={() => accept(r)}>Accept into catalog</button>
            <span className="mut" style={{ fontSize: 11 }}>or</span>
            <select value={foldTo[key(r)] ?? ""} aria-label={`Fold ${r.model} into`}
              onChange={(e) => setFoldTo((m) => ({ ...m, [key(r)]: e.target.value }))}
              style={{ width: "auto", fontSize: 12 }}>
              <option value="">Fold into existing...</option>
              {(modelOptions[r.kind] ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button className="btn sm" disabled={pendingT || !foldTo[key(r)]} onClick={() => fold(r)}>Apply</button>
          </div>
        </div>
      ))}
      <datalist id="maker-book">{makers.map((m) => <option key={m} value={m} />)}</datalist>
      {note && <div style={{ fontSize: 12, color: "#2E6B2E", fontWeight: 700, marginTop: 8 }}>{note} ✓</div>}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
