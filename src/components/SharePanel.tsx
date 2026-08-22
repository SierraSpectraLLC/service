"use client";

import { useState, useTransition } from "react";
import { shareSystem, unshareSystem, setSystemOwner, shareAsset, unshareAsset, setAssetOwnerOrg } from "@/app/actions";
import { promptReason } from "@/lib/reason";
import { orgNamed } from "@/lib/owner";

export type ShareEntry = { orgId: number; name: string; kind: string; access: string };
type OrgOption = { id: number; name: string; kind: string };

const LEVEL = { view: { label: "can view", bg: "#EEF1F5", fg: "#475569" }, edit: { label: "can edit", bg: "#E5F3E5", fg: "#2E6B2E" } };

/**
 * Who else can see this system or asset. Staff manage every organization; an
 * org with edit rights can bring in a service provider (and withdraw one) but
 * never touch its own access - the server enforces the same split.
 */
export default function SharePanel({ target = "system", targetId, shares, orgOptions, ownerOrgId, ownerName = "", canManageAll, canAddProvider }: {
  target?: "system" | "asset"; targetId: number; shares: ShareEntry[]; orgOptions: OrgOption[];
  // Which client org owns it (null = the house stewards it). Owners decide
  // access requests; staff assign ownership - it's also the claim flow.
  ownerOrgId: number | null;
  /** The stored label. Only ever its own text when no organization is linked. */
  ownerName?: string;
  canManageAll: boolean; canAddProvider: boolean;
}) {
  const doShare = target === "asset" ? shareAsset : shareSystem;
  const doUnshare = target === "asset" ? unshareAsset : unshareSystem;
  const doSetOwner = target === "asset" ? setAssetOwnerOrg : setSystemOwner;
  // Somebody who is not on the platform: a name and nothing else. Open when a
  // record already carries one, so it is visible rather than hidden behind a
  // dropdown option somebody has to find.
  const [offPlatform, setOffPlatform] = useState(
    target === "asset" && ownerOrgId === null && ownerName !== "");
  const [typed, setTyped] = useState(ownerName);
  // The organization somebody clearly meant when they typed the label.
  const match = ownerOrgId === null ? orgNamed(ownerName, orgOptions) : null;
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const [level, setLevel] = useState("view");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  // An org can only add providers, so that's all it may pick from.
  const options = orgOptions
    .filter((o) => canManageAll || o.kind === "provider")
    .filter((o) => !shares.some((s) => s.orgId === o.id));

  const toggle = (id: number) =>
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  // Several orgs can go on in one step; failures report together.
  const add = () => {
    if (!picked.length) return;
    setError("");
    startTransition(async () => {
      const results = await Promise.all(picked.map((orgId) => doShare(targetId, orgId, canManageAll ? level : "edit")));
      const errors = results.map((r) => r?.error).filter(Boolean);
      if (errors.length) setError([...new Set(errors)].join(" · "));
      else { setPicked([]); setAdding(false); }
    });
  };

  const remove = (s: ShareEntry) => {
    const reason = promptReason(
      target === "system" && s.kind === "provider"
        ? `End ${s.name}'s engagement? They keep a frozen, read-only record of the work up to today.`
        : `Remove ${s.name}'s access? They lose sight of it immediately.`
    );
    if (!reason) return; // the confirm doubles as the "are you sure"
    setError("");
    startTransition(async () => {
      const res = await doUnshare(targetId, s.orgId);
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
            <span key={s.orgId} className={`pill ${s.kind === "provider" ? "warn" : "info"}`}
              style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              {s.name}
              {s.orgId === ownerOrgId && <span style={{ fontWeight: 700 }}>· owner</span>}
              <span style={{ fontWeight: 400, opacity: 0.8 }}>· {l.label}</span>
              {canManageAll && (
                <select value={s.access} disabled={pending}
                  onChange={(e) => startTransition(async () => {
                    const res = await doShare(targetId, s.orgId, e.target.value);
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
          <span className="mut" style={{ fontSize: 12 }}>Not shared with anyone.</span>
        )}
        {(canManageAll || canAddProvider) && options.length > 0 && !adding && (
          <button className="btn link" onClick={() => setAdding(true)}>
            {canManageAll ? "+ Share" : "+ Service provider"}
          </button>
        )}
      </div>

      {adding && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {options.map((o) => (
              <label key={o.id} style={{ display: "flex", alignItems: "center", gap: 5, margin: 0, fontSize: 12, fontWeight: 400, color: "var(--ink)", border: "1px solid var(--line)", borderRadius: 999, padding: "3px 10px", cursor: "pointer", background: picked.includes(o.id) ? "#EEF6EE" : "#fff" }}>
                <input type="checkbox" checked={picked.includes(o.id)} onChange={() => toggle(o.id)}
                  style={{ width: 13, height: 13 }} />
                {o.name}{o.kind === "provider" ? <span className="mut">(provider)</span> : null}
              </label>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
            {canManageAll && (
              <select value={level} onChange={(e) => setLevel(e.target.value)} style={{ width: "auto", fontSize: 12 }}>
                <option value="view">can view</option>
                <option value="edit">can edit</option>
              </select>
            )}
            <button className="btn sm accent" onClick={add} disabled={pending || !picked.length}>
              {pending ? "Sharing..." : picked.length > 1 ? `Share with ${picked.length}` : "Share"}
            </button>
            <button className="btn link" onClick={() => { setAdding(false); setPicked([]); setError(""); }}>cancel</button>
          </div>
        </div>
      )}
      {/* The ONE place ownership is set. It used to be here and in the edit
          form as free text, so a unit could name one company on its row while
          another - or nobody - actually owned it. The label now follows the
          organization; see lib/owner. */}
      {canManageAll && (
        <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="mut" style={{ fontSize: 12 }}>Owner:</span>
          <select value={offPlatform ? "other" : ownerOrgId ?? ""} disabled={pending}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "other") { setOffPlatform(true); return; }
              setOffPlatform(false);
              startTransition(async () => {
                const res = await doSetOwner(targetId, v ? parseInt(v) : null, "");
                if (res?.error) setError(res.error);
              });
            }}
            style={{ width: "auto", fontSize: 12 }}>
            <option value="">Unassigned - platform-stewarded</option>
            {/* Any organization can own equipment, providers included - a
                service company owns its own warehouse stock. */}
            {orgOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.name}{o.kind === "provider" ? " (provider)" : ""}</option>
            ))}
            {/* Units only for now: a system's label is its CLIENT, which is not
                certainly the same fact as its owner, so there is nothing safe to
                write a bare name into yet. */}
            {target === "asset" && <option value="other">Someone not on this platform...</option>}
          </select>
          {/* A record written when this was two fields can carry a company's
              name with no link to it - which is exactly the state that looked
              like ownership and granted nothing. Offered as one click, never
              done automatically: linking grants sight of the record, and a
              permissions change made by comparing two strings is one nobody
              decided. */}
          {!offPlatform && ownerOrgId === null && match !== null && (
            <button className="btn sm" disabled={pending}
              onClick={() => startTransition(async () => {
                const res = await doSetOwner(targetId, match.id, "");
                if (res?.error) setError(res.error);
              })}>
              Link to {match.name}
            </button>
          )}
          {!offPlatform && ownerOrgId === null && match !== null && (
            <span className="mut" style={{ fontSize: 11 }}>
              Recorded as &ldquo;{ownerName}&rdquo; but owned by nobody here - {match.name} cannot see it.
            </span>
          )}
          {offPlatform && (
            <>
              <input value={typed} maxLength={120} disabled={pending} placeholder="Company name"
                onChange={(e) => setTyped(e.target.value)}
                style={{ width: "auto", flex: "1 1 160px", fontSize: 12 }} />
              <button className="btn sm accent" disabled={pending}
                onClick={() => startTransition(async () => {
                  const res = await doSetOwner(targetId, null, typed);
                  if (res?.error) setError(res.error);
                })}>Save</button>
              <span className="mut" style={{ fontSize: 11 }}>
                A name only - nobody gains access from this.
              </span>
            </>
          )}
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
    </>
  );
}
