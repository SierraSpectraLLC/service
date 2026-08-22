"use client";

import Link from "next/link";
import { confirmDialog, confirmReason } from "@/components/ui/ConfirmDialog";
import { useState, useTransition } from "react";
import { ASSET_STATES, ASSET_TONE } from "@/lib/stages";
import { setAssetStatus, moveAsset, detachAsset, decommissionAsset, removeAsset, setAssetServes, updateAsset } from "@/app/actions";
import { toast } from "@/components/ui/Toast";
import Dialog from "@/components/ui/Dialog";
import { serveCandidates, serversOf } from "@/lib/assetServes";
import CatalogSelect from "./CatalogSelect";

type Asset = {
  id: number; kind: string; model: string; serial: string; manufacturer: string;
  owner: string; asFound: string; location: string; note: string; status: string; instrumentId: number | null;
  servesAssetId: number | null; servesRole: string;
};

/** The other units on this asset's system, enough of each to name it. */
export type Sibling = {
  id: number; instrumentId: number | null; servesAssetId: number | null;
  servesRole: string; label: string;
};

export default function AssetControls({ asset, siblings = [], systems, kinds, models, canEdit, isStaff }: {
  asset: Asset;
  siblings?: Sibling[];
  systems: { id: number; externalId: string }[]; kinds: string[];
  // Catalog models per type; the unit's current values stay selectable even
  // if they've since left the catalog (CatalogSelect handles that).
  models: Record<string, string[]>;
  canEdit: boolean; isStaff: boolean;
}) {
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ kind: asset.kind, model: asset.model, serial: asset.serial, manufacturer: asset.manufacturer, owner: asset.owner, asFound: asset.asFound, location: asset.location, note: asset.note });
  const [role, setRole] = useState(asset.servesRole);
  const [pending, startTransition] = useTransition();
  const statusTone = ASSET_TONE[asset.status] ?? "neutral";

  // What this unit may be pointed at, and what is pointed at it. Both from the
  // same rules the server checks against, so the picker never offers something
  // that would be refused.
  const candidates = serveCandidates(asset, siblings);
  const servers = serversOf(asset.id, siblings);
  const serving = siblings.find((s) => s.id === asset.servesAssetId) ?? null;

  const run = (fn: () => Promise<{ error?: string } | void>, after?: () => void) => {
    setError("");
    startTransition(async () => {
      const res = await fn();
      if (res && "error" in res && res.error) setError(res.error);
      else after?.();
    });
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {canEdit ? (
          <select value={asset.status} disabled={pending}
            onChange={(e) => run(() => setAssetStatus(asset.id, e.target.value))}
            style={{ width: "auto", fontSize: 12, fontWeight: 700, padding: "3px 8px", borderRadius: 999, background: `var(--t-${statusTone}-bg)`, color: `var(--t-${statusTone}-fg)` }}>
            {ASSET_STATES.map((s) => <option key={s}>{s}</option>)}
          </select>
        ) : (
          <span className={`pill ${statusTone}`}>{asset.status}</span>
        )}
        {canEdit && (
          <>
            <select value="" disabled={pending}
              onChange={async (e) => {
                const id = parseInt(e.target.value);
                if (!id) return;
                // Offered, never assumed: a roughing pump often stays plumbed to
                // the bench while the spec goes back to the shop, so the answer
                // is not something the software can know.
                let bringing: number[] = [];
                if (servers.length) {
                  const what = servers.map((s) => s.label).join(", ");
                  const one = servers.length === 1;
                  bringing = (await confirmDialog({
                    title: `${what} ${one ? "serves" : "serve"} this unit. Move ${one ? "it" : "them"} too?`,
                    body: `Leaving ${one ? "it" : "them"} behind drops the link.`,
                    action: one ? "Move it too" : "Move them too",
                    cancel: one ? "Leave it behind" : "Leave them behind",
                  })) ? servers.map((s) => s.id) : [];
                }
                run(() => moveAsset(asset.id, id, bringing), () => toast({ message: "Moved the unit" }));
              }}
              style={{ width: "auto", fontSize: 12 }}>
              <option value="">{asset.instrumentId !== null ? "Move to..." : "Install into..."}</option>
              {systems.filter((s) => s.id !== asset.instrumentId).map((s) => <option key={s.id} value={s.id}>{s.externalId}</option>)}
            </select>
            {asset.instrumentId !== null && (
              <button className="btn sm" disabled={pending}
                onClick={async () => {
                  if (!(await confirmDialog({
                    title: "Remove from its system?",
                    body: "It becomes a spare.",
                    action: "Detach unit",
                  }))) return;
                  run(() => detachAsset(asset.id), () => toast({ message: "Detached - now a spare" }));
                }}>
                Detach → Spare
              </button>
            )}
            <button className="btn sm" onClick={() => setEditing((v) => !v)}>{editing ? "Cancel" : "Edit"}</button>
          </>
        )}
        {isStaff && asset.status !== "Decommissioned" && (
          <button className="btn link" style={{ color: "var(--t-bad-fg)", fontSize: 12, fontWeight: 700 }} disabled={pending}
            onClick={async () => {
              if (!(await confirmDialog({
                title: "Decommission this asset?",
                body: "Its history stays; it leaves the active pool and stops generating maintenance.",
                action: "Decommission asset", tone: "bad",
              }))) return;
              run(() => decommissionAsset(asset.id), () => toast({ message: "Decommissioned the asset" }));
            }}>
            Decommission
          </button>
        )}
        {isStaff && (
          <button className="btn link" style={{ marginLeft: "auto", color: "var(--t-bad-fg)", fontSize: 11 }} disabled={pending}
            onClick={async () => {
              const reason = await confirmReason({
                title: "Permanently delete this asset record?",
                body: "Its history goes with it. Only for records created by mistake.",
                action: "Delete record", tone: "bad",
              });
              if (!reason) return;
              run(() => removeAsset(asset.id, reason));
            }}>
            delete record
          </button>
        )}
      </div>
      {/* What this unit is FOR, when it is for one module in particular - the
          roughing pump's mass spec, the chiller's detector. Sits with status
          and Move rather than inside Edit, because it is the same kind of fact
          as those two and applies the moment it is picked. Hidden entirely on
          a system with nothing to point at, which is most of them - and on a
          module that is itself served, where the server would refuse it, since
          a control that can only say no is worse than no control. */}
      {asset.instrumentId !== null && !servers.length && (candidates.length > 0 || serving) && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8, fontSize: 12 }}>
          <span className="mut">Serves</span>
          {canEdit ? (
            <select value={asset.servesAssetId ?? ""} disabled={pending}
              aria-label="The module this unit serves"
              onChange={(e) => {
                const v = e.target.value;
                run(() => setAssetServes(asset.id, v ? parseInt(v) : null, role));
              }}
              style={{ width: "auto", fontSize: 12 }}>
              <option value="">nothing in particular</option>
              {serving && <option value={serving.id}>{serving.label}</option>}
              {candidates.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          ) : (
            <b style={{ fontWeight: 700 }}>{serving ? serving.label : "nothing in particular"}</b>
          )}
          {serving && canEdit && (
            <>
              <span className="mut">as</span>
              <input value={role} disabled={pending} placeholder="fore-line" maxLength={40}
                aria-label="What it does for that module"
                onChange={(e) => setRole(e.target.value)}
                onBlur={() => { if (role !== asset.servesRole) run(() => setAssetServes(asset.id, asset.servesAssetId, role)); }}
                style={{ width: 120, fontSize: 12, padding: "3px 7px" }} />
            </>
          )}
          {serving && !canEdit && asset.servesRole && <span className="mut">as {asset.servesRole}</span>}
        </div>
      )}

      {/* The other direction. A mass spec with two pumps on it should say so on
          its own page, not only on theirs. */}
      {servers.length > 0 && (
        <div style={{ fontSize: 12, marginTop: 6 }}>
          <span className="mut">Served by </span>
          {servers.map((s, i) => (
            <span key={s.id}>
              {i > 0 && <span className="mut">, </span>}
              <Link href={`/assets/${s.id}`} style={{ fontWeight: 700 }}>{s.label}</Link>
              {s.servesRole && <span className="mut"> ({s.servesRole})</span>}
            </span>
          ))}
        </div>
      )}

      {editing && (
        <Dialog open onClose={() => setEditing(false)} title="Edit unit"
          footer={
            <>
              <span className={`dialog-status${error ? " err" : ""}`}>{error}</span>
              <button className="btn" onClick={() => setEditing(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" disabled={pending}
                onClick={() => run(async () => { const r = await updateAsset(asset.id, draft); if (!r?.error) setEditing(false); return r; },
                  () => toast({ message: "Saved the unit" }))}>
                {pending ? "Saving..." : "Save changes"}
              </button>
            </>
          }>
          <div className="pf3" style={{ marginBottom: 8 }}>
            <div>
              <label>Type</label>
              <CatalogSelect value={draft.kind} options={kinds} ariaLabel="Asset type"
                onChange={(kind) => setDraft({ ...draft, kind })}
                hint="Define module types in Settings → Catalog" />
            </div>
            <div>
              <label>Model</label>
              <CatalogSelect value={draft.model} options={models[draft.kind] ?? []} ariaLabel="Model" allowNew="+ New model..."
                onChange={(model) => setDraft({ ...draft, model })}
                hint={`No ${draft.kind || "?"} models defined yet - add them in Settings → Catalog`} />
            </div>
            <div><label>Serial #</label><input className="mono" value={draft.serial} onChange={(e) => setDraft({ ...draft, serial: e.target.value })} /></div>
          </div>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div><label>Manufacturer</label><input value={draft.manufacturer} onChange={(e) => setDraft({ ...draft, manufacturer: e.target.value })} /></div>
            <div><label>Location (off-system)</label><input value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} placeholder="Warehouse, shelf B" /></div>
          </div>
          {/* Owner is not edited here any more. It was a free-text box on this
              form AND a picker in the ownership section, set in two places and
              able to disagree - a unit could name one company on its row while
              another, or nobody, could actually open it. It decides visibility,
              so it belongs with sharing. */}
          <div className="mut" style={{ fontSize: 11, marginBottom: 8 }}>
            Owner: <b style={{ fontWeight: 700 }}>{asset.owner || "Unassigned"}</b> - set it under Sharing,
            below, where it also decides who can see this unit.
          </div>
          <div style={{ marginBottom: 8 }}>
            <label>As found (condition on arrival)</label>
            <textarea value={draft.asFound} onChange={(e) => setDraft({ ...draft, asFound: e.target.value })} rows={2}
              placeholder='e.g. "Pump head leaking, no error codes, missing drain line"' style={{ resize: "vertical" }} />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label>Notes</label>
            <textarea value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} rows={2}
              style={{ resize: "vertical" }} />
          </div>
        </Dialog>
      )}
      {error && <div style={{ fontSize: 12, color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </>
  );
}
