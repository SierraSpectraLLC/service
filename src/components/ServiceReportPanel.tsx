"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "@/components/ui/Toast";
import { Id } from "@/components/ui";
import { issueServiceReport } from "@/app/actions";

export type IssuedReport = {
  id: number;
  number: string;
  issuedOn: string;
  issuedBy: string;
};

/**
 * The service report for a finished visit: issue it, and download what was
 * issued.
 *
 * The button carries the work order and nothing else - the server composes the
 * report from the rows, the same way the invoice draft does, so a page left
 * open since Tuesday cannot report Tuesday's parts prices. What comes back is
 * a numbered document that no longer changes: a client countersigns it, so
 * issuing a second one is how a correction is made, not editing the first.
 */
export default function ServiceReportPanel({ workOrderId, number, reports, ready, reason }: {
  workOrderId: number;
  /** The job's number, for the toast. */
  number: string;
  reports: IssuedReport[];
  /** Whether the job is far enough along to report on. */
  ready: boolean;
  /** Why it is not, said plainly, when it is not. */
  reason: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div className="card">
      <div className="t-body">
        What was asked, what was found, what was fitted, and what the agreement absorbed - the
        page a client signs. It is not an invoice and says so on its face.
      </div>

      {reports.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {reports.map((r) => (
            <div
              key={r.id}
              className="row-2"
              style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}
            >
              <Id>{r.number}</Id>
              <span className="mut t-small" style={{ flex: 1, minWidth: 0 }}>
                issued {r.issuedOn}{r.issuedBy ? ` by ${r.issuedBy}` : ""}
              </span>
              <a
                className="btn sm"
                style={{ textDecoration: "none" }}
                href={`/api/doc/service-report/${r.id}`}
                download
              >
                PDF
              </a>
            </div>
          ))}
        </div>
      )}

      <div className="row-2" style={{ alignItems: "center", marginTop: 12 }}>
        <button
          className="btn sm accent"
          disabled={pending || !ready}
          onClick={() => startTransition(async () => {
            const res = await issueServiceReport(workOrderId);
            if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
            toast({ message: `Wrote the service report for ${number}` });
            router.refresh();
          })}
        >
          {pending ? "Writing..." : reports.length ? "Issue another" : "Issue service report"}
        </button>
        {!ready && reason && <span className="mut t-small">{reason}</span>}
        {ready && reports.length > 0 && (
          <span className="mut t-small">A report already issued stays as it was signed.</span>
        )}
      </div>
    </div>
  );
}
