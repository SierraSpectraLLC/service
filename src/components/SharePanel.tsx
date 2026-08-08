"use client";

import { useState, useTransition } from "react";
import { shareSystem, unshareSystem } from "@/app/actions";
import { promptReason } from "@/lib/reason";

export type ShareEntry = { orgId: number; name: string; kind: string; access: string };
type OrgOption = { id: number; name: string; kind: string };

const LEVEL = { view: { label: "can view", bg: "#EEF1F5", fg: "#475569" }, edit: { label: "can edit", bg: "#E5F3E5", fg: "#2E6B2E" } };

/**
 * Who else can see this system. Staff manage every organization; an org with
 * edit rights can bring in a service provider (and withdraw one) but never
 * touch its own access - the server enforces the same split.
 */
export default function SharePanel({ instrumentId, shares, orgOptions, canManageAll, canAddProvider }: {
  instrumentId: number; shares: ShareEntry[]; orgOptions: OrgOption[];
  canManageAll: boolean; canAddProvider: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState("");
  const [level, setLevel] = useState("view");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  // An org can only add providers, so that's all it may pick from.
  const options = orgOptions
    .filter((o) => canManageAll || o.kind === "provider")
    .filter((o) => !shares.some((s) => s.orgId === o.id));

  const add = () => {
    const orgId = parseInt(pick);
    if (!orgId) return;
    setError("");
    startTransition(async () => {
      const res = await shareSystem(instrumentId, orgId, canManageAll ? level : "edit");
      if (res?.error) setError(res.error);
      else { setPick(""); setAdding(false); }
    });
  };

  const remove = (s: ShareEntry) => {
    const reason = promptReason(
      s.kind === "provider"
        ? `End ${s.name}'s engagement on this system? They lose live access immediately but keep a frozen, read-only record of the work up to today.`
        : `Remove ${s.name}'s access to this system? They lose sight of it immediately.`
    );
    if (!reason) return; // the confirm doubles as the "are you sure"
    setError("");
    startTransition(async () => {
      const res = await unshareSystem(instrumentId, s.orgId);
      if (res?.error) setError(res.error);
    });
  };

  if (!shares.length && !canManageAll && !canAddProvider) return null;

  return (
    <>
      <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>Shared with</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {shares.map((s) => {
          const l = LEVEL[s.access as keyof typeof LEVEL] ?? LEVEL.view;
          const mayRemove = canManageAll || (canAddProvider && s.kind === "provider");
          return (
            <span key={s.orgId} className="pill"
              style={{ background: s.kind === "provider" ? "#FAF0DC" : "#E7F2FA", color: s.kind === "provider" ? "#8A5410" : "#1D6396", display: "inline-flex", alignItems: "center", gap: 5 }}>
              {s.name}
              <span style={{ fontWeight: 400, opacity: 0.8 }}>· {l.label}</span>
              {canManageAll && (
                <select value={s.access} disabled={pending}
                  onChange={(e) => startTransition(async () => {
                    const res = await shareSystem(instrumentId, s.orgId, e.target.value);
                    if (res?.error) setError(res.error);
                  })}
                  aria-label={`Access level for ${s.name}`}
                  style={{ width: "auto", fontSize: 10, padding: "0 2px", border: "none", background: "transparent", color: "inherit", fontWeight: 700, cursor: "pointer" }}>
                  <option value="view">view</option>
                  <option value="edit">edit</option>
                </select>
              )}
              {mayRemove && (
                <button className="chip-x" aria-label={`Remove ${s.name}`} disabled={pending} onClick={() => remove(s)}
                  style={{ border: "none", background: "none", color: "inherit", cursor: "pointer", padding: 0, fontSize: 12, lineHeight: 1 }}>×</button>
              )}
            </span>
          );
        })}
        {shares.length === 0 && (
          <span className="mut" style={{ fontSize: 12 }}>Only Sierra Spectra can see this system.</span>
        )}
        {(canManageAll || canAddProvider) && options.length > 0 && !adding && (
          <button className="btn link" onClick={() => setAdding(true)}>
            {canManageAll ? "+ Share" : "+ Service provider"}
          </button>
        )}
      </div>

      {adding && (
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ width: "auto", fontSize: 12 }}>
            <option value="">Choose an organization...</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.name}{o.kind === "provider" ? " (provider)" : ""}</option>)}
          </select>
          {canManageAll && (
            <select value={level} onChange={(e) => setLevel(e.target.value)} style={{ width: "auto", fontSize: 12 }}>
              <option value="view">can view</option>
              <option value="edit">can edit</option>
            </select>
          )}
          <button className="btn sm accent" onClick={add} disabled={pending || !pick}>{pending ? "Sharing..." : "Share"}</button>
          <button className="btn link" onClick={() => { setAdding(false); setPick(""); setError(""); }}>cancel</button>
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
    </>
  );
}
