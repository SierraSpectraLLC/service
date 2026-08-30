"use client";

import { useState, useTransition } from "react";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { inputDialog } from "@/components/ui/ConfirmDialog";
import { LOCKOUT_REACH } from "@/lib/deviceLockout";
import { lockDevice, releaseDevice } from "@/app/actions";

/** The open lockout on a machine, or null when it is not locked out. */
export type OpenLockout = {
  reference: string;
  reason: string;
  contact: string;
  force: "notify" | "logoff" | "shutdown";
  decidedBy: string;
  raised: string;
  lastEnforced: string;
  enforceError: string;
};

const FORCE = [
  { value: "notify", label: "notify - put it on the screen, change nothing" },
  { value: "logoff", label: "logoff - end the session every time it appears" },
  { value: "shutdown", label: "shutdown - end the session and power it off" },
] as const;

/**
 * Reporting a machine stolen, and taking it back.
 *
 * Owner only, and kept visually apart from notices and holds because it is not
 * one: those two are things a machine says, this is something done to it. See
 * lib/deviceLockout for why it takes a crime reference rather than an amount,
 * and why nothing in this path may ever read an invoice.
 *
 * The dialog prints LOCKOUT_REACH rather than a reassuring sentence of its own.
 * Somebody deciding whether this is enough - or whether to also call the police
 * and their insurer - needs the limits in front of them, and the limits belong
 * to the mechanism, so the mechanism states them.
 */
export default function DeviceLockoutControls({
  deviceId, label, lockout, canLock,
}: {
  deviceId: number;
  label: string;
  lockout: OpenLockout | null;
  canLock: boolean;
}) {
  const [sheet, setSheet] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState({
    reference: "", reason: "", contact: "", force: "logoff" as OpenLockout["force"],
  });

  if (!canLock && !lockout) return null;

  const problem = !draft.reference.trim() ? "give the report or claim reference"
    : !draft.contact.trim() ? "give a number for whoever finds it"
    : null;

  const lock = () => {
    setError("");
    startTransition(async () => {
      const res = await lockDevice(deviceId, draft);
      if (res?.error) { setError(res.error); return; }
      toast({ message: `Locked out ${label}` });
      setDraft({ reference: "", reason: "", contact: "", force: "logoff" });
      setSheet(false);
    });
  };

  const release = async () => {
    const said = await inputDialog({
      title: `Release the lockout on "${label}"?`,
      context: lockout ? `Reference ${lockout.reference}` : undefined,
      body: "The machine stops being logged off. If it was powered down, somebody still has to switch it on.",
      label: "Why", placeholder: "Recovered by Reno PD and returned to the lab.",
      hint: "Recovered, returned, or reported in error - the row should say which.",
      action: "Release", tone: "primary",
    });
    if (!said) return;
    setError("");
    startTransition(async () => {
      const res = await releaseDevice(deviceId, said);
      setError(res?.error ?? "");
      if (!res?.error) toast({ message: `Released ${label}` });
    });
  };

  return (
    <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 6 }}>
      {lockout && (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <span className="pill bad">reported stolen · {lockout.force}</span>
            <span className="t-small">{lockout.reference}</span>
            {lockout.reason && <span className="mut t-small">{lockout.reason}</span>}
            <span className="mut t-meta">{lockout.decidedBy}, {lockout.raised}</span>
            <button className="btn link" disabled={pending} onClick={release}>release</button>
          </div>
          {/* Whether it has actually reached the machine, which is what somebody
              decides their next move on. */}
          {lockout.enforceError ? (
            <div className="t-meta" style={{ color: "var(--t-bad-fg)" }}>
              Not applied - {lockout.enforceError}
            </div>
          ) : lockout.lastEnforced ? (
            <div className="mut t-meta">Last applied {lockout.lastEnforced}.</div>
          ) : (
            <div className="mut t-meta">Not reached yet - the machine has not been online since.</div>
          )}
        </>
      )}

      {canLock && !lockout && (
        <div>
          <button className="btn link" style={{ color: "var(--t-bad-fg)" }} disabled={pending}
            onClick={() => { setError(""); setSheet(true); }}>report stolen and lock out</button>
        </div>
      )}

      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)" }}>{error}</div>}

      {sheet && (
        <Dialog open onClose={() => setSheet(false)} title="Report stolen and lock out" context={label}
          footer={
            <>
              <DialogStatus error={error} problem={problem}
                ok="Applied now if the machine is online, and again every hour it appears." />
              <button className="btn" onClick={() => setSheet(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={lock} disabled={pending || !!problem}>
                {pending ? "Locking..." : "Lock it out"}
              </button>
            </>
          }>
          <div className="dialog-section">What was filed</div>
          <label>Report or claim reference</label>
          <input value={draft.reference} autoFocus placeholder="Reno PD 26-114882"
            onChange={(e) => setDraft({ ...draft, reference: e.target.value })}
            style={{ marginBottom: 4 }} />
          <div className="mut t-meta" style={{ marginBottom: 8 }}>
            A police report, an insurance claim, an RMA - something that exists outside this
            software. Required, and deliberately so: an unpaid invoice is not grounds to lock
            a customer&apos;s instrument, and this is the field that keeps the two apart.
          </div>

          <label>What happened</label>
          <textarea value={draft.reason} rows={2}
            placeholder="Taken from the loading dock overnight between the 27th and 28th."
            onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
            style={{ marginBottom: 8 }} />

          <label>Number for whoever finds it</label>
          <input value={draft.contact} placeholder="Sierra Spectra 555-0100"
            onChange={(e) => setDraft({ ...draft, contact: e.target.value })}
            style={{ marginBottom: 4 }} />
          <div className="mut t-meta" style={{ marginBottom: 8 }}>
            Goes on the screen. The person reading it may be an honest buyer or a shipper, and
            a number is what gets the instrument home.
          </div>

          <div className="dialog-section">What it does</div>
          <label>Force</label>
          <select value={draft.force} style={{ marginBottom: 4 }}
            onChange={(e) => setDraft({ ...draft, force: e.target.value as OpenLockout["force"] })}>
            {FORCE.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          {draft.force !== "notify" && (
            <div className="mut t-meta" style={{ marginBottom: 8 }}>
              Ending the session closes whatever was running on it. On a machine that turns out
              not to be stolen, that means an interrupted acquisition.
            </div>
          )}

          <div className="dialog-section">How far this reaches</div>
          <div className="mut t-small">{LOCKOUT_REACH}</div>
        </Dialog>
      )}
    </div>
  );
}
