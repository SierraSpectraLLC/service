"use client";

import { useState, useTransition } from "react";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { inputDialog } from "@/components/ui/ConfirmDialog";
import {
  armDeviceLease, offlineLeaseCode, releaseDeviceLease, resumeDeviceLease, suspendDeviceLease,
} from "@/app/actions";

/** The open lease on a machine, or null when none is armed. */
export type OpenLease = {
  armed: boolean;
  force: "notify" | "lock";
  leaseDays: number;
  graceDays: number;
  state: "released" | "disarmed" | "current" | "grace" | "lapsed";
  expires: string;
  lastRenewed: string;
  suspended: boolean;
  suspendReason: string;
};

const STATE_PILL: Record<OpenLease["state"], { tone: string; label: string } | null> = {
  current: { tone: "info", label: "lease · current" },
  grace: { tone: "warn", label: "lease · in grace" },
  lapsed: { tone: "bad", label: "lease · lapsed" },
  disarmed: null,
  released: null,
};

/**
 * Arming a shipped system's lease, and letting it go at sign-off.
 *
 * Owner only, and kept apart from the lockout beside it: a lockout answers
 * theft, this answers the window before final payment on a system whose title
 * we still hold. See lib/leaseGuard for why renewal - not the invoice table -
 * is what suspending stops, and why the default arms warning-only.
 *
 * The lever is "suspend renewal": a recorded reason, never an amount. Release is
 * terminal and belongs at sign-off, when title passes and the guard stands down.
 */
