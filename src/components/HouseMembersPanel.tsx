"use client";

import { useState, useTransition } from "react";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { revokeHouseMember, setHouseMember } from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import AddressField from "@/components/AddressField";
import { toast } from "@/components/ui/Toast";

export type HouseRow = {
  email: string; role: string; name: string; fromEnv: boolean; isRoot: boolean; locked: boolean;
};

const ROLE = {
  owner: { label: "Owner", tone: "accent" },
  staff: { label: "Staff", tone: "info" },
  none: { label: "Revoked", tone: "faint" },
} as const;

/**
 * The operator's own people. Owners see everything staff see plus Settings,
 * organizations, stages, branding, hard deletes and signature revocation - so
 * this is the superuser list, and it's why every rule here is also enforced
 * server-side rather than just greyed out.
 */
export default function HouseMembersPanel({ members, myEmail, sites = [] }: {
  members: HouseRow[];
  myEmail: string;
  /** Client labs, offered as a home base for an engineer stationed on-site. */
  sites?: { label: string; address: string }[];
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ email: "", first: "", last: "", role: "staff", homeAddress: "" });
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
        <span className="mut t-small">
          {owners} owner{owners === 1 ? "" : "s"} · {members.filter((m) => m.role === "staff").length} staff
        </span>
        <button className="btn sm primary" style={{ marginLeft: "auto" }} onClick={() => { setAdding(!adding); setError(""); }}>
          {adding ? "Cancel" : "+ Add someone"}
        </button>
      </div>
      <div className="mut t-small" style={{ marginBottom: 10 }}>
        Staff see and work every system in the shop. Owners additionally get Settings,
        organizations, stages, branding, hard deletes and signature revocation. Changes
        take effect on their next page load - no redeploy, no signing out.
      </div>

      {adding && (() => {
        const fullName = [draft.first.trim(), draft.last.trim()].filter(Boolean).join(" ");
        const save = (invite: boolean) => run(
          async () => {
            const res = await setHouseMember(draft.email, draft.role, fullName,
              { homeAddress: draft.homeAddress, invite });
            if (!res?.error) {
              toast({
                message: invite
                  ? res.invited
                    ? `Added ${fullName || draft.email.trim()} and sent their invitation`
                    : `Added ${fullName || draft.email.trim()} - the invitation email did not go out; they can still sign in`
                  : `Added ${fullName || draft.email.trim()}`,
              });
            }
            return res;
          },
          () => { setAdding(false); setDraft({ email: "", first: "", last: "", role: "staff", homeAddress: "" }); },
        );
        return (
        <Dialog open onClose={() => setAdding(false)} title="Add a person" size="md"
          context="Fill in their profile now; they sign in by email code - no password to share."
          footer={
            <>
              <DialogStatus error={error} problem={!draft.email.trim() ? "their email address" : null} />
              <button className="btn" onClick={() => setAdding(false)} disabled={pending}>Cancel</button>
              <button className="btn" disabled={pending || !draft.email.trim()} onClick={() => save(false)}>
                Add quietly
              </button>
              <button className="btn accent" disabled={pending || !draft.email.trim()} onClick={() => save(true)}>
                {pending ? "Saving..." : "Add & send invite"}
              </button>
            </>
          }>
          <div className="dialog-section">Who they are</div>
          <div className="pf3" style={{ marginBottom: 8 }}>
            <div>
              <label>First name</label>
              <input value={draft.first} onChange={(e) => setDraft({ ...draft, first: e.target.value })} placeholder="Bill" autoFocus />
            </div>
            <div>
              <label>Last name</label>
              <input value={draft.last} onChange={(e) => setDraft({ ...draft, last: e.target.value })} placeholder="Harner" />
            </div>
            <div>
              <label>Email *</label>
              <input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                placeholder="wjharner@example.com" inputMode="email" />
            </div>
          </div>
          <div className="dialog-section">What they may do</div>
          <div style={{ marginBottom: 8 }}>
            <label>Privileges</label>
            <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} style={{ width: "auto" }}>
              <option value="staff">Staff - every system, every job</option>
              <option value="owner">Owner - staff plus settings, money and deletions</option>
            </select>
          </div>
          <div className="dialog-section">Where their trips start</div>
          <label>Home base</label>
          {/* The point zero for the stipend radius and routed mileage. An
              address of their own, or a client lab for somebody stationed
              on-site - and theirs to change later on their own settings. */}
          <AddressField value={draft.homeAddress} ariaLabel="Home base address"
            onChange={(homeAddress) => setDraft({ ...draft, homeAddress })}
            placeholder="Street address - autocompletes when maps are configured" />
          {sites.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <select value="" aria-label="Use a client site"
                onChange={(e) => { if (e.target.value) setDraft({ ...draft, homeAddress: e.target.value }); }}
                className="t-small" style={{ width: "auto" }}>
                <option value="">...or use a client lab&apos;s address</option>
                {sites.filter((x) => x.address.trim()).map((x) => (
                  <option key={x.label} value={x.address}>{x.label}</option>
                ))}
              </select>
            </div>
          )}
        </Dialog>
        );
      })()}

      {members.map((m) => (
        <div key={m.email} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "7px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
          <span className="t-body" style={{ fontWeight: m.role === "owner" ? 700 : 400 }}>
            {m.name || m.email.split("@")[0]}
          </span>
          <span className="mono mut t-small">{m.email}</span>
          {/* Quiet markers, not more pills: the row's one pill is its role. */}
          {(m.email === myEmail.toLowerCase() || m.isRoot || m.fromEnv) && (
            <span className="mut t-meta"
              title={m.isRoot ? "First entry in STAFF_EMAILS" : m.fromEnv ? "Listed in STAFF_EMAILS" : undefined}>
              {[m.email === myEmail.toLowerCase() ? "you" : "",
                m.isRoot ? "root" : m.fromEnv ? "from env" : ""].filter(Boolean).join(" · ")}
            </span>
          )}

          {m.locked ? (
            <span className={`pill ${ROLE[m.role as keyof typeof ROLE]?.tone ?? "neutral"}`}>
              {ROLE[m.role as keyof typeof ROLE]?.label ?? m.role}
            </span>
          ) : (
            <select value={m.role} disabled={pending}
              onChange={(e) => {
                const role = e.target.value;
                run(() => setHouseMember(m.email, role, m.name),
                  () => toast({ message: `Made ${m.name || m.email} ${role}` }));
              }}
              className="t-meta"
              style={{
                width: "auto", fontWeight: 700, padding: "3px 6px", borderRadius: 999, cursor: "pointer",
                background: `var(--t-${ROLE[m.role as keyof typeof ROLE]?.tone ?? "neutral"}-bg)`,
                color: `var(--t-${ROLE[m.role as keyof typeof ROLE]?.tone ?? "neutral"}-fg)`,
              }}>
              <option value="staff">Staff</option>
              <option value="owner">Owner</option>
            </select>
          )}

          <span style={{ marginLeft: "auto" }}>
            {m.locked ? (
              <span className="mut t-meta">
                {m.isRoot ? "set by STAFF_EMAILS"
                  : m.email === myEmail.toLowerCase() ? "ask another owner"
                  : "last owner"}
              </span>
            ) : (
              <button className="btn link" style={{ color: "var(--t-bad-fg)" }} disabled={pending}
                onClick={async () => {
                  const why = await confirmReason({
                    title: `Revoke ${m.email}'s access to the whole shop?`,
                    body: m.fromEnv ? "They're also in STAFF_EMAILS, so this records an override." : undefined,
                    action: "Revoke access", tone: "bad",
                  });
                  if (!why) return;
                  run(() => revokeHouseMember(m.email, why),
                    () => toast({ message: `Revoked ${m.email}` }));
                }}>revoke</button>
            )}
          </span>
        </div>
      ))}

      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}

      <div className="mut t-meta" style={{ marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
        The <b>root</b> owner comes from the first <span className="mono">STAFF_EMAILS</span> entry and can&apos;t be
        changed here - it&apos;s the way back in if this list is ever left without a working owner. Move it by
        editing the environment variable and redeploying.
      </div>
    </div>
  );
}
