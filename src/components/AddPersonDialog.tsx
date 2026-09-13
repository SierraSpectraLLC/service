"use client";

import { useState, useTransition } from "react";
import { setHouseMember } from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import AddressField from "@/components/AddressField";
import { toast } from "@/components/ui/Toast";
import { TEMP_DAYS_DEFAULT, TEMP_DAYS_MAX } from "@/lib/tempPassword";

/** A client lab, offered as a home base for an engineer stationed on-site. */
export type SiteOption = { label: string; address: string };

const BLANK = {
  email: "", first: "", last: "", role: "staff", homeAddress: "",
  withPassword: false, days: TEMP_DAYS_DEFAULT,
};

/**
 * Putting somebody on staff: who they are, what they may do, how they get in,
 * where their trips start.
 *
 * One dialog for the two rooms that add people - Settings › People & ownership
 * and Employees - so a hire made from either lands the same row with the same
 * fields, and a change to the form is a change to both. The add itself is
 * setHouseMember, owner-only and stamped with the adder's workspace; nothing
 * here decides who may hire.
 *
 * When a temporary password is minted the dialog stays open to show it, because
 * it is shown exactly once and is in no email: this is where somebody reads it
 * down a phone.
 */
export default function AddPersonDialog({ sites = [], onClose, onAdded }: {
  sites?: SiteOption[];
  onClose: () => void;
  /** The row exists. Fires before the password view, if there is one. */
  onAdded?: () => void;
}) {
  const [draft, setDraft] = useState(BLANK);
  const [error, setError] = useState("");
  const [minted, setMinted] = useState<null | { who: string; password: string; expiresOn: string }>(null);
  const [pending, startTransition] = useTransition();

  const fullName = [draft.first.trim(), draft.last.trim()].filter(Boolean).join(" ");
  const who = fullName || draft.email.trim();

  const save = (invite: boolean) => startTransition(async () => {
    setError("");
    const res = await setHouseMember(draft.email, draft.role, fullName,
      { homeAddress: draft.homeAddress, invite, withPassword: draft.withPassword, tempDays: draft.days });
    if (res?.error) { setError(res.error); return; }
    toast({
      message: invite
        ? res.invited
          ? `Added ${who} and sent their invitation`
          : `Added ${who} - the invitation email did not go out; they can still sign in`
        : `Added ${who}`,
    });
    onAdded?.();
    if (res.password && res.expiresOn) setMinted({ who, password: res.password, expiresOn: res.expiresOn });
    else onClose();
  });

  if (minted) {
    return (
      <Dialog open onClose={onClose} title={`Temporary password for ${minted.who}`} size="sm"
        context="Read it to them - it is not in any email, and this is the only time it is shown."
        footer={
          <>
            <button className="btn" onClick={() => {
              navigator.clipboard?.writeText(minted.password)
                .then(() => toast({ message: "Copied" }))
                .catch(() => toast({ message: "Select it and copy by hand", tone: "bad" }));
            }}>Copy</button>
            <button className="btn accent" onClick={onClose}>Done</button>
          </>
        }>
        <div className="mono t-page" style={{ letterSpacing: "0.02em", userSelect: "all", padding: 12, borderRadius: 8, background: "var(--t-warn-bg)", border: "1px solid var(--t-warn-bd)" }}>
          {minted.password}
        </div>
        <div className="mut t-meta" style={{ marginTop: 8 }}>
          Works until {minted.expiresOn}, then sign-in goes back to emailed codes.
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title="Add a person" size="md"
      context="Fill in their profile now. They sign in by email code, or with a temporary password when mail is not arriving."
      footer={
        <>
          <DialogStatus error={error} problem={!draft.email.trim() ? "their email address" : null} />
          <button className="btn" onClick={onClose} disabled={pending}>Cancel</button>
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
            placeholder="sjones@example.com" inputMode="email" />
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
      <div className="dialog-section">How they get in</div>
      <label className="t-body" style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 4px", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
        <input type="checkbox" checked={draft.withPassword} style={{ width: 15, height: 15 }}
          onChange={(e) => setDraft({ ...draft, withPassword: e.target.checked })} />
        Also set a temporary password
      </label>
      <div className="mut t-meta" style={{ marginBottom: draft.withPassword ? 8 : 0 }}>
        Sign-in is by emailed code. Tick this when mail is not getting through: we generate a
        password, show it to you once to read out, and it stops working on its own.
      </div>
      {draft.withPassword && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <label style={{ margin: 0 }}>Good for</label>
          <input type="number" min={1} max={TEMP_DAYS_MAX} value={draft.days} aria-label="Days the password lasts"
            onChange={(e) => setDraft({ ...draft, days: parseInt(e.target.value) || TEMP_DAYS_DEFAULT })}
            style={{ width: 80 }} />
          <span className="mut t-meta">days, then codes only</span>
        </div>
      )}

      <div className="dialog-section">Where their trips start</div>
      <label>Home base</label>
      {/* The point zero for the stipend radius and routed mileage. An
          address of their own, or a client lab for somebody stationed
          on-site - and theirs to change later on their own settings. */}
      <AddressField value={draft.homeAddress} ariaLabel="Home base address"
        onChange={(homeAddress) => setDraft({ ...draft, homeAddress })}
        placeholder="Street address - autocompletes when maps are configured" />
      {sites.length > 0 && (
        <div style={{ marginTop: 8 }}>
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
}
