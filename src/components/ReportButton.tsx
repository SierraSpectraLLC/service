"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import { fileReport } from "@/app/actions";
import { KIND_LABEL, REPORT_KINDS, reportProblems, type ReportKind } from "@/lib/bugs";
import { REPORT_EVENT } from "@/lib/reportEvent";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";

/**
 * The one control that has to be on every page: say something is wrong.
 *
 * Mounted in the root layout for staff, because the whole value is that it is
 * reachable AT THE MOMENT somebody sees the thing. A report form living at
 * /settings/reports would be filed by nobody: by the time you have navigated
 * to it you have lost the page, the state and the will, and the report that
 * gets written is "the invoices are wrong somewhere".
 *
 * So it takes one sentence and captures the rest - the route, the build, the
 * viewport, the browser and the reporter's own last few pages - and SHOWS what
 * it will send before it sends it. Collection somebody can see is collection
 * somebody consented to.
 *
 * Ctrl/Cmd + / opens it, because the people most likely to notice a bug are
 * the ones least likely to stop what they are doing to reach for a mouse.
 */
export default function ReportButton() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [f, setF] = useState({ kind: "bug" as ReportKind, title: "", body: "", blocking: false });
  // Read at open rather than at render: the answer is about the window as it
  // is when somebody hits the problem, and a resize afterwards is not evidence.
  const [where, setWhere] = useState({ route: "", search: "", viewport: "" });

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") { e.preventDefault(); setOpen(true); }
    };
    // Anything on the page may ask for the box - the error page does, because
    // that is the moment somebody most wants it. See lib/reportEvent.
    const ask = () => setOpen(true);
    window.addEventListener("keydown", on);
    window.addEventListener(REPORT_EVENT, ask);
    return () => {
      window.removeEventListener("keydown", on);
      window.removeEventListener(REPORT_EVENT, ask);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setError("");
    setWhere({
      route: window.location.pathname,
      search: window.location.search,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    });
  }, [open, path]);

  const problem = reportProblems(f)[0] ?? null;

  const send = () =>
    startTransition(async () => {
      setError("");
      const res = await fileReport({ ...f, ...where });
      if (res.error) { setError(res.error); return; }
      toast({ message: "Reported - it is on the list, with the page you were on" });
      setOpen(false);
      setF({ kind: "bug", title: "", body: "", blocking: false });
    });

  return (
    <>
      {/* Bottom left, clear of the toast rack (bottom right) and of every
          page's own primary action. Small enough to ignore for a year and
          findable the minute it is wanted. */}
      <button type="button" className="report-fab" onClick={() => setOpen(true)}
        aria-label="Report a problem with this page" title="Report a problem  (⌘/)">
        <span aria-hidden="true">!</span>
      </button>

      {open && (
        <Dialog open onClose={() => setOpen(false)} size="sm"
          title="Report a problem"
          context="Goes to whoever looks after this software, with the page you are on attached."
          footer={<>
            <DialogStatus error={error} problem={problem} ok="Ready to send." />
            <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
            <button className="btn accent" onClick={send} disabled={pending || !!problem}>
              {pending ? "Sending..." : "Send it"}
            </button>
          </>}>
          <div className="seg" role="group" aria-label="What kind" style={{ marginBottom: 10 }}>
            {REPORT_KINDS.map((k) => (
              <button key={k} type="button" aria-pressed={f.kind === k}
                onClick={() => setF({ ...f, kind: k })}>{KIND_LABEL[k]}</button>
            ))}
          </div>

          <label>What happened</label>
          <input value={f.title} aria-label="What happened" autoFocus disabled={pending}
            placeholder={f.kind === "bug"
              ? "The invoice total is $200 short"
              : "Let me filter this list by engineer"}
            onChange={(e) => setF({ ...f, title: e.target.value })} />

          <label style={{ marginTop: 8 }}>
            Anything else <span className="mut" style={{ fontWeight: 400 }}>(optional)</span>
          </label>
          <textarea value={f.body} rows={3} aria-label="Details" disabled={pending}
            style={{ width: "100%" }}
            placeholder="What you were doing, what you expected, what you got"
            onChange={(e) => setF({ ...f, body: e.target.value })} />

          <label className="t-body" style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
            <input type="checkbox" className="check" checked={f.blocking} disabled={pending}
              onChange={(e) => setF({ ...f, blocking: e.target.checked })} />
            This is stopping me working
          </label>

          {/* Shown, not hidden. Somebody can see exactly what rides along -
              and it is also the fastest way for them to notice the route is
              wrong because they opened this from the wrong tab. */}
          <div className="mut t-meta" style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--line)" }}>
            Sent with it: <span className="mono">{where.route || "this page"}</span>
            {where.viewport ? ` · ${where.viewport}` : ""} · your browser · the last few
            pages you opened. No client names or search terms.
          </div>
        </Dialog>
      )}
    </>
  );
}
