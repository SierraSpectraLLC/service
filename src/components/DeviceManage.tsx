"use client";

import { useRef, useState, useTransition } from "react";
import Dropdown from "@/components/Dropdown";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { confirmDialog, inputDialog } from "@/components/ui/ConfirmDialog";
import { noticesFor, permitted } from "@/lib/fleetNotice";
import { LOCKOUT_REACH } from "@/lib/deviceLockout";
import {
  armDeviceLease, clearDeviceNotice, clearSafetyHold, lockDevice, offlineLeaseCode,
  postDeviceNotice, raiseSafetyHold, releaseDevice, releaseDeviceLease, resumeDeviceLease,
  suspendDeviceLease,
} from "@/app/actions";

/**
 * Everything one machine can be told or have done to it, behind one menu.
 *
 * Four separate things live here - a repossession NOTICE, a safety HOLD, a
 * theft LOCKOUT, and a lease GUARD - and they are kept apart in the code for
 * reasons the libs explain at length (money never reaches the safety or lease
 * decision; a lockout needs a crime reference, not a balance). What they share
 * is a row on a list, and a row cannot carry eleven inline buttons and stay
 * readable.
 *
 * So this splits the two things a row was conflating. STATUS - what a machine
 * currently carries - stays in view, because a stolen or held or leased machine
 * should read at a glance. ACTIONS - posting, clearing, arming, releasing - go
 * under a single "Manage" menu, which shows only what applies to this machine's
 * state and this viewer's rights. The dialogs and their copy are unchanged from
 * when each feature was its own control; only where you reach them moved.
 */

export type OpenNotice = { body: string; approvedBy: string; rung: "notice" | "prominent" | "at_login"; posted: string };
export type OpenHold = {
  reason: string; decidedBy: string; effect: "advise" | "hold" | "lock";
  contact: string; faultSource: string; dispatchedTo: string; raised: string;
};
export type OpenLockout = {
  reference: string; reason: string; contact: string; force: "notify" | "logoff" | "shutdown";
  decidedBy: string; raised: string; lastEnforced: string; enforceError: string;
};
export type OpenLease = {
  armed: boolean; force: "notify" | "lock"; leaseDays: number; graceDays: number;
  state: "released" | "disarmed" | "current" | "grace" | "lapsed";
  expires: string; lastRenewed: string; suspended: boolean; suspendReason: string;
};

const RUNGS = [
  { value: "notice", label: "notice - shown with everything else" },
  { value: "prominent", label: "prominent - shown above everything else" },
  { value: "at_login", label: "at login - shown when somebody signs in" },
] as const;
const EFFECTS = [
  { value: "advise", label: "advise - say it, change nothing" },
  { value: "hold", label: "hold - say it louder: do not start new runs" },
  { value: "lock", label: "lock - strongest rung; advisory on this engine" },
] as const;
const FORCE = [
  { value: "notify", label: "notify - put it on the screen, change nothing" },
  { value: "logoff", label: "logoff - end the session every time it appears" },
  { value: "shutdown", label: "shutdown - end the session and power it off" },
] as const;

const LEASE_PILL: Record<OpenLease["state"], { tone: string; label: string } | null> = {
  current: { tone: "info", label: "lease · current" },
  grace: { tone: "warn", label: "lease · in grace" },
  lapsed: { tone: "bad", label: "lease · lapsed" },
  disarmed: null,
  released: null,
};

