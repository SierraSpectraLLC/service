"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setModelSpecs } from "@/app/actions";
import Dialog from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { MAX_SPECS, mergeModelSpecs, type Spec } from "@/lib/modelSpecs";
import SpecTable from "./SpecTable";

/**
 * The model's spec sheet: max pressure, flow range, operating temperature -
 * whatever rows this model deserves, named freely, suggested from what sibling
 * models already use so spellings converge.
 *
 * "Copy from" pulls another model's sheet in to fill the blanks - a G7116B
 * starts as a G7116A and gets its differences edited by hand, which is the
 * whole reason the sheet exists. Copying never overwrites a row already here.
 */
export default function ModelSpecsCard({ termId, modelName, specs, siblings, nameSuggestions }: {
  termId: number;
  modelName: string;
  specs: Spec[];
  /** Same-type models that have sheets of their own, offered as copy sources. */
  siblings: { name: string; specs: Spec[] }[];
  nameSuggestions: string[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<Spec[]>(specs);
  const [copyFrom, setCopyFrom] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const startEdit = () => { setRows(specs.length ? specs.map((s) => ({ ...s })) : [{ name: "", value: "" }]); setError(""); setEditing(true); };
  const setRow = (i: number, patch: Partial<Spec>) =>
    setRows((rs) => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  const copy = (name: string) => {
    setCopyFrom("");
    const src = siblings.find((s) => s.name === name);
    if (!src) return;
    setRows((rs) => mergeModelSpecs(rs.filter((r) => r.name.trim() && r.value.trim()), src.specs));
  };

  const save = () => {
    setError("");
    startTransition(async () => {
      const res = await setModelSpecs(termId, rows);
      if (res?.error) { setError(res.error); return; }
      setEditing(false);
      toast({ message: "Saved the specs" });
      router.refresh();
    });
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
        <div className="card-title">Specifications</div>
        {!editing && (
          <button className="btn sm" style={{ marginLeft: "auto" }} onClick={startEdit}>
            {specs.length ? "Edit" : "+ Add specs"}
          </button>
        )}
      </div>
      <div className="mut t-meta" style={{ marginBottom: 8 }}>
        The numbers you&apos;d otherwise open the manual for. Rows are yours to define - add what matters for a {modelName}.
      </div>

      {!editing && specs.length > 0 && <SpecTable specs={specs} />}
      {!editing && specs.length === 0 && (
        <div className="mut t-small">
          No specs recorded yet{siblings.length ? " - or start by copying a sibling's sheet and editing the differences" : ""}.
        </div>
      )}

      {editing && (
        <Dialog open onClose={() => setEditing(false)} title="Edit specs"
          footer={
            <>
              <span className={`dialog-status${error ? " err" : ""}`}>{error}</span>
              <button className="btn" onClick={() => setEditing(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={save} disabled={pending}>
                {pending ? "Saving..." : "Save specs"}
              </button>
            </>
          }>
          {siblings.length > 0 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
              <select value={copyFrom} onChange={(e) => copy(e.target.value)} className="t-small" style={{ width: "auto" }}
                aria-label="Copy specs from">
                <option value="">Copy from...</option>
                {siblings.map((s) => <option key={s.name} value={s.name}>{s.name} ({s.specs.length} rows)</option>)}
              </select>
              <span className="mut t-meta">Fills rows you don&apos;t have; never overwrites yours.</span>
            </div>
          )}
          {rows.map((r, i) => (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
              <input value={r.name} list="spec-names" placeholder='e.g. "Max pressure"'
                aria-label={`Spec name, row ${i + 1}`}
                onChange={(e) => setRow(i, { name: e.target.value })}
                className="t-body" style={{ flex: "0 1 220px" }} />
              <input value={r.value} placeholder='e.g. "1300 bar"'
                aria-label={`Spec value, row ${i + 1}`}
                onChange={(e) => setRow(i, { value: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter" && i === rows.length - 1 && rows.length < MAX_SPECS) setRows((rs) => [...rs, { name: "", value: "" }]); }}
                className="t-body" style={{ flex: "1 1 200px" }} />
              <button className="btn link" aria-label={`Remove row ${i + 1}`} style={{ color: "var(--t-bad-fg)", fontSize: 13 }}
                onClick={() => setRows((rs) => rs.filter((_, n) => n !== i))}>×</button>
            </div>
          ))}
          <datalist id="spec-names">{nameSuggestions.map((n) => <option key={n} value={n} />)}</datalist>
          {rows.length < MAX_SPECS && (
            <button className="btn sm" style={{ marginTop: 4 }} onClick={() => setRows((rs) => [...rs, { name: "", value: "" }])}>＋ Row</button>
          )}
        </Dialog>
      )}
    </div>
  );
}
