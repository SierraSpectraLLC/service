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

type Pending = { opts: ConfirmOptions; resolve: (ok: boolean) => void };

let current: Pending | null = null;
let notify: (() => void) | null = null;

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  // A second ask while one is up would stack invisibly; answer the first
  // with false and show the newer one, which is what the user last did.
  current?.resolve(false);
  return new Promise<boolean>((resolve) => {
    current = { opts, resolve };
    notify?.();
  });
}

export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    notify = () => setPending(current);
    // A call made before hydration finished still shows.
    if (current) setPending(current);
    return () => { notify = null; };
  }, []);

  if (!pending) return null;
  const { opts } = pending;
  const settle = (ok: boolean) => {
    pending.resolve(ok);
    if (current === pending) current = null;
    setPending(null);
  };

  return (
    <Dialog open size="sm" title={opts.title} onClose={() => settle(false)}
      footer={
        <>
          <span className="dialog-status" />
          <button type="button" className="btn" onClick={() => settle(false)}>
            {opts.cancel ?? "Cancel"}
          </button>
          <button type="button" autoFocus
            className={`btn ${opts.tone === "bad" ? "danger" : "primary"}`}
            onClick={() => settle(true)}>
            {opts.action}
          </button>
        </>
      }>
      {opts.body != null && <div className="t-body">{opts.body}</div>}
    </Dialog>
  );
}
