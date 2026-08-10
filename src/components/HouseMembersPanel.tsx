"use client";

import { useState, useTransition } from "react";
import { promptReason } from "@/lib/reason";
import { revokeHouseMember, setHouseMember } from "@/app/actions";

export type HouseRow = {
  email: string; role: string; name: string; fromEnv: boolean; isRoot: boolean; locked: boolean;
};

const ROLE = {
  owner: { label: "Owner", bg: "#EDEBFA", fg: "#4F45A3" },
  staff: { label: "Staff", bg: "#E7EFF8", fg: "#1D6396" },
  none: { label: "Revoked", bg: "#F4F6F9", fg: "#94A3B8" },
} as const;

/**
 * The operator's own people. Owners see everything staff see plus Settings,
 * organizations, stages, branding, hard deletes and signature revocation - so
 * this is the superuser list, and it's why every rule here is also enforced
 * server-side rather than just greyed out.
 */
export default function HouseMembersPanel({ members, myEmail }: {
  members: HouseRow[];
  myEmail: string;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ email: "", name: "", role: "staff" });
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<{ error?: string }>, after?: () => void) =>
    startTransition(async () => {
      const res = await fn();
      if (res?.error) setError(res.error);
      else { setError(""); after?.(); }
    });

  const owners = members.filter((m) => m.role === "owner").length;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <div className="card-title">Our people</div>
        <span className="mut" style={{ fontSize: 12 }}>
          {owners} owner{owners === 1 ? "" : "s"} · {members.filter((m) => m.role === "staff").length} staff
        </span>
        <button className="btn sm primary" style={{ marginLeft: "auto" }} onClick={() => { setAdding(!adding); setError(""); }}>
          {adding ? "Cancel" : "+ Add someone"}
        </button>
      </div>
      <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
        Staff see and work every system in the shop. Owners additionally get Settings,
        organizations, stages, branding, hard deletes and signature revocation. Changes
        take effect on their next page load - no redeploy, no signing out.
      </div>

      {adding && (
        <div className="dash-form" style={{ marginBottom: 12 }}>
          <div className="pf3" style={{ marginBottom: 8 }}>
            <div>
              <label>Email *</label>
              <input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                placeholder="wjharner@example.com" inputMode="email" />
            </div>
            <div>
              <label>Name</label>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Bill Harner" />
            </div>
            <div>
              <label>Role</label>
              <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
                <option value="staff">Staff</option>
                <option value="owner">Owner</option>
              </select>
            </div>
          </div>
          <div className="mut" style={{ fontSize: 11, marginBottom: 10 }}>
            Exact address only - no @domain wildcards. They sign in with a magic link to
            that address; no password to share.
          </div>
          <button className="btn sm accent" disabled={pending || !draft.email.trim()}
            onClick={() => run(
              () => setHouseMember(draft.email, draft.role, draft.name),
              () => { setAdding(false); setDraft({ email: "", name: "", role: "staff" }); },
            )}>{pending ? "Saving..." : "Add"}</button>
        </div>
      )}

      {members.map((m) => (
        <div key={m.email} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "7px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: m.role === "owner" ? 700 : 400 }}>
            {m.name || m.email.split("@")[0]}
          </span>
          <span className="mono mut" style={{ fontSize: 12 }}>{m.email}</span>
          {m.email === myEmail.toLowerCase() && (
            <span className="pill" style={{ background: "#E8F3EC", color: "#2E6B2E" }}>you</span>
          )}
          {m.isRoot && (
            <span className="pill" style={{ background: "#FAF0DC", color: "#8A5410" }} title="First entry in STAFF_EMAILS">
              root
            </span>
          )}
          {m.fromEnv && !m.isRoot && (
            <span className="pill" style={{ background: "#EEF1F5", color: "#475569" }} title="Listed in STAFF_EMAILS">
              from env
            </span>
          )}

          {m.locked ? (
            <span className="pill" style={{ background: ROLE[m.role as keyof typeof ROLE]?.bg, color: ROLE[m.role as keyof typeof ROLE]?.fg, fontWeight: 700 }}>
              {ROLE[m.role as keyof typeof ROLE]?.label ?? m.role}
            </span>
          ) : (
            <select value={m.role} disabled={pending}
              onChange={(e) => run(() => setHouseMember(m.email, e.target.value, m.name))}
              style={{
                width: "auto", fontSize: 11, fontWeight: 700, padding: "3px 6px", borderRadius: 999, cursor: "pointer",
                background: ROLE[m.role as keyof typeof ROLE]?.bg, color: ROLE[m.role as keyof typeof ROLE]?.fg,
              }}>
              <option value="staff">Staff</option>
              <option value="owner">Owner</option>
            </select>
          )}

          <span style={{ marginLeft: "auto" }}>
            {m.locked ? (
              <span className="mut" style={{ fontSize: 11 }}>
                {m.isRoot ? "set by STAFF_EMAILS"
                  : m.email === myEmail.toLowerCase() ? "ask another owner"
                  : "last owner"}
              </span>
            ) : (
              <button className="btn link" style={{ color: "#A32D2D", fontSize: 11 }} disabled={pending}
                onClick={() => {
                  const why = promptReason(
                    `Revoke ${m.email}'s access to the whole shop?${m.fromEnv ? " They're also in STAFF_EMAILS, so this records an override." : ""}`,
                  );
                  if (!why) return;
                  run(() => revokeHouseMember(m.email, why));
                }}>revoke</button>
            )}
          </span>
        </div>
      ))}

      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}

      <div className="mut" style={{ fontSize: 11, marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
        The <b>root</b> owner comes from the first <span className="mono">STAFF_EMAILS</span> entry and can&apos;t be
        changed here - it&apos;s the way back in if this list is ever left without a working owner. Move it by
        editing the environment variable and redeploying.
      </div>
    </div>
  );
}
