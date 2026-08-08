"use client";

import { useState, useTransition } from "react";
import { ASSET_STATES, ASSET_COLOR } from "@/lib/stages";
import { setAssetStatus, moveAsset, detachAsset, decommissionAsset, removeAsset, updateAsset } from "@/app/actions";
import { MODULE_KINDS } from "@/lib/stages";
import PickOrAdd from "./PickOrAdd";

type Asset = {
  id: number; kind: string; model: string; serial: string; manufacturer: string;
  owner: string; location: string; note: string; status: string; instrumentId: number | null;
};

export default function AssetControls({ asset, systems, owners, canEdit, isStaff }: {
  asset: Asset; systems: { id: number; externalId: string }[]; owners: string[];
  canEdit: boolean; isStaff: boolean;
}) {
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ kind: asset.kind, model: asset.model, serial: asset.serial, manufacturer: asset.manufacturer, owner: asset.owner, location: asset.location, note: asset.note });
  const [pending, startTransition] = useTransition();
  const c = ASSET_COLOR[asset.status] ?? ASSET_COLOR.Spare;

  const run = (fn: () => Promise<{ error?: string } | void>) => {
    setError("");
    startTransition(async () => {
      const res = await fn();
      if (res && "error" in res && res.error) setError(res.error);
    });
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {canEdit ? (
          <select value={asset.status} disabled={pending}
            onChange={(e) => run(() => setAssetStatus(asset.id, e.target.value))}
            style={{ width: "auto", fontSize: 12, fontWeight: 700, padding: "3px 8px", borderRadius: 999, background: c.bg, color: c.fg }}>
            {ASSET_STATES.map((s) => <option key={s}>{s}</option>)}
          </select>
        ) : (
          <span className="pill" style={{ background: c.bg, color: c.fg }}>{asset.status}</span>
        )}
        {canEdit && (
          <>
            <select value="" disabled={pending}
              onChange={(e) => { const id = parseInt(e.target.value); if (id) run(() => moveAsset(asset.id, id)); }}
              style={{ width: "auto", fontSize: 12 }}>
              <option value="">{asset.instrumentId !== null ? "Move to..." : "Install into..."}</option>
              {systems.filter((s) => s.id !== asset.instrumentId).map((s) => <option key={s.id} value={s.id}>{s.externalId}</option>)}
            </select>
            {asset.instrumentId !== null && (
              <button className="btn sm" disabled={pending}
                onClick={() => { if (window.confirm("Remove from its system? It becomes a spare.")) run(() => detachAsset(asset.id)); }}>
                Detach → Spare
              </button>
            )}
            <button className="btn sm" onClick={() => setEditing((v) => !v)}>{editing ? "Cancel" : "Edit"}</button>
          </>
        )}
        {isStaff && asset.status !== "Decommissioned" && (
          <button className="btn link" style={{ color: "#A32D2D", fontSize: 12, fontWeight: 700 }} disabled={pending}
            onClick={() => { if (window.confirm("Decommission this asset? Its history stays; it leaves the active pool.")) run(() => decommissionAsset(asset.id)); }}>
            Decommission
          </button>
        )}
        {isStaff && (
          <button className="btn link" style={{ marginLeft: "auto", color: "#A32D2D", fontSize: 11 }} disabled={pending}
            onClick={() => { if (window.confirm("Permanently delete this asset record AND its history? Only for records created by mistake.")) run(() => removeAsset(asset.id)); }}>
            delete record
          </button>
        )}
      </div>
      {editing && (
        <div className="dash-form" style={{ marginTop: 10 }}>
          <div className="pf3" style={{ marginBottom: 8 }}>
            <div>
              <label>Type</label>
              <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                {MODULE_KINDS.map((k) => <option key={k}>{k}</option>)}
              </select>
            </div>
            <div><label>Model</label><input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} /></div>
            <div><label>Serial #</label><input className="mono" value={draft.serial} onChange={(e) => setDraft({ ...draft, serial: e.target.value })} /></div>
          </div>
          <div className="pf3" style={{ marginBottom: 8 }}>
            <div><label>Manufacturer</label><input value={draft.manufacturer} onChange={(e) => setDraft({ ...draft, manufacturer: e.target.value })} /></div>
            <div>
              <label>Owner</label>
              <PickOrAdd value={draft.owner} options={owners} newLabel="+ New owner..." placeholder="Client name"
                onChange={(owner) => setDraft({ ...draft, owner })} />
            </div>
            <div><label>Location (off-system)</label><input value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} placeholder="Warehouse, shelf B" /></div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <label>Note</label>
            <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          </div>
          <button className="btn sm accent" disabled={pending}
            onClick={() => run(async () => { const r = await updateAsset(asset.id, draft); if (!r?.error) setEditing(false); return r; })}>
            {pending ? "Saving..." : "Save changes"}
          </button>
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
    </>
  );
}
