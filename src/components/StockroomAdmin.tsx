"use client";

import { useState, useTransition } from "react";
import { promptReason } from "@/lib/reason";
import { archiveStockroom, removeStockroomShare, setStockroomShare, updateStockroom } from "@/app/actions";

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
export default function StockroomAdmin({ room, shares, orgOptions, ownerName }: {
  room: { id: number; name: string; kind: string; keeper: string; location: string; note: string };
  shares: RoomShare[];
  orgOptions: { id: number; name: string; kind: string }[];
  ownerName: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: room.name, keeper: room.keeper, location: room.location, note: room.note });
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
        <div className="dash-form" style={{ marginBottom: 12 }}>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div><label>Name *</label><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
            {room.kind === "mobile" && (
              <div><label>Kept by</label><input value={draft.keeper} onChange={(e) => setDraft({ ...draft, keeper: e.target.value })} placeholder="Whose van" /></div>
            )}
            <div><label>Location</label><input value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} placeholder="Bay 2 / client site" /></div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label>Note</label>
            <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="btn sm accent" disabled={pending || !draft.name.trim()}
              onClick={() => startTransition(async () => {
                const res = await updateStockroom(room.id, draft);
                if (res?.error) setError(res.error);
                else setEditing(false);
              })}>{pending ? "Saving..." : "Save"}</button>
            <button className="btn link" style={{ marginLeft: "auto", color: "#A32D2D", fontSize: 12, fontWeight: 700 }}
              onClick={() => {
                const why = promptReason(`Archive "${room.name}"? Its ledger stays - the room just stops appearing.`);
                if (!why) return;
                startTransition(async () => {
                  const res = await archiveStockroom(room.id, why);
                  if (res?.error) setError(res.error);
                });
              }}>Archive</button>
          </div>
        </div>
      ) : (
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Belongs to <b style={{ color: "var(--ink)" }}>{ownerName}</b>
          {room.location ? ` · ${room.location}` : ""}{room.keeper ? ` · kept by ${room.keeper}` : ""}
        </div>
      )}

      <div className="eyebrow" style={{ margin: "4px 0 6px" }}>Shared with</div>
      {shares.length === 0 && (
        <div className="mut" style={{ fontSize: 13 }}>Nobody outside {ownerName}.</div>
      )}
      {shares.map((s) => (
        <div key={s.orgId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}>{s.name}</span>
          <span className="pill" style={{ background: "#EDEBFA", color: "#4F45A3" }}>{s.kind}</span>
          <select value={s.access} disabled={pending}
            onChange={(e) => startTransition(async () => {
              const res = await setStockroomShare(room.id, s.orgId, e.target.value);
              if (res?.error) setError(res.error);
            })}
            style={{
              width: "auto", fontSize: 11, fontWeight: 700, padding: "3px 6px", borderRadius: 999, cursor: "pointer",
              background: LEVEL[s.access]?.bg, color: LEVEL[s.access]?.fg,
            }}>
            <option value="view">{LEVEL.view.label}</option>
            <option value="issue">{LEVEL.issue.label}</option>
          </select>
          <button className="btn link" style={{ marginLeft: "auto", color: "#A32D2D", fontSize: 11 }} disabled={pending}
            onClick={() => startTransition(async () => {
              const res = await removeStockroomShare(room.id, s.orgId);
              if (res?.error) setError(res.error);
            })}>remove</button>
        </div>
      ))}

      {adding ? (
        <div className="dash-form" style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={pickedOrg} onChange={(e) => setPickedOrg(parseInt(e.target.value))} style={{ width: "auto", fontSize: 13 }}>
            <option value={0}>Pick an organization…</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.kind})</option>)}
          </select>
          <select value={level} onChange={(e) => setLevel(e.target.value)} style={{ width: "auto", fontSize: 13 }}>
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
      ) : options.length > 0 ? (
        <button className="btn link" style={{ fontSize: 12, marginTop: 6 }} onClick={() => setAdding(true)}>
          + give another organization access
        </button>
      ) : null}

      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