export default function DeviceManage(props: {
  deviceId: number;
  label: string;
  consentMode: "unattended" | "consent";
  consentWhy: string;
  notice: OpenNotice | null;
  hold: OpenHold | null;
  canPostNotice: boolean;
  canRaiseHold: boolean;
  noticePushed: string;
  noticeError: string;
  lockout: OpenLockout | null;
  canLock: boolean;
  lease: OpenLease | null;
  canManageLease: boolean;
}) {
  const {
    deviceId, label, consentMode, consentWhy, notice, hold, canPostNotice, canRaiseHold,
    noticePushed, noticeError, lockout, canLock, lease, canManageLease,
  } = props;

  const [sheet, setSheet] = useState<null | "notice" | "hold" | "lockout" | "lease">(null);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [pending, startTransition] = useTransition();
  const menuRef = useRef<HTMLSpanElement>(null);

  const [noticeDraft, setNoticeDraft] = useState({ body: "", rung: "notice" as OpenNotice["rung"] });
  const [holdDraft, setHoldDraft] = useState({
    reason: "", effect: "advise" as OpenHold["effect"], faultSource: "", contact: "", dispatchedTo: "",
  });
  const [lockDraft, setLockDraft] = useState({
    reference: "", reason: "", contact: "", force: "logoff" as OpenLockout["force"],
  });
  const [leaseDraft, setLeaseDraft] = useState({ force: "notify" as OpenLease["force"], leaseDays: 7, graceDays: 3 });

  const leaseArmed = lease?.armed ?? false;
  const hasStatus = !!(hold || notice || lockout || (lease && leaseArmed));
  const hasActions = canPostNotice || canRaiseHold || canLock || canManageLease || !!hold || !!notice || !!lockout || leaseArmed;
  if (!hasStatus && !hasActions) return null;

  // Close the menu before an action opens a dialog, so the open <details> is
  // never left sitting behind a modal.
  const run = (fn: () => void) => {
    menuRef.current?.querySelector("details")?.removeAttribute("open");
    fn();
  };

  const preview = (kind: "notice" | "hold") => permitted(
    noticesFor(
      kind === "notice" && noticeDraft.body.trim()
        ? { noticeText: noticeDraft.body, approvedBy: "you", rung: noticeDraft.rung } : null,
      kind === "hold" && holdDraft.reason.trim()
        ? { reason: holdDraft.reason, decidedBy: "you", contact: holdDraft.contact, effect: holdDraft.effect } : null,
    ),
    consentMode,
  );

  const postNotice = () => {
    setError("");
    startTransition(async () => {
      const res = await postDeviceNotice(deviceId, { body: noticeDraft.body, rung: noticeDraft.rung });
      if (res?.error) { setError(res.error); return; }
      toast({ message: `Posted a notice to ${label}` });
      setNoticeDraft({ body: "", rung: "notice" }); setSheet(null);
    });
  };
  const clearNotice = async () => {
    const ok = await confirmDialog({
      title: `Clear the notice on "${label}"?`,
      context: notice ? `Approved by ${notice.approvedBy}` : undefined,
      body: "The machine stops showing it at its next check-in. The row stays, with your name and the time on it.",
      action: "Clear the notice", tone: "primary",
    });
    if (!ok) return;
    setError("");
    startTransition(async () => {
      const res = await clearDeviceNotice(deviceId);
      setError(res?.error ?? "");
      if (!res?.error) toast({ message: `Cleared the notice on ${label}` });
    });
  };

  const raiseHold = () => {
    setError("");
    startTransition(async () => {
      const res = await raiseSafetyHold(deviceId, holdDraft);
      if (res?.error) { setError(res.error); return; }
      toast({ message: `Raised a ${holdDraft.effect} hold on ${label}` });
      setHoldDraft({ reason: "", effect: "advise", faultSource: "", contact: "", dispatchedTo: "" }); setSheet(null);
    });
  };
  const clearHold = async () => {
    const said = await inputDialog({
      title: `Clear the safety hold on "${label}"?`,
      context: hold ? `${hold.reason} - raised by ${hold.decidedBy}` : undefined,
      body: "Say what was wrong and what fixed it. It is kept with the hold and read by whoever meets this fault next.",
      label: "Resolution", placeholder: "Replaced the heater thermocouple; setpoint holds to spec.",
      hint: "Recorded against the hold and in the audit trail.",
      action: "Clear the hold", tone: "primary",
    });
    if (!said) return;
    setError("");
    startTransition(async () => {
      const res = await clearSafetyHold(deviceId, said);
      setError(res?.error ?? "");
      if (!res?.error) toast({ message: `Cleared the hold on ${label}` });
    });
  };

  const lock = () => {
    setError("");
    startTransition(async () => {
      const res = await lockDevice(deviceId, lockDraft);
      if (res?.error) { setError(res.error); return; }
      toast({ message: `Locked out ${label}` });
      setLockDraft({ reference: "", reason: "", contact: "", force: "logoff" }); setSheet(null);
    });
  };
  const releaseLockout = async () => {
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

  const armLease = () => {
    setError("");
    startTransition(async () => {
      const res = await armDeviceLease(deviceId, leaseDraft);
      if (res?.error) { setError(res.error); return; }
      toast({ message: `Armed a lease on ${label}` });
      setSheet(null);
    });
  };
  const suspendLease = async () => {
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
  const resumeLease = () => {
    setError("");
    startTransition(async () => {
      const res = await resumeDeviceLease(deviceId);
      setError(res?.error ?? "");
      if (!res?.error) toast({ message: `Resumed renewal on ${label}` });
    });
  };
  const releaseLease = async () => {
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

  const holdProblem = !holdDraft.reason.trim() ? "say what the fault is" : null;
  const noticeProblem = !noticeDraft.body.trim() ? "say what the notice should say" : null;
  const lockProblem = !lockDraft.reference.trim() ? "give the report or claim reference"
    : !lockDraft.contact.trim() ? "give a number for whoever finds it" : null;
  const lockDegrades = holdDraft.effect === "lock" && consentMode === "consent";
  const leasePill = lease && leaseArmed ? (lease.suspended ? { tone: "warn", label: "lease · renewal suspended" } : LEASE_PILL[lease.state]) : null;

  return (
    <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 6 }}>
      {/* ── Status, always in view. Safety leads, as on the machine itself. ── */}
      {hold && (
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <span className={`pill ${hold.effect === "advise" ? "info" : "bad"}`}>
            {hold.effect === "lock" ? "safety hold · may lock" : `safety hold · ${hold.effect}`}
          </span>
          <span className="t-small">{hold.reason}</span>
          <span className="mut t-meta">
            {hold.decidedBy}, {hold.raised}
            {hold.faultSource ? ` · ${hold.faultSource}` : ""}
            {hold.dispatchedTo ? ` · sent ${hold.dispatchedTo}` : ""}
          </span>
          {hold.effect === "lock" && consentMode === "consent" && (
            <span className="mut t-meta">shows as advice here - {consentWhy}</span>
          )}
        </div>
      )}
      {notice && (
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <span className="pill warn">notice · {notice.rung.replace("_", " ")}</span>
          <span className="t-small">{notice.body}</span>
          <span className="mut t-meta">approved by {notice.approvedBy}, {notice.posted}</span>
        </div>
      )}
      {(notice || hold) && (
        noticeError ? (
          <div className="t-meta" style={{ color: "var(--t-bad-fg)" }}>Not delivered to the machine - {noticeError}</div>
        ) : noticePushed ? (
          <div className="mut t-meta">On the machine since {noticePushed}.</div>
        ) : (
          <div className="mut t-meta">Not sent to the machine yet.</div>
        )
      )}
      {lockout && (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <span className="pill bad">reported stolen · {lockout.force}</span>
            <span className="t-small">{lockout.reference}</span>
            {lockout.reason && <span className="mut t-small">{lockout.reason}</span>}
            <span className="mut t-meta">{lockout.decidedBy}, {lockout.raised}</span>
          </div>
          {lockout.enforceError ? (
            <div className="t-meta" style={{ color: "var(--t-bad-fg)" }}>Not applied - {lockout.enforceError}</div>
          ) : lockout.lastEnforced ? (
            <div className="mut t-meta">Last applied {lockout.lastEnforced}.</div>
          ) : (
            <div className="mut t-meta">Not reached yet - the machine has not been online since.</div>
          )}
        </>
      )}
      {leasePill && (
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <span className={`pill ${leasePill.tone}`}>{leasePill.label}</span>
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

      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)" }}>{error}</div>}

      {/* ── One menu for every action this machine and viewer allow. ── */}
      {hasActions && (
        <span ref={menuRef}>
          <Dropdown label={<>Manage <span aria-hidden="true">▾</span></>} ariaLabel={`Manage ${label}`}
            summaryClass="btn sm" align="left">
            {canRaiseHold && !hold && (
              <button type="button" onClick={() => run(() => { setError(""); setSheet("hold"); })}>Raise a safety hold</button>
            )}
            {hold && canRaiseHold && (
              <button type="button" onClick={() => run(() => void clearHold())}>Clear safety hold</button>
            )}
            {canPostNotice && !notice && (
              <button type="button" onClick={() => run(() => { setError(""); setSheet("notice"); })}>Post a notice</button>
            )}
            {notice && canPostNotice && (
              <button type="button" onClick={() => run(() => void clearNotice())}>Clear notice</button>
            )}
            {canManageLease && !leaseArmed && (
              <button type="button" onClick={() => run(() => { setError(""); setSheet("lease"); })}>Arm a lease</button>
            )}
            {leaseArmed && canManageLease && !lease?.suspended && (
              <button type="button" onClick={() => run(() => void suspendLease())}>Suspend lease renewal</button>
            )}
            {leaseArmed && canManageLease && lease?.suspended && (
              <button type="button" onClick={() => run(() => resumeLease())}>Resume lease renewal</button>
            )}
            {leaseArmed && canManageLease && (
              <button type="button" onClick={() => run(() => void offline())}>Offline lease code</button>
            )}
            {leaseArmed && canManageLease && (
              <button type="button" onClick={() => run(() => void releaseLease())}>Release lease for good</button>
            )}
            {canLock && !lockout && (
              <button type="button" style={{ color: "var(--t-bad-fg)" }}
                onClick={() => run(() => { setError(""); setSheet("lockout"); })}>Report stolen &amp; lock out</button>
            )}
            {lockout && canLock && (
              <button type="button" onClick={() => run(() => void releaseLockout())}>Release theft lockout</button>
            )}
          </Dropdown>
        </span>
      )}

      {/* ── Dialogs (copy unchanged from the per-feature controls). ── */}
      {sheet === "hold" && (
        <Dialog open onClose={() => setSheet(null)} title="Raise a safety hold" context={label}
          footer={
            <>
              <DialogStatus error={error} problem={holdProblem} ok="Sent to the machine now, and re-asserted hourly." />
              <button className="btn" onClick={() => setSheet(null)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={raiseHold} disabled={pending || !!holdProblem}>
                {pending ? "Raising..." : "Raise the hold"}
              </button>
            </>
          }>
          <div className="dialog-section">The fault</div>
          <label>What is wrong</label>
          <textarea value={holdDraft.reason} autoFocus rows={2}
            placeholder="Source heater overshooting setpoint; thermal fault suspected."
            onChange={(e) => setHoldDraft({ ...holdDraft, reason: e.target.value })} style={{ marginBottom: 8 }} />
          <label>Where the fault came from</label>
          <input value={holdDraft.faultSource} placeholder="engineer assessment"
            onChange={(e) => setHoldDraft({ ...holdDraft, faultSource: e.target.value })} style={{ marginBottom: 8 }} />
          <div className="dialog-section">What it does</div>
          <label>Effect</label>
          <select value={holdDraft.effect} style={{ marginBottom: 4 }}
            onChange={(e) => setHoldDraft({ ...holdDraft, effect: e.target.value as OpenHold["effect"] })}>
            {EFFECTS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
          {holdDraft.effect === "lock" && (
            <div className="mut t-meta" style={{ marginBottom: 8 }}>
              Permission, not instruction - and the support engine never takes it up: its only
              idle signal counts seconds since somebody touched the keyboard, which cannot tell
              a running instrument from an empty desk. So the machine is advised and never
              locked. The rung is still recorded as the call you made.
              {lockDegrades && ` It is stripped before sending in any case - ${consentWhy}.`}
            </div>
          )}
          <label>Who to call</label>
          <input value={holdDraft.contact} placeholder="Sierra Spectra 555-0100"
            onChange={(e) => setHoldDraft({ ...holdDraft, contact: e.target.value })} style={{ marginBottom: 8 }} />
          <label>Engineer sent to look at it</label>
          <input value={holdDraft.dispatchedTo} placeholder="nobody yet"
            onChange={(e) => setHoldDraft({ ...holdDraft, dispatchedTo: e.target.value })} style={{ marginBottom: 8 }} />
          <Preview notices={preview("hold")} empty="Nothing yet - say what the fault is." />
        </Dialog>
      )}

      {sheet === "notice" && (
        <Dialog open onClose={() => setSheet(null)} title="Post a repossession notice" context={label}
          footer={
            <>
              <DialogStatus error={error} problem={noticeProblem} ok="Posted under your name. It informs; it never blocks." />
              <button className="btn" onClick={() => setSheet(null)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={postNotice} disabled={pending || !!noticeProblem}>
                {pending ? "Posting..." : "Post the notice"}
              </button>
            </>
          }>
          <div className="dialog-section">What it says</div>
          <label>Notice</label>
          <textarea value={noticeDraft.body} autoFocus rows={3}
            placeholder="Property of Sierra Spectra. Account past due - call 555-0100."
            onChange={(e) => setNoticeDraft({ ...noticeDraft, body: e.target.value })} style={{ marginBottom: 8 }} />
          <label>How loudly</label>
          <select value={noticeDraft.rung} style={{ marginBottom: 4 }}
            onChange={(e) => setNoticeDraft({ ...noticeDraft, rung: e.target.value as OpenNotice["rung"] })}>
            {RUNGS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
          <div className="mut t-meta" style={{ marginBottom: 8 }}>
            Every rung informs and none of them blocks. Withholding our own work is a
            separate decision, and it lives on the client&apos;s credit standing.
          </div>
          <Preview notices={preview("notice")} empty="Nothing yet - write what it should say." />
        </Dialog>
      )}

      {sheet === "lockout" && (
        <Dialog open onClose={() => setSheet(null)} title="Report stolen and lock out" context={label}
          footer={
            <>
              <DialogStatus error={error} problem={lockProblem} ok="Applied now if the machine is online, and again every hour it appears." />
              <button className="btn" onClick={() => setSheet(null)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={lock} disabled={pending || !!lockProblem}>
                {pending ? "Locking..." : "Lock it out"}
              </button>
            </>
          }>
          <div className="dialog-section">What was filed</div>
          <label>Report or claim reference</label>
          <input value={lockDraft.reference} autoFocus placeholder="Reno PD 26-114882"
            onChange={(e) => setLockDraft({ ...lockDraft, reference: e.target.value })} style={{ marginBottom: 4 }} />
          <div className="mut t-meta" style={{ marginBottom: 8 }}>
            A police report, an insurance claim, an RMA - something that exists outside this
            software. Required, and deliberately so: an unpaid invoice is not grounds to lock
            a customer&apos;s instrument, and this is the field that keeps the two apart.
          </div>
          <label>What happened</label>
          <textarea value={lockDraft.reason} rows={2}
            placeholder="Taken from the loading dock overnight between the 27th and 28th."
            onChange={(e) => setLockDraft({ ...lockDraft, reason: e.target.value })} style={{ marginBottom: 8 }} />
          <label>Number for whoever finds it</label>
          <input value={lockDraft.contact} placeholder="Sierra Spectra 555-0100"
            onChange={(e) => setLockDraft({ ...lockDraft, contact: e.target.value })} style={{ marginBottom: 4 }} />
          <div className="mut t-meta" style={{ marginBottom: 8 }}>
            Goes on the screen. The person reading it may be an honest buyer or a shipper, and
            a number is what gets the instrument home.
          </div>
          <div className="dialog-section">What it does</div>
          <label>Force</label>
          <select value={lockDraft.force} style={{ marginBottom: 4 }}
            onChange={(e) => setLockDraft({ ...lockDraft, force: e.target.value as OpenLockout["force"] })}>
            {FORCE.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          {lockDraft.force !== "notify" && (
            <div className="mut t-meta" style={{ marginBottom: 8 }}>
              Ending the session closes whatever was running on it. On a machine that turns out
              not to be stolen, that means an interrupted acquisition.
            </div>
          )}
          <div className="dialog-section">How far this reaches</div>
          <div className="mut t-small">{LOCKOUT_REACH}</div>
        </Dialog>
      )}

      {sheet === "lease" && (
        <Dialog open onClose={() => setSheet(null)} title="Arm a lease" context={label}
          footer={
            <>
              <DialogStatus error={error} problem={null}
                ok={leaseDraft.force === "lock" ? "Locks the session once lapsed and past grace." : "Warns only - never locks."} />
              <button className="btn" onClick={() => setSheet(null)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={armLease} disabled={pending}>
                {pending ? "Arming..." : "Arm the lease"}
              </button>
            </>
          }>
          <div className="dialog-section">What a lapse does</div>
          <label>Force</label>
          <select value={leaseDraft.force} style={{ marginBottom: 4 }}
            onChange={(e) => setLeaseDraft({ ...leaseDraft, force: e.target.value as OpenLease["force"] })}>
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
          <input type="number" min={1} max={365} value={leaseDraft.leaseDays} style={{ marginBottom: 8 }}
            onChange={(e) => setLeaseDraft({ ...leaseDraft, leaseDays: parseInt(e.target.value || "7", 10) })} />
          <label>Grace (days)</label>
          <input type="number" min={0} max={90} value={leaseDraft.graceDays} style={{ marginBottom: 4 }}
            onChange={(e) => setLeaseDraft({ ...leaseDraft, graceDays: parseInt(e.target.value || "0", 10) })} />
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

/** What the far end will show, rendered from what the far end will be sent. */
function Preview({ notices, empty }: {
  notices: { kind: "repo" | "safety"; text: string; contact: string }[];
  empty: string;
}) {
  return (
    <>
      <div className="dialog-section">On the machine</div>
      {notices.length === 0 ? (
        <div className="mut t-small">{empty}</div>
      ) : notices.map((n, i) => (
        <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "8px 10px", marginBottom: 6 }}>
          <div className="t-small">{n.text}</div>
          {n.contact && <div className="mut t-meta">{n.contact}</div>}
        </div>
      ))}
    </>
  );
}
