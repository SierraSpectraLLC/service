"use client";

import { useOptimistic, useState, useTransition } from "react";
import StagePanel, { type StageDefLite } from "./StagePanel";
import GasPanel, { type GasRow } from "./GasPanel";
import { updateInstrument, updateInstrumentNotes, deleteInstrument, setInstrumentLead } from "@/app/actions";

type Inst = { id: number; externalId: string; client: string; model: string; priority: number; lead: string; notes: string };

function LeadSelect({ instrumentId, lead, people }: { instrumentId: number; lead: string; people: string[] }) {
  const [, startTransition] = useTransition();
  const [value, setOptimistic] = useOptimistic(lead, (_cur: string, next: string) => next);
  const options = ["", ...people, ...(value && !people.includes(value) ? [value] : [])];
  return (
    <select value={value}
      onChange={(e) => startTransition(async () => { setOptimistic(e.target.value); await setInstrumentLead(instrumentId, e.target.value); })}
      style={{ width: "auto", fontWeight: 700, fontSize: 12 }}>
      {options.map((p) => <option key={p} value={p}>{p || "-"}</option>)}
    </select>
  );
}

export default function SystemPanel({ instrument, stages, stageDefs, stageAges, gases, people, canEdit, isStaff, isOwner }: {
  instrument: Inst; stages: string[]; stageDefs: StageDefLite[]; stageAges: Record<string, string>;
  gases: GasRow[]; people: string[]; canEdit: boolean; isStaff: boolean; isOwner: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ client: "", model: "", priority: "", notes: "" });
  const [pending, startTransition] = useTransition();

  const openEdit = () => {
    setDraft({ client: instrument.client, model: instrument.model, priority: String(instrument.priority), notes: instrument.notes });
    setEditing(true);
  };

  const save = () => {
    if (isStaff && !draft.model.trim()) return;
    startTransition(async () => {
      if (isStaff) {
        await updateInstrument(instrument.id, {
          client: draft.client, model: draft.model,
          priority: parseInt(draft.priority) || instrument.priority,
        });
      }
      if (draft.notes !== instrument.notes) await updateInstrumentNotes(instrument.id, draft.notes);
      setEditing(false);
    });
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--mut)" }}>
            {instrument.externalId} · {instrument.client} · Priority {instrument.priority}
          </div>
          {!editing && (
            <>
              <div style={{ fontSize: 18, fontWeight: 700, color: "var(--navy)", marginTop: 2 }}>{instrument.model}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                <span className="mut" style={{ fontSize: 12 }}>Lead:</span>
                {canEdit
                  ? <LeadSelect instrumentId={instrument.id} lead={instrument.lead} people={people} />
                  : <span style={{ fontSize: 12, fontWeight: 700, color: instrument.lead ? "var(--navy)" : "var(--mut)" }}>{instrument.lead || "-"}</span>}
              </div>
              <div className="mut" style={{ fontSize: 13, marginTop: 6, whiteSpace: "pre-wrap" }}>{instrument.notes || "No notes."}</div>
            </>
          )}
        </div>
        {canEdit && !editing && (
          <button className="btn sm" style={{ flexShrink: 0 }} onClick={openEdit}>Edit system</button>
        )}
      </div>

      {editing && (
        <div className="dash-form" style={{ marginTop: 10, marginBottom: 0 }}>
          {isStaff && (
            <>
              <div className="pf-ship" style={{ marginBottom: 8 }}>
                <div><label>Client</label><input value={draft.client} onChange={(e) => setDraft({ ...draft, client: e.target.value })} /></div>
                <div><label>Priority</label><input value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })} /></div>
              </div>
              <div style={{ marginBottom: 8 }}>
                <label>Model *</label>
                <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
              </div>
            </>
          )}
          <div style={{ marginBottom: 10 }}>
            <label>Notes</label>
            <textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} rows={3}
              placeholder='Current state of the system, e.g. "No Helium - waiting on refill"' style={{ resize: "vertical" }} />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="btn sm accent" onClick={save} disabled={pending}>{pending ? "Saving..." : "Save changes"}</button>
            <button className="btn sm" onClick={() => setEditing(false)} disabled={pending}>Cancel</button>
            {isOwner && (
              <button
                className="btn link" style={{ marginLeft: "auto", color: "#A32D2D", fontSize: 12, fontWeight: 700 }}
                onClick={() => {
                  const typed = window.prompt(
                    `This permanently deletes ${instrument.externalId} with all its tasks, parts, gases and attachments.\n\nType ${instrument.externalId} to confirm:`
                  );
                  if (typed !== instrument.externalId) return;
                  startTransition(() => deleteInstrument(instrument.id));
                }}
              >Delete system</button>
            )}
          </div>
        </div>
      )}

      <StagePanel instrumentId={instrument.id} stages={stages} stageDefs={stageDefs} ages={stageAges} canEdit={canEdit} />
      <GasPanel instrumentId={instrument.id} gases={gases} canEdit={canEdit} isStaff={isStaff} />
    </div>
  );
}
