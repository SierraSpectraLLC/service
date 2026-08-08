"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { MODULE_KINDS, ASSET_COLOR } from "@/lib/stages";
import { createAsset, attachAsset } from "@/app/actions";

export type AssetRow = {
  id: number; kind: string; model: string; serial: string; status: string; note: string; openItems: number;
};

const empty = { kind: "Pump", model: "", serial: "", manufacturer: "", location: "", note: "" };

export default function AssetsPanel({ instrumentId, assets, spares, canEdit, embedded }: {
  instrumentId: number; assets: AssetRow[]; spares: { id: number; label: string }[]; canEdit: boolean;
  // Embedded: rendered inside the system card (the system *is* its assets), so
  // no card chrome of its own.
  embedded?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<typeof empty>(empty);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError("");
    startTransition(async () => {
      const res = await createAsset(instrumentId, draft);
      if (res?.error) setError(res.error);
      else { setDraft(empty); setOpen(false); }
    });
  };

  if (!canEdit && assets.length === 0 && !embedded) return null;

  return (
    <div className={embedded ? "" : "card"} style={embedded ? { marginTop: 14 } : undefined}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: embedded ? 4 : 10, flexWrap: "wrap" }}>
        {embedded ? <div className="eyebrow">Assets</div> : <div className="card-title">Assets</div>}
        {canEdit && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            {spares.length > 0 && (
              <select value="" disabled={pending}
                onChange={(e) => {
                  const id = parseInt(e.target.value);
                  if (id) startTransition(async () => { const r = await attachAsset(id, instrumentId); if (r?.error) setError(r.error); });
                }}
                style={{ width: "auto", fontSize: 12 }}>
                <option value="">Attach spare...</option>
                {spares.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            )}
            <button className="btn sm primary" onClick={() => setOpen((v) => !v)}>{open ? "Cancel" : "+ New asset"}</button>
          </div>
        )}
      </div>

      {open && (
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
          <div className="pf2" style={{ marginBottom: 10 }}>
            <div><label>Manufacturer</label><input value={draft.manufacturer} onChange={(e) => setDraft({ ...draft, manufacturer: e.target.value })} placeholder="Shimadzu" /></div>
            <div><label>Note</label><input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder='e.g. "seals replaced Jul 24"' /></div>
          </div>
          {error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 8 }}>{error}</div>}
          <button className="btn sm accent" onClick={submit} disabled={pending || (!draft.model.trim() && !draft.serial.trim())}>
            {pending ? "Saving..." : "Add asset"}
          </button>
        </div>
      )}
      {!open && error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 8 }}>{error}</div>}

      {assets.length === 0 && !open && (
        <div className="mut" style={{ fontSize: 13 }}>No assets listed - add the pump, autosampler, detector and so on.</div>
      )}
      {assets.map((a) => {
        const c = ASSET_COLOR[a.status] ?? ASSET_COLOR.Spare;
        return (
          <Link key={a.id} href={`/assets/${a.id}`} className="row-hover"
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 4px", borderTop: "1px solid var(--line)", flexWrap: "wrap", textDecoration: "none", color: "inherit" }}>
            <span title={a.status} style={{ width: 10, height: 10, borderRadius: "50%", background: c.fg, flexShrink: 0 }} />
            <span className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>{a.kind}</span>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{a.model || <span className="mut">(no model)</span>}</span>
            {a.serial && <span className="mono mut" style={{ fontSize: 12 }}>SN {a.serial}</span>}
            {a.status !== "In service" && <span className="pill" style={{ background: c.bg, color: c.fg }}>{a.status}</span>}
            <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
              {a.openItems > 0 && <span className="pill" style={{ background: "#FAF0DC", color: "#8A5410" }}>{a.openItems} open</span>}
              <span className="mut" style={{ fontSize: 12 }}>→</span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}
