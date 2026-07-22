"use client";

import { useOptimistic, useState, useTransition } from "react";
import { GASES, GAS_STATES, GAS_COLOR } from "@/lib/stages";
import { addInstrumentGas, setGasStatus, updateGasNote, removeInstrumentGas } from "@/app/actions";

export type GasRow = { id: number; gas: string; status: string; note: string };

function GasStatusSelect({ row }: { row: GasRow }) {
  const [, startTransition] = useTransition();
  const [status, setOptimistic] = useOptimistic(row.status, (_cur: string, next: string) => next);
  return (
    <select
      value={status}
      onChange={(e) => startTransition(async () => { setOptimistic(e.target.value); await setGasStatus(row.id, e.target.value); })}
      style={{ width: "auto", fontSize: 11, fontWeight: 700, padding: "3px 6px", borderRadius: 999, background: GAS_COLOR[status]?.bg, color: GAS_COLOR[status]?.fg, cursor: "pointer" }}
    >
      {GAS_STATES.map((s) => <option key={s}>{s}</option>)}
    </select>
  );
}

export default function GasPanel({ instrumentId, gases, canEdit, isStaff }: {
  instrumentId: number; gases: GasRow[]; canEdit: boolean; isStaff: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [noteDrafts, setNoteDrafts] = useState<Record<number, string>>({});
  const [, startTransition] = useTransition();

  const available = GASES.filter((g) => !gases.some((r) => r.gas === g));

  const saveNote = (g: GasRow) => {
    const draft = noteDrafts[g.id];
    if (draft === undefined || draft.trim() === g.note) return;
    startTransition(() => updateGasNote(g.id, draft));
  };

  if (!canEdit && gases.length === 0) return null;

  return (
    <>
      <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>Gases</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {gases.map((g) => (
          <div key={g.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 700, width: 76 }}>{g.gas}</span>
            {canEdit ? (
              <GasStatusSelect row={g} />
            ) : (
              <span className="pill" style={{ background: GAS_COLOR[g.status]?.bg, color: GAS_COLOR[g.status]?.fg }}>{g.status}</span>
            )}
            {canEdit ? (
              <input
                value={noteDrafts[g.id] ?? g.note}
                onChange={(e) => setNoteDrafts((s) => ({ ...s, [g.id]: e.target.value }))}
                onBlur={() => saveNote(g)}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                placeholder='Tank details... e.g. "tank #A-441, swapped Jul 18"'
                style={{ flex: "1 1 180px", fontSize: 12, padding: "4px 9px" }}
              />
            ) : (
              g.note && <span className="mut" style={{ fontSize: 12 }}>{g.note}</span>
            )}
            {isStaff && (
              <button className="btn link" style={{ color: "#A32D2D", fontSize: 11 }}
                onClick={() => startTransition(() => removeInstrumentGas(g.id))}>remove</button>
            )}
          </div>
        ))}
        {gases.length === 0 && <div className="mut" style={{ fontSize: 12 }}>No gas requirements recorded.</div>}
      </div>
      {canEdit && available.length > 0 && (
        <div style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {adding ? (
            <>
              {available.map((g) => (
                <button key={g} className="btn sm" onClick={() => { setAdding(false); startTransition(() => addInstrumentGas(instrumentId, g)); }}>
                  {g}
                </button>
              ))}
              <button className="btn link" onClick={() => setAdding(false)}>cancel</button>
            </>
          ) : (
            <button className="btn link" onClick={() => setAdding(true)}>+ Add gas</button>
          )}
        </div>
      )}
    </>
  );
}
