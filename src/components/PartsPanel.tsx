"use client";

import { useState, useTransition } from "react";
import { CARRIERS, PART_STATES, PART_COLOR, trackUrl } from "@/lib/stages";
import { createPart, updatePart, setPartStatus, deletePart } from "@/app/actions";

type Part = {
  id: number; name: string; partNumber: string; vendor: string; po: string; cost: string;
  carrier: string; tracking: string; orderedAt: string; eta: string; receivedAt: string;
  status: string; createdAt: string;
};

const empty = { name: "", partNumber: "", vendor: "", po: "", cost: "", carrier: "", tracking: "", orderedAt: "", eta: "", status: "Needed" };

export default function PartsPanel({ instrumentId, parts, canEdit, isStaff }: { instrumentId: number; parts: Part[]; canEdit: boolean; isStaff: boolean }) {
  const [form, setForm] = useState<null | { mode: "new" } | { mode: "edit"; id: number }>(null);
  const [draft, setDraft] = useState<typeof empty>(empty);
  const [pending, startTransition] = useTransition();

  const openNew = () => { setDraft(empty); setForm({ mode: "new" }); };
  const openEdit = (p: Part) => {
    setDraft({ name: p.name, partNumber: p.partNumber, vendor: p.vendor, po: p.po, cost: p.cost, carrier: p.carrier, tracking: p.tracking, orderedAt: p.orderedAt, eta: p.eta, status: p.status });
    setForm({ mode: "edit", id: p.id });
  };
  const close = () => { setForm(null); setDraft(empty); };

  const save = () => {
    if (!draft.name.trim() || !form) return;
    startTransition(async () => {
      if (form.mode === "new") await createPart(instrumentId, draft);
      else await updatePart(form.id, draft);
      close();
    });
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <div className="card-title">Parts</div>
        {canEdit && (
          <button className="btn sm primary" style={{ marginLeft: "auto" }} onClick={() => (form ? close() : openNew())}>
            {form ? "Cancel" : "+ Order part"}
          </button>
        )}
      </div>

      {form && (
        <div className="dash-form">
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--navy)", marginBottom: 10 }}>
            {form.mode === "new" ? "New part order" : "Edit part"}
          </div>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div style={{ gridColumn: "1 / -1" }}>
              <label>Part name *</label>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. 10kV HED supply" />
            </div>
            <div><label>Part number</label><input value={draft.partNumber} onChange={(e) => setDraft({ ...draft, partNumber: e.target.value })} placeholder="G6303-80060" /></div>
            <div><label>Vendor</label><input value={draft.vendor} onChange={(e) => setDraft({ ...draft, vendor: e.target.value })} placeholder="Applied Kilovolts" /></div>
          </div>
          <div className="pf3" style={{ marginBottom: 8 }}>
            <div><label>PO #</label><input value={draft.po} onChange={(e) => setDraft({ ...draft, po: e.target.value })} placeholder="SS-1042" /></div>
            <div><label>Cost ($)</label><input value={draft.cost} onChange={(e) => setDraft({ ...draft, cost: e.target.value })} placeholder="1,240" /></div>
            <div>
              <label>Status</label>
              <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
                {PART_STATES.map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="pf-ship" style={{ marginBottom: 8 }}>
            <div>
              <label>Carrier</label>
              <select value={draft.carrier} onChange={(e) => setDraft({ ...draft, carrier: e.target.value })}>
                {CARRIERS.map((c) => <option key={c} value={c}>{c || "-"}</option>)}
              </select>
            </div>
            <div><label>Tracking #</label><input className="mono" value={draft.tracking} onChange={(e) => setDraft({ ...draft, tracking: e.target.value })} placeholder="1Z999AA10123456784" /></div>
          </div>
          <div className="pf2" style={{ marginBottom: 12 }}>
            <div><label>Ordered</label><input value={draft.orderedAt} onChange={(e) => setDraft({ ...draft, orderedAt: e.target.value })} placeholder="Jul 18" /></div>
            <div><label>ETA</label><input value={draft.eta} onChange={(e) => setDraft({ ...draft, eta: e.target.value })} placeholder="Jul 23" /></div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="btn sm accent" onClick={save} disabled={pending}>
              {pending ? "Saving..." : form.mode === "new" ? "Add part" : "Save changes"}
            </button>
            <button className="btn sm" onClick={close}>Cancel</button>
            {form.mode === "edit" && isStaff && (
              <button
                className="btn link" style={{ marginLeft: "auto", color: "#A32D2D", fontSize: 12, fontWeight: 700 }}
                onClick={() => startTransition(async () => { await deletePart((form as { id: number }).id); close(); })}
              >Remove</button>
            )}
          </div>
        </div>
      )}

      {parts.length === 0 && !form && <div className="mut" style={{ fontSize: 13 }}>No parts ordered for this system.</div>}
      {parts.map((p) => {
        const link = trackUrl(p.carrier, p.tracking);
        return (
          <div key={p.id} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", marginBottom: 8, background: "#FAFBFD" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{p.name}</span>
              {canEdit ? (
                <select
                  value={p.status}
                  onChange={(e) => startTransition(() => setPartStatus(p.id, e.target.value))}
                  style={{ width: "auto", fontSize: 11, fontWeight: 700, padding: "3px 6px", borderRadius: 999, background: PART_COLOR[p.status]?.bg, color: PART_COLOR[p.status]?.fg, cursor: "pointer" }}
                >
                  {PART_STATES.map((s) => <option key={s}>{s}</option>)}
                </select>
              ) : (
                <span className="pill" style={{ background: PART_COLOR[p.status]?.bg, color: PART_COLOR[p.status]?.fg }}>{p.status}</span>
              )}
              {canEdit && <button className="btn link" style={{ marginLeft: "auto" }} onClick={() => openEdit(p)}>edit</button>}
            </div>
            <div className="mut" style={{ fontSize: 12, marginTop: 5 }}>
              {p.partNumber ? <>PN {p.partNumber}</> : "No PN"}
              {p.vendor ? " · " + p.vendor : ""}{p.po ? " · PO " + p.po : ""}{p.cost ? " · $" + p.cost : ""}
            </div>
            {(p.tracking || p.eta || p.orderedAt || p.receivedAt) && (
              <div style={{ fontSize: 12, marginTop: 5, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                {p.tracking && (link
                  ? <a className="mono" href={link} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>{p.carrier} {p.tracking} ↗</a>
                  : <span className="mono" style={{ color: "#1D6396" }}>{p.carrier ? p.carrier + " " : ""}{p.tracking}</span>)}
                {p.orderedAt && <span className="mut">Ordered {p.orderedAt}</span>}
                {p.eta && <span className="mut">ETA {p.eta}</span>}
                {p.receivedAt && <span style={{ color: "#2E6B2E" }}>Received {p.receivedAt}</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
