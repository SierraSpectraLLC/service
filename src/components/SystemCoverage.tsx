import Link from "next/link";
import { Panel, Pill } from "@/components/ui";
import { COVERAGE, coverageBadge, coverageLine, type Coverage } from "@/lib/coverage";

/**
 * Who services this system, and when anybody here last did.
 *
 * Not to be confused with the work order's CoveragePanel, which asks the
 * narrower question at the moment of dispatch: does THIS job bill. This one is
 * about the machine and the relationship - the question a client has standing
 * in front of a broken instrument, which is "who do I call, and is this going
 * to cost me".
 *
 * The pair of facts is deliberate. Coverage without a service date is a claim
 * about paper; a service date without coverage is a fact with no bearing on
 * what happens next. Neither had a home on this page before.
 */
export default function SystemCoverage({
  coverage, today, operatorName, lastService, agreementHref, recorder,
}: {
  coverage: Coverage;
  today: string;
  operatorName: string;
  /** The most recent job THIS workspace closed on it. Null when there is none. */
  lastService: { on: string; number: string; title: string } | null;
  /** Where to read the agreement, for a viewer allowed to open it. */
  agreementHref?: string;
  /**
   * The control for recording somebody else's contract, supplied by the page
   * that knows whether this reader may. Absent for anybody who may not, which
   * is the only gate on the client side - the real one is on the action.
   */
  recorder?: React.ReactNode;
}) {
  const c = coverage;
  return (
    <Panel title="Coverage"
      actions={<Pill tone={COVERAGE[c.state].tone}>{coverageBadge(c)}</Pill>}>
      <div className="t-body" style={{ marginBottom: 6 }}>
        {coverageLine(c, today)}
        {c.expiring && (
          <span style={{ color: "var(--t-warn-fg)" }}>
            {" "}— inside its renewal notice, so now is when to talk about it.
          </span>
        )}
      </div>

      {c.agreementId !== null && (
        <div className="ledger">
          <span className="grow">
            {agreementHref
              ? <Link href={agreementHref} className="plain" style={{ fontWeight: 600 }}>{c.agreementTitle}</Link>
              : <b>{c.agreementTitle}</b>}
            {/* Named even when it is us, so the sentence never depends on the
                reader knowing whose workspace they are looking at. */}
            <span className="sub">Held by {c.provider}</span>
          </span>
        </div>
      )}

      {/* What this record can actually vouch for: our own closed work. A system
          under contract elsewhere may well have been serviced last month by
          somebody whose work never reaches this page, so the row says whose
          work it is reporting rather than claiming to be the last service. */}
      <div className="ledger">
        <span className="grow">
          Last service by {operatorName}
          <span className="sub">
            {lastService
              ? lastService.title || `Work order ${lastService.number}`
              : "Nothing closed on this record yet"}
          </span>
        </span>
        <span className="mut t-meta">{lastService ? lastService.on : "—"}</span>
      </div>

      {c.state === "unknown" && (
        // The honest reading of an empty file, said out loud rather than left
        // for somebody to infer it wrongly in either direction.
        <div className="mut t-small" style={{ marginTop: 8 }}>
          Nobody has recorded a service contract for this system. It may be
          covered by a company we do not know about, or by nobody at all.
        </div>
      )}
      {recorder}
    </Panel>
  );
}
