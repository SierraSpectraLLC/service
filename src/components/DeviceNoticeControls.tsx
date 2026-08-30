"use client";

import { useState, useTransition } from "react";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { confirmDialog, inputDialog } from "@/components/ui/ConfirmDialog";
import { noticesFor, permitted } from "@/lib/fleetNotice";
import { clearDeviceNotice, clearSafetyHold, postDeviceNotice, raiseSafetyHold } from "@/app/actions";

/** The open repossession notice on a machine, or null when it carries none. */
export type OpenNotice = {
  body: string;
  approvedBy: string;
  rung: "notice" | "prominent" | "at_login";
  posted: string;
};

/** The open engineering hold on a machine, or null when it is not held. */
export type OpenHold = {
  reason: string;
  decidedBy: string;
  effect: "advise" | "hold" | "lock";
  contact: string;
  faultSource: string;
  dispatchedTo: string;
  raised: string;
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

/**
 * Posting a notice and raising a hold, on one machine.
 *
 * Two acts kept visibly apart, because they are apart everywhere else: a
 * notice is commercial and only an owner may post one; a hold is engineering
 * and any staff member may raise one, because the person who finds the fault
 * is the person who should be able to say so. lib/fleetNotice explains at
 * length why neither one is derived from the other, and why nothing here
 * takes a balance.
 *
 * Both dialogs preview through the SAME functions the agent route renders
 * with - noticesFor and permitted - rather than describing what the machine
 * will say in copy of their own. A preview written by hand is a second
 * implementation that drifts; this one cannot say something the machine
 * would not.
 */
export default function DeviceNoticeControls({
  deviceId, label, consentMode, consentWhy, notice, hold, canPostNotice, canRaiseHold,
}: {
  deviceId: number;
  label: string;
  consentMode: "unattended" | "consent";
  /** Why consent is required, in the words lib/remoteAccess chose. */
  consentWhy: string;
  notice: OpenNotice | null;
  hold: OpenHold | null;
  canPostNotice: boolean;
  canRaiseHold: boolean;
}) {
  const [sheet, setSheet] = useState<null | "notice" | "hold">(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const [noticeDraft, setNoticeDraft] = useState({ body: "", rung: "notice" as OpenNotice["rung"] });
  const [holdDraft, setHoldDraft] = useState({
    reason: "", effect: "advise" as OpenHold["effect"], faultSource: "", contact: "", dispatchedTo: "",
  });

  if (!canPostNotice && !canRaiseHold && !notice && !hold) return null;

  // What the machine would actually show, computed the way the machine's own
  // endpoint computes it. `permitted` is what turns a lock rung into advice on
  // a system that has shipped, so the preview degrades exactly where the far
  // end will.
  const preview = (kind: "notice" | "hold") => permitted(
    noticesFor(
      kind === "notice" && noticeDraft.body.trim()
        ? { noticeText: noticeDraft.body, approvedBy: "you", rung: noticeDraft.rung }
        : null,
      kind === "hold" && holdDraft.reason.trim()
        ? { reason: holdDraft.reason, decidedBy: "you", contact: holdDraft.contact, effect: holdDraft.effect }
        : null,
    ),
    consentMode,
  );

  const postNotice = () => {
    setError("");
    startTransition(async () => {
      const res = await postDeviceNotice(deviceId, { body: noticeDraft.body, rung: noticeDraft.rung });
      if (res?.error) { setError(res.error); return; }
      toast({ message: `Posted a notice to ${label}` });
      setNoticeDraft({ body: "", rung: "notice" });
      setSheet(null);
    });
  };

  const raiseHold = () => {
    setError("");
    startTransition(async () => {
      const res = await raiseSafetyHold(deviceId, holdDraft);
      if (res?.error) { setError(res.error); return; }
      toast({ message: `Raised a ${holdDraft.effect} hold on ${label}` });
      setHoldDraft({ reason: "", effect: "advise", faultSource: "", contact: "", dispatchedTo: "" });
      setSheet(null);
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

  // The resolution is the point of clearing a hold, not paperwork attached to
  // it: a fault that was retired without anybody saying what fixed it is a
  // fault nobody can look up the next time it happens.
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

  const holdProblem = !holdDraft.reason.trim() ? "say what the fault is" : null;
  const noticeProblem = !noticeDraft.body.trim() ? "say what the notice should say" : null;
  // A lock rung asked for on a machine that is no longer ours to lock. Said
  // before the button, not discovered afterwards.
  const lockDegrades = holdDraft.effect === "lock" && consentMode === "consent";

  return (
    <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 6 }}>
      {/* Safety above the bill, the same order the machine shows them in and
          for the same reason - a fault is the more urgent sentence. */}
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
          {canRaiseHold && (
            <button className="btn link" disabled={pending} onClick={clearHold}>clear hold</button>
          )}
        </div>
      )}

      {notice && (
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <span className="pill warn">notice · {notice.rung.replace("_", " ")}</span>
          <span className="t-small">{notice.body}</span>
          <span className="mut t-meta">approved by {notice.approvedBy}, {notice.posted}</span>
          {canPostNotice && (
            <button className="btn link" disabled={pending} onClick={clearNotice}>clear notice</button>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {canRaiseHold && !hold && (
          <button className="btn link" disabled={pending}
            onClick={() => { setError(""); setSheet("hold"); }}>raise a safety hold</button>
        )}
        {canPostNotice && !notice && (
          <button className="btn link" disabled={pending}
            onClick={() => { setError(""); setSheet("notice"); }}>post a notice</button>
        )}
      </div>

      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)" }}>{error}</div>}

      {sheet === "hold" && (
        <Dialog open onClose={() => setSheet(null)} title="Raise a safety hold" context={label}
          footer={
            <>
              <DialogStatus error={error} problem={holdProblem}
                ok="Sent to the machine now, and re-asserted hourly." />
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
            onChange={(e) => setHoldDraft({ ...holdDraft, reason: e.target.value })}
            style={{ marginBottom: 8 }} />

          <label>Where the fault came from</label>
          <input value={holdDraft.faultSource} placeholder="engineer assessment"
            onChange={(e) => setHoldDraft({ ...holdDraft, faultSource: e.target.value })}
            style={{ marginBottom: 8 }} />

          <div className="dialog-section">What it does</div>
          <label>Effect</label>
          <select value={holdDraft.effect} style={{ marginBottom: 4 }}
            onChange={(e) => setHoldDraft({ ...holdDraft, effect: e.target.value as OpenHold["effect"] })}>
            {EFFECTS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
          {/* The one place in the product that can stop somebody using a
              machine, so it says out loud what it does not promise. */}
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
            onChange={(e) => setHoldDraft({ ...holdDraft, contact: e.target.value })}
            style={{ marginBottom: 8 }} />

          <label>Engineer sent to look at it</label>
          <input value={holdDraft.dispatchedTo} placeholder="nobody yet"
            onChange={(e) => setHoldDraft({ ...holdDraft, dispatchedTo: e.target.value })}
            style={{ marginBottom: 8 }} />

          <Preview notices={preview("hold")} empty="Nothing yet - say what the fault is." />
        </Dialog>
      )}

      {sheet === "notice" && (
        <Dialog open onClose={() => setSheet(null)} title="Post a repossession notice" context={label}
          footer={
            <>
              <DialogStatus error={error} problem={noticeProblem}
                ok="Posted under your name. It informs; it never blocks." />
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
            onChange={(e) => setNoticeDraft({ ...noticeDraft, body: e.target.value })}
            style={{ marginBottom: 8 }} />

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
