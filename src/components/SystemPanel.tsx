"use client";

import { useOptimistic, useState, useTransition, type ReactNode } from "react";
import StagePanel, { type StageDefLite } from "./StagePanel";
import GasPanel, { type GasRow } from "./GasPanel";
import ClientSelect from "./ClientSelect";
import { updateInstrument, updateInstrumentNotes, deleteInstrument, setInstrumentLead, setInstrumentArchived } from "@/app/actions";

type Inst = {
  id: number; externalId: string; client: string; priority: number;
  lead: string; notes: string; archived: boolean; archivedBy: string;
  location: string;
};

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

export default function SystemPanel({ instrument, label, clients, stages, stageDefs, gases, people, canEdit, isStaff, isOwner, children }: {
  // `label` is composed from the system's assets - see lib/systemLabel.ts.
  instrument: Inst; label: string; clients: string[]; stages: string[]; stageDefs: StageDefLite[];
  gases: GasRow[]; people: string[]; canEdit: boolean; isStaff: boolean; isOwner: boolean;
  children?: ReactNode; // the assets list: a system is what it's built from
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ externalId: "", client: "", priority: "", notes: "", location: "" });
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const openEdit = () => {
    setDraft({
      externalId: instrument.externalId, client: instrument.client,
      priority: String(instrument.priority), notes: instrument.notes, location: instrument.location,
    });
    setError("");
    setEditing(true);
  };

  const save = () => {
    setError("");
    startTransition(async () => {
      if (canEdit) {
        const res = await updateInstrument(instrument.id, {
          externalId: draft.externalId, client: draft.client,
          priority: parseInt(draft.priority) || instrument.priority,
          location: draft.location,
        });
        if (res?.error) { setError(res.error); return; } // keep the form open with the bad value
      }
      if (draft.notes !== instrument.notes) await updateInstrumentNotes(instrument.id, draft.notes);
      setEditing(false);
    });
  };

  return (
    <div className="card">
      {instrument.archived && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", background: "#EEF1F5", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px", marginBottom: 10 }}>
          <span className="pill" style={{ background: "#E2E8F0", color: "#475569" }}>Archived</span>
          <span className="mut" style={{ fontSize: 12 }}>
            Kept for the record{instrument.archivedBy ? ` · by ${instrument.archivedBy}` : ""} · hidden from the dashboard, EOD, and sheet parity.
          </span>
          {canEdit && (
            <button className="btn sm" style={{ marginLeft: "auto" }} disabled={pending}
              onClick={() => startTransition(() => setInstrumentArchived(instrument.id, false))}>Restore</button>
          )}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--mut)" }}>
            {instrument.externalId} · {instrument.client} · Priority {instrument.priority}
          </div>
          {!editing && (
            <>
              <div style={{ fontSize: 18, fontWeight: 700, color: "var(--navy)", marginTop: 2 }}>
                {label || <span className="mut" style={{ fontWeight: 400, fontSize: 15 }}>No assets listed yet</span>}
              </div>
              {instrument.location && <div className="mut" style={{ fontSize: 12, marginTop: 2 }}>{instrument.location}</div>}
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
          {canEdit && (
            <>
              <div className="pf3" style={{ marginBottom: 8 }}>
                <div>
                  <label>System ID *</label>
                  <input className="mono" value={draft.externalId} onChange={(e) => setDraft({ ...draft, externalId: e.target.value })} placeholder="X-004" />
                </div>
                <div>
                  <label>Client</label>
                  <ClientSelect value={draft.client} clients={clients} onChange={(client) => setDraft({ ...draft, client })} />
                </div>
                <div><label>Priority</label><input value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })} /></div>
              </div>
              <div style={{ marginBottom: 8 }}>
                <label>Location</label>
                <input value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} placeholder="Corner room, bench 3" />
              </div>
            </>
          )}
          <div style={{ marginBottom: 10 }}>
            <label>Notes</label>
            <textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} rows={3}
              placeholder='Current state of the system, e.g. "No Helium - waiting on refill"' style={{ resize: "vertical" }} />
          </div>
          {error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 8 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="btn sm accent" onClick={save} disabled={pending}>{pending ? "Saving..." : "Save changes"}</button>
            <button className="btn sm" onClick={() => setEditing(false)} disabled={pending}>Cancel</button>
            {!instrument.archived && (
              <button className="btn sm" style={{ marginLeft: "auto" }} disabled={pending}
                onClick={() => {
                  if (!window.confirm(`Archive ${instrument.externalId}? It keeps all its history and can be restored any time.`)) return;
                  startTransition(() => setInstrumentArchived(instrument.id, true));
                }}>Archive</button>
            )}
            {isOwner && (
              <button
                className="btn link" style={{ color: "#A32D2D", fontSize: 12, fontWeight: 700 }}
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

      {/* The system's composition sits with its identity, not in a section of its own. */}
      {children}
      <StagePanel instrumentId={instrument.id} stages={stages} stageDefs={stageDefs} canEdit={canEdit} />
      <GasPanel instrumentId={instrument.id} gases={gases} canEdit={canEdit} isStaff={isStaff} />
    </div>
  );
}
