"use client";

import { useEffect, useState } from "react";
import Dialog from "@/components/ui/Dialog";

/**
 * window.confirm(), minus the ways window.confirm() fails. The decisive one
 * (learned in CustodyPanel, which shipped an armed two-click button instead):
 * browsers offer to suppress repeat dialogs from a page, and once that box is
 * ticked every native confirm() returns false - so a native dialog makes the
 * button silently do nothing. This is our own dialog, immune to that; it can
 * also say what is about to happen, and its action button names the act.
 *
 *   if (!(await confirmDialog({ title: "Decommission #33?", body: "...",
 *     action: "Decommission", tone: "bad" }))) return;
 *
 * One-line change per call site. The promise resolves false on Cancel,
 * Escape, or the scrim. ConfirmHost is mounted once in layout.tsx; the
 * module-level function talks to it directly, so call sites need no hook
 * and no provider threading.
 */
export type ConfirmOptions = {
  title: string;
  /** What happens - a sentence, or a node with a consequence list. */
  body?: React.ReactNode;
  /** The verb on the button: "Remove", "Decommission", "Delete 3 files". */
  action: string;
  tone?: "bad" | "primary";
  cancel?: string;
};

type Pending = {
  opts: ConfirmOptions;
  /** Set for confirmReason: the confirm also collects an audit reason. */
  withReason?: boolean;
  resolve: (answer: boolean | string | null) => void;
};

let current: Pending | null = null;
let notify: (() => void) | null = null;

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  // A second ask while one is up would stack invisibly; answer the first
  // with false and show the newer one, which is what the user last did.
  current?.resolve(false);
  return new Promise<boolean>((resolve) => {
    current = { opts, resolve: resolve as Pending["resolve"] };
    notify?.();
  });
}

/**
 * The 21 CFR Part 11 flavour: confirm AND collect the reason in one dialog,
 * for actions the audit trail records. Resolves the trimmed reason, or null
 * on Cancel/Escape/scrim. The server enforces the reason too - this is the
 * front door, not the lock.
 */
/**
 * promptReason's drop-in successor: the same one-string call the old
 * window.prompt sites made, answered by the dialog instead. The message
 * becomes the title; the reason field and audit posture are confirmReason's.
 */
export function confirmReasonText(what: string): Promise<string | null> {
  return confirmReason({ title: what, action: "Confirm", tone: "bad" });
}

export function confirmReason(opts: ConfirmOptions): Promise<string | null> {
  current?.resolve(null);
  return new Promise<string | null>((resolve) => {
    current = { opts, withReason: true, resolve: resolve as Pending["resolve"] };
    notify?.();
  });
}

export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");

  useEffect(() => {
    notify = () => { setPending(current); setReason(""); };
    // A call made before hydration finished still shows.
    if (current) setPending(current);
    return () => { notify = null; };
  }, []);

  if (!pending) return null;
  const { opts, withReason } = pending;
  const settle = (answer: boolean | string | null) => {
    pending.resolve(answer);
    if (current === pending) current = null;
    setPending(null);
    setReason("");
  };
  const cancelValue = withReason ? null : false;
  const ready = !withReason || reason.trim().length >= 3;
  const confirm = () => {
    if (!ready) return;
    settle(withReason ? reason.trim() : true);
  };

  return (
    <Dialog open size="sm" title={opts.title} onClose={() => settle(cancelValue)}
      footer={
        <>
          <span className="dialog-status" />
          <button type="button" className="btn" onClick={() => settle(cancelValue)}>
            {opts.cancel ?? "Cancel"}
          </button>
          <button type="button" autoFocus={!withReason} disabled={!ready}
            className={`btn ${opts.tone === "bad" ? "danger" : "primary"}`}
            onClick={confirm}>
            {opts.action}
          </button>
        </>
      }>
      {opts.body != null && <div className="t-body">{opts.body}</div>}
      {withReason && (
        <div className="field" style={{ marginTop: opts.body != null ? 10 : 0 }}>
          <label htmlFor="confirm-reason">Reason</label>
          <input id="confirm-reason" value={reason} autoFocus maxLength={300}
            placeholder="Recorded in the audit trail"
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") confirm(); }} />
          <div className="field-hint">A few words, kept with the record of this action.</div>
        </div>
      )}
    </Dialog>
  );
}
