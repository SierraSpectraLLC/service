"use client";

import { useOptimistic, useState, useTransition } from "react";
import { GAS_STATES, GAS_TONE } from "@/lib/stages";
import PickOrAdd from "./PickOrAdd";
import { toast } from "@/components/ui/Toast";
import { addInstrumentGas, setGasStatus, updateGasNote, removeInstrumentGas, type WorkTarget } from "@/app/actions";

export type GasRow = { id: number; gas: string; status: string; note: string };

function GasStatusSelect({ row }: { row: GasRow }) {
  const [, startTransition] = useTransition();
  const [status, setOptimistic] = useOptimistic(row.status, (_cur: string, next: string) => next);
  return (
    <select
      value={status}
      onChange={(e) => startTransition(async () => { setOptimistic(e.target.value); await setGasStatus(row.id, e.target.value); })}
      className="t-meta"
      style={{ width: "auto", fontWeight: 700, padding: "3px 6px", borderRadius: 999, background: `var(--t-${GAS_TONE[status] ?? "neutral"}-bg)`, color: `var(--t-${GAS_TONE[status] ?? "neutral"}-fg)`, cursor: "pointer" }}
    >
      {GAS_STATES.map((s) => <option key={s}>{s}</option>)}
    </select>
  );
}

export default function GasPanel({ target, gases, knownGases, canEdit, isStaff }: {
  // knownGases: every gas name in use across the shop, plus the starter list.
  target: WorkTarget; gases: GasRow[]; knownGases: string[]; canEdit: boolean; isStaff: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState("");
  const [error, setError] = useState("");
  const [noteDrafts, setNoteDrafts] = useState<Record<number, string>>({});
  const [pending, startTransition] = useTransition();

  const available = knownGases.filter((g) => !gases.some((r) => r.gas.toLowerCase() === g.toLowerCase()));

  const add = () => {
    const name = pick.trim();
    if (!name) return;
    setError("");
    startTransition(async () => {
      const res = await addInstrumentGas(target, name);
      if (res?.error) setError(res.error);
      else { setPick(""); setAdding(false); toast({ message: `Added ${name}` }); }
    });
  };

  const saveNote = (g: GasRow) => {
    const draft = noteDrafts[g.id];
    if (draft === undefined || draft.trim() === g.note) return;
    startTransition(async () => { await updateGasNote(g.id, draft); toast({ message: "Saved the note" }); });
  };

  if (!canEdit && gases.length === 0) return null;

  return (
    <>
      <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>Gases</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {gases.map((g) => (
          <div key={g.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="t-body" style={{ fontWeight: 700, width: 76 }}>{g.gas}</span>
            {canEdit ? (
              <GasStatusSelect row={g} />
            ) : (
              <span className={`pill ${GAS_TONE[g.status] ?? "neutral"}`}>{g.status}</span>
            )}
            {canEdit ? (
              <input
                value={noteDrafts[g.id] ?? g.note}
                onChange={(e) => setNoteDrafts((s) => ({ ...s, [g.id]: e.target.value }))}
                onBlur={() => saveNote(g)}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                placeholder='Tank details... e.g. "tank #A-441, swapped Jul 18"'
                className="t-small"
                style={{ flex: "1 1 180px", padding: "4px 9px" }}
              />
            ) : (
              g.note && <span className="mut t-small">{g.note}</span>
            )}
            {isStaff && (
              <button className="btn link" style={{ color: "var(--t-bad-fg)" }}
                onClick={() => startTransition(async () => { await removeInstrumentGas(g.id); toast({ message: `Removed ${g.gas}` }); })}>remove</button>
            )}
          </div>
        ))}
        {gases.length === 0 && <div className="mut t-small">No gas requirements recorded.</div>}
      </div>
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
      {canEdit && (
        <div style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {adding ? (
            <>
              <div style={{ flex: "1 1 200px", maxWidth: 260 }}>
                <PickOrAdd value={pick} options={available} newLabel="+ New gas..." placeholder="e.g. Zero air"
                  onChange={setPick} />
              </div>
              <button className="btn sm accent" onClick={add} disabled={pending || !pick.trim()}>
                {pending ? "Adding..." : "Add"}
              </button>
              <button className="btn link" onClick={() => { setAdding(false); setPick(""); setError(""); }}>cancel</button>
            </>
          ) : (
            <button className="btn link" onClick={() => setAdding(true)}>+ New gas</button>
          )}
        </div>
      )}
    </>
  );
}
