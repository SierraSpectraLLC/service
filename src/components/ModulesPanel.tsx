"use client";

import { useState, useTransition } from "react";
import { MODULE_KINDS } from "@/lib/stages";
import { addModule, updateModule, removeModule } from "@/app/actions";

export type ModuleRow = { id: number; kind: string; model: string; serial: string; note: string };

const empty = { kind: "Pump", model: "", serial: "", note: "" };

export default function ModulesPanel({ instrumentId, modules, canEdit, isStaff }: {
  instrumentId: number; modules: ModuleRow[]; canEdit: boolean; isStaff: boolean;
}) {
  const [form, setForm] = useState<null | { mode: "new" } | { mode: "edit"; id: number }>(null);
  const [draft, setDraft] = useState<typeof empty>(empty);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const openNew = () => { setDraft(empty); setError(""); setForm({ mode: "new" }); };
  const openEdit = (m: ModuleRow) => {
    setDraft({ kind: m.kind, model: m.model, serial: m.serial, note: m.note });
    setError("");
    setForm({ mode: "edit", id: m.id });
  };
  const close = () => { setForm(null); setDraft(empty); setError(""); };

  const save = () => {
    if (!form) return;
    startTransition(async () => {
      const res = form.mode === "new" ? await addModule(instrumentId, draft) : await updateModule(form.id, draft);
      if (res?.error) setError(res.error);
      else close();
    });
  };

  if (!canEdit && modules.length === 0) return null;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <div className="card-title">Modules</div>
        {canEdit && (
          <button className="btn sm primary" style={{ marginLeft: "auto" }} onClick={() => (form ? close() : openNew())}>
            {form ? "Cancel" : "+ Add module"}
          </button>
        )}
      </div>

      {form && (
        <div className="dash-form">
          <div className="pf3" style={{ marginBottom: 8 }}>
            <div>
              <label>Type</label>
              <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                {MODULE_KINDS.map((k) => <option key={k}>{k}</option>)}
              </select>
            </div>
            <div><label>Model</label><input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="LC-40D XR" /></div>
            <div><label>Serial #</label><input className="mono" value={draft.serial} onChange={(e) => setDraft({ ...draft, serial: e.target.value })} placeholder="L20304512345" /></div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <label>Note</label>
            <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder='e.g. "swapped in from G-010, seals replaced Jul 24"' />
          </div>
          {error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 8 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="btn sm accent" onClick={save} disabled={pending}>
              {pending ? "Saving..." : form.mode === "new" ? "Add module" : "Save changes"}
            </button>
            <button className="btn sm" onClick={close}>Cancel</button>
            {form.mode === "edit" && isStaff && (
              <button className="btn link" style={{ marginLeft: "auto", color: "#A32D2D", fontSize: 12, fontWeight: 700 }}
                onClick={() => {
                  if (!window.confirm("Remove this module?")) return;
                  startTransition(async () => { await removeModule((form as { id: number }).id); close(); });
                }}>Remove</button>
            )}
          </div>
        </div>
      )}

      {modules.length === 0 && !form && (
        <div className="mut" style={{ fontSize: 13 }}>No modules listed - add the pump, autosampler, detector and so on.</div>
      )}
      {modules.map((m) => (
        <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
          <span className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>{m.kind}</span>
          <span style={{ fontSize: 13, fontWeight: 700 }}>{m.model || <span className="mut">(no model)</span>}</span>
          {m.serial && <span className="mono mut" style={{ fontSize: 12 }}>SN {m.serial}</span>}
          {m.note && <span className="mut" style={{ fontSize: 12, flexBasis: "100%" }}>{m.note}</span>}
          {canEdit && <button className="btn link" style={{ marginLeft: "auto" }} onClick={() => openEdit(m)}>edit</button>}
        </div>
      ))}
    </div>
  );
}
