"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setReportStatus } from "@/app/actions";
import {
  browserLine, needsResolution, rankReports, reportOpen, REPORT_STATES,
  STATE_LABEL, STATE_TONE, whereLine, type ReportState,
} from "@/lib/bugs";
import type { ReportRow } from "@/lib/bugData";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { Panel, Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

/**
 * What has been reported, and what happened to it.
 *
 * The second half is the point. A report queue that only collects is a
 * suggestion box: people file into it twice and then stop, because nothing
 * ever visibly came back. So every row can be answered, ending one demands a
 * word about why, and the answer is shown to whoever filed it - which is the
 * only thing that keeps the next report coming.
 */
export default function ReportQueue({ rows, showWorkspace }: {
  rows: ReportRow[];
  /** Platform staff read every workspace's, so their rows say whose. */
  showWorkspace: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [ending, setEnding] = useState<null | { id: number; status: ReportState }>(null);
  const [why, setWhy] = useState("");
  const [shown, setShown] = useState<number | null>(null);

  const run = (fn: () => Promise<{ error?: string }>, ok: string) =>
    startTransition(async () => {
      setError("");
      const res = await fn();
      if (res?.error) { setError(res.error); toast({ message: res.error }); return; }
      toast({ message: ok });
      setEnding(null); setWhy("");
      router.refresh();
    });

  const open = rows.filter((r) => reportOpen(r.status));

  return (
    <>
      <Panel
        title="Reported problems"
        count={open.length || undefined}
        hint="Anything staff have flagged while using the app. The page they were on, the build and their last few screens come with each one."
        empty="Nothing reported. The button is bottom-left on every page, or ⌘/."
      >
        {rankReports(rows).map((r) => {
          const s = (REPORT_STATES as readonly string[]).includes(r.status)
            ? (r.status as ReportState) : "new";
          return (
            <div key={r.id} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
              <div className="row-2" style={{ alignItems: "baseline" }}>
                <span className="t-body" style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>
                  {r.title}
                  {r.kind === "idea" && <span className="mut t-meta"> · an idea</span>}
                </span>
                {r.blocking && reportOpen(r.status) && <Pill tone="bad">Blocked</Pill>}
                <Pill tone={STATE_TONE[s]}>{STATE_LABEL[s]}</Pill>
              </div>
              <div className="mut t-meta">
                {r.reportedByName || r.reportedBy} · {r.when}
                {showWorkspace && r.fromName ? ` · ${r.fromName}` : ""}
              </div>
              {r.body && (
                <div className="t-small" style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{r.body}</div>
              )}
              {/* Captured, not typed - and the reason a report is actionable
                  at all. Shown on the row rather than folded away. */}
              <div className="mut t-meta mono" style={{ marginTop: 4 }}>
                {whereLine(r)}{r.userAgent ? ` · ${browserLine(r.userAgent)}` : ""}
              </div>

              {r.resolution && (
                <div className="t-small" style={{ marginTop: 4, color: "var(--t-good-fg)" }}>
                  {STATE_LABEL[s]}: {r.resolution}
                  {r.resolvedBy ? <span className="mut"> — {r.resolvedBy}</span> : null}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                {r.status === "new" && (
                  <button className="btn sm" disabled={pending}
                    onClick={() => run(() => setReportStatus(r.id, "open"), "Marked as being looked at")}>
                    Looking at it
                  </button>
                )}
                {reportOpen(r.status) && (
                  <>
                    <button className="btn sm accent" disabled={pending}
                      onClick={() => { setError(""); setWhy(""); setEnding({ id: r.id, status: "fixed" }); }}>
                      Fixed
                    </button>
                    <button className="btn link" style={{ fontSize: 12 }} disabled={pending}
                      onClick={() => { setError(""); setWhy(""); setEnding({ id: r.id, status: "closed" }); }}>
                      close it
                    </button>
                  </>
                )}
                {!reportOpen(r.status) && (
                  <button className="btn link" style={{ fontSize: 12 }} disabled={pending}
                    onClick={() => run(() => setReportStatus(r.id, "open"), "Reopened")}>
                    reopen
                  </button>
                )}
                {r.breadcrumbs.length > 0 && (
                  <button className="btn link" style={{ fontSize: 12 }}
                    onClick={() => setShown(shown === r.id ? null : r.id)}>
                    {shown === r.id ? "hide" : `what they did (${r.breadcrumbs.length})`}
                  </button>
                )}
              </div>

              {/* Their own last few minutes, frozen when they filed. The
                  difference between "the invoices page is broken" and a route,
                  a sequence and an exception. */}
              {shown === r.id && (
                <div style={{ marginTop: 6, paddingLeft: 10, borderLeft: "2px solid var(--line)" }}>
                  {r.breadcrumbs.map((c, i) => (
                    <div key={i} className="mut t-meta mono">
                      {c.at.slice(11, 16)} {c.kind === "error" ? "✕" : "→"} {c.route}
                      {c.message ? ` — ${c.message}` : ""}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </Panel>

      {ending && (
        <Dialog open onClose={() => setEnding(null)} size="sm"
          title={ending.status === "fixed" ? "What was fixed?" : "Why is it closed?"}
          context="Whoever reported it reads this. A status with no word beside it is how somebody learns not to bother next time."
          footer={<>
            <DialogStatus error={error} problem={why.trim() ? null : "say what happened"} />
            <button className="btn" onClick={() => setEnding(null)} disabled={pending}>Cancel</button>
            <button className="btn accent" disabled={pending || !why.trim()}
              onClick={() => run(() => setReportStatus(ending.id, ending.status, why),
                ending.status === "fixed" ? "Marked fixed" : "Closed")}>
              {ending.status === "fixed" ? "Mark it fixed" : "Close it"}
            </button>
          </>}>
          <label>{ending.status === "fixed" ? "What changed" : "Why"}</label>
          <input value={why} aria-label="Resolution" autoFocus disabled={pending}
            placeholder={ending.status === "fixed"
              ? "The total was double-counting covered lines"
              : "Working as intended - the figure excludes tax"}
            onChange={(e) => setWhy(e.target.value)} />
          {needsResolution(ending.status) && null}
        </Dialog>
      )}
    </>
  );
}
