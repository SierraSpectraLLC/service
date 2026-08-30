"use client";

import { useState, useTransition } from "react";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { archiveStockroom, removeStockroomShare, setStockroomShare, updateStockroom } from "@/app/actions";
import Dialog from "@/components/ui/Dialog";
import KeeperPicker from "@/components/KeeperPicker";
import { toast } from "@/components/ui/Toast";

export type RoomShare = { orgId: number; name: string; kind: string; access: string };

const LEVEL: Record<string, { label: string; bg: string; fg: string }> = {
  view: { label: "can see counts", bg: "#EEF1F5", fg: "#475569" },
  issue: { label: "can draw parts", bg: "#E5F3E5", fg: "#2E6B2E" },
};

/**
 * Managing one room: its name and where it is, and who outside its own
 * organization may see or draw from it. The cross-org grant is the point - a
 * client hands their service provider "can draw parts" on their own cage, or a
 * provider gives the client visibility of the spares held for them.
 */
export default function StockroomAdmin({ room, shares, orgOptions, roster, ownerName }: {
  room: {
    id: number; name: string; kind: string; keeper: string; keeperEmail: string;
    location: string; note: string;
  };
  shares: RoomShare[];
  orgOptions: { id: number; name: string; kind: string }[];
  /** This workspace's people, for handing a kit to one of them. */
  roster: { email: string; name: string }[];
  ownerName: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    name: room.name, keeper: room.keeper, keeperEmail: room.keeperEmail,
    location: room.location, note: room.note,
  });
  const [adding, setAdding] = useState(false);
  const [pickedOrg, setPickedOrg] = useState(0);
  const [level, setLevel] = useState("view");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const options = orgOptions.filter((o) => !shares.some((s) => s.orgId === o.id));

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div className="card-title">Access &amp; details</div>
        <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => setEditing(!editing)}>
          {editing ? "Cancel" : "Edit"}
        </button>
      </div>

      {editing ? (
        <Dialog open onClose={() => setEditing(false)} title={`Edit ${room.name}`}
          footer={
            <>
              <span className={`dialog-status${error ? " err" : ""}`}>{error}</span>
              <button className="btn link danger"
                onClick={async () => {
                  const why = await confirmReason({
                    title: `Archive "${room.name}"?`,
                    body: "Its ledger stays - the room just stops appearing.",
                    action: "Archive", tone: "bad",
                  });
                  if (!why) return;
                  startTransition(async () => {
                    const res = await archiveStockroom(room.id, why);
                    if (res?.error) setError(res.error);
                  });
                }}>Archive</button>
              <button className="btn" onClick={() => setEditing(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" disabled={pending || !draft.name.trim()}
                onClick={() => startTransition(async () => {
                  const res = await updateStockroom(room.id, draft);
                  if (res?.error) setError(res.error);
                  else { setEditing(false); toast({ message: `Saved ${draft.name.trim()}` }); }
                })}>{pending ? "Saving..." : "Save stockroom"}</button>
            </>
          }>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div><label>Name *</label><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
            {room.kind === "mobile" && (
              <KeeperPicker roster={roster} disabled={pending}
                value={{ keeper: draft.keeper, keeperEmail: draft.keeperEmail }}
                onChange={(k) => setDraft({ ...draft, ...k })} />
            )}
            <div><label>Location</label><input value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} placeholder="Bay 2 / client site" /></div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label>Note</label>
            <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          </div>
        </Dialog>
      ) : (
        <div className="mut t-small" style={{ marginBottom: 10 }}>
          Belongs to <b style={{ color: "var(--ink)" }}>{ownerName}</b>
          {room.location ? ` · ${room.location}` : ""}{room.keeper ? ` · kept by ${room.keeper}` : ""}
        </div>
      )}

      <div className="eyebrow" style={{ margin: "4px 0 6px" }}>Shared with</div>
      {shares.length === 0 && (
        <div className="mut t-body">Nobody outside {ownerName}.</div>
      )}
      {shares.map((s) => (
        <div key={s.orgId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", flexWrap: "wrap" }}>
          <span className="t-body">{s.name}</span>
          <span className="pill accent">{s.kind}</span>
          <select value={s.access} disabled={pending}
            onChange={(e) => startTransition(async () => {
              const res = await setStockroomShare(room.id, s.orgId, e.target.value);
              if (res?.error) setError(res.error);
            })}
            className="t-meta"
            style={{
              width: "auto", fontWeight: 700, padding: "3px 6px", borderRadius: 999, cursor: "pointer",
              background: LEVEL[s.access]?.bg, color: LEVEL[s.access]?.fg,
            }}>
            <option value="view">{LEVEL.view.label}</option>
            <option value="issue">{LEVEL.issue.label}</option>
          </select>
          <button className="btn link" style={{ marginLeft: "auto", color: "var(--t-bad-fg)" }} disabled={pending}
            onClick={() => startTransition(async () => {
              const res = await removeStockroomShare(room.id, s.orgId);
              if (res?.error) setError(res.error);
            })}>remove</button>
        </div>
      ))}

      {adding ? (
        <div className="dash-form" style={{ marginTop: 8 }}>
          <div className="panel-head"><span className="card-title" style={{ fontSize: 14 }}>Share this room</span></div>
          <div className="row-2">
          <select value={pickedOrg} aria-label="Organization" onChange={(e) => setPickedOrg(parseInt(e.target.value))} className="t-body" style={{ width: "auto" }}>
            <option value={0}>Pick an organization…</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.kind})</option>)}
          </select>
          <select value={level} aria-label="Access level" onChange={(e) => setLevel(e.target.value)} className="t-body" style={{ width: "auto" }}>
            <option value="view">can see counts</option>
            <option value="issue">can draw parts</option>
          </select>
          <button className="btn sm accent" disabled={pending || !pickedOrg}
            onClick={() => startTransition(async () => {
              const res = await setStockroomShare(room.id, pickedOrg, level);
              if (res?.error) setError(res.error);
              else { setAdding(false); setPickedOrg(0); }
            })}>{pending ? "Sharing..." : "Share"}</button>
          <button className="btn sm" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : options.length > 0 ? (
        <button className="btn link" style={{ fontSize: 12, marginTop: 6 }} onClick={() => setAdding(true)}>
          + give another organization access
        </button>
      ) : null}

      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