export default function DeviceLeaseControls({
  deviceId, label, lease, canManageLease,
}: {
  deviceId: number;
  label: string;
  lease: OpenLease | null;
  canManageLease: boolean;
}) {
  const [sheet, setSheet] = useState(false);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState({ force: "notify" as OpenLease["force"], leaseDays: 7, graceDays: 3 });

  const armed = lease?.armed ?? false;
  if (!canManageLease && !armed) return null;

  const pill = lease && armed ? (lease.suspended ? { tone: "warn", label: "lease · renewal suspended" } : STATE_PILL[lease.state]) : null;

  const arm = () => {
    setError("");
    startTransition(async () => {
      const res = await armDeviceLease(deviceId, draft);
      if (res?.error) { setError(res.error); return; }
      toast({ message: `Armed a lease on ${label}` });
      setSheet(false);
    });
  };

  const suspend = async () => {
    const said = await inputDialog({
      title: `Suspend lease renewal on "${label}"?`,
      body: "The machine stops getting fresh leases and lapses on its own schedule. This is a recorded decision - not tied to what they owe.",
      label: "Why", placeholder: "Terms not met on the March delivery; hold pending contract review.",
      hint: "Kept on the record with your name.",
      action: "Suspend renewal", tone: "bad",
    });
    if (!said) return;
    setError("");
    startTransition(async () => {
      const res = await suspendDeviceLease(deviceId, said);
      setError(res?.error ?? "");
      if (!res?.error) toast({ message: `Suspended renewal on ${label}` });
    });
  };

  const resume = () => {
    setError("");
    startTransition(async () => {
      const res = await resumeDeviceLease(deviceId);
      setError(res?.error ?? "");
      if (!res?.error) toast({ message: `Resumed renewal on ${label}` });
    });
  };

  const release = async () => {
    const said = await inputDialog({
      title: `Release the lease on "${label}" for good?`,
      body: "The sign-off act. Terminal: the guard stands down and uninstalls, and there is no re-arming afterward. Do this once payment is in and title has passed.",
      label: "Confirms", placeholder: "Paid in full on invoice 2214; signed off to Lab Zen.",
      hint: "Name the payment and sign-off this releases against.",
      action: "Release for good", tone: "primary",
    });
    if (!said) return;
    setError("");
    startTransition(async () => {
      const res = await releaseDeviceLease(deviceId, said);
      setError(res?.error ?? "");
      if (!res?.error) toast({ message: `Released the lease on ${label}` });
    });
  };

  // The offline path: the engineer on site reads the guard's counter aloud, we
  // compute the code to read back. No network in the loop.
  const offline = async () => {
    const counter = await inputDialog({
      title: `Offline extension code for "${label}"`,
      body: "Read the counter the guard is showing on the machine, and type it here. The code this returns is read back to the engineer once.",
      label: "Guard counter", placeholder: "e.g. 14",
      hint: "The number the locked machine displays.",
      action: "Get the code", tone: "primary",
    });
    if (counter === null) return;
    const n = parseInt(counter.trim(), 10);
    if (!Number.isInteger(n) || n < 0) { setError("That is not a counter."); return; }
    setError(""); setCode("");
    startTransition(async () => {
      const res = await offlineLeaseCode(deviceId, n);
      if (res.error) { setError(res.error); return; }
      setCode(res.code ?? "");
    });
  };

  return (
    <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 6 }}>
      {pill && (
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <span className={`pill ${pill.tone}`}>{pill.label}</span>
          {lease?.suspended && lease.suspendReason && <span className="mut t-small">{lease.suspendReason}</span>}
          <span className="mut t-meta">
            {lease?.force === "lock" ? "locks on lapse" : "warns only"}
            {lease?.expires ? ` · expires ${lease.expires}` : ""}
            {lease?.lastRenewed ? ` · renewed ${lease.lastRenewed}` : " · never renewed"}
          </span>
        </div>
      )}

      {code && (
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <span className="mut t-meta">Read back:</span>
          <span className="t-mono-id" style={{ letterSpacing: "0.08em", color: "var(--navy)" }}>{code}</span>
          <button className="btn link" onClick={() => setCode("")}>done</button>
        </div>
      )}

      {canManageLease && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {!armed && (
            <button className="btn link" disabled={pending}
              onClick={() => { setError(""); setSheet(true); }}>arm a lease</button>
          )}
          {armed && !lease?.suspended && (
            <button className="btn link" disabled={pending} onClick={suspend}>suspend renewal</button>
          )}
          {armed && lease?.suspended && (
            <button className="btn link" disabled={pending} onClick={resume}>resume renewal</button>
          )}
          {armed && (
            <>
              <button className="btn link" disabled={pending} onClick={offline}>offline code</button>
              <button className="btn link" disabled={pending} onClick={release}>release for good</button>
            </>
          )}
        </div>
      )}

      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)" }}>{error}</div>}

      {sheet && (
        <Dialog open onClose={() => setSheet(false)} title="Arm a lease" context={label}
          footer={
            <>
              <DialogStatus error={error} problem={null}
                ok={draft.force === "lock" ? "Locks the session once lapsed and past grace." : "Warns only - never locks."} />
              <button className="btn" onClick={() => setSheet(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={arm} disabled={pending}>
                {pending ? "Arming..." : "Arm the lease"}
              </button>
            </>
          }>
          <div className="dialog-section">What a lapse does</div>
          <label>Force</label>
          <select value={draft.force} style={{ marginBottom: 4 }}
            onChange={(e) => setDraft({ ...draft, force: e.target.value as OpenLease["force"] })}>
            <option value="notify">notify - warn on the screen, never lock</option>
            <option value="lock">lock - end the session once lapsed and past grace</option>
          </select>
          <div className="mut t-meta" style={{ marginBottom: 8 }}>
            Warning-only is the safe way to start: run it in the field a while to prove the guard is
            sound before you trust it to lock. It only ever bites a system we still own and have not
            been paid for - at sign-off the lease is released, not left armed.
          </div>

          <div className="dialog-section">Timing</div>
          <label>Lease length (days)</label>
          <input type="number" min={1} max={365} value={draft.leaseDays} style={{ marginBottom: 8 }}
            onChange={(e) => setDraft({ ...draft, leaseDays: parseInt(e.target.value || "7", 10) })} />

          <label>Grace (days)</label>
          <input type="number" min={0} max={90} value={draft.graceDays} style={{ marginBottom: 4 }}
            onChange={(e) => setDraft({ ...draft, graceDays: parseInt(e.target.value || "0", 10) })} />
          <div className="mut t-meta" style={{ marginBottom: 8 }}>
            The guard renews itself whenever it is online, so it takes a full lease length offline to
            lapse - then grace is warning-only time before a lock lease locks. Longer is more
            forgiving of our own outages, which are the likeliest thing to lapse a lease.
          </div>
        </Dialog>
      )}
    </div>
  );
}
