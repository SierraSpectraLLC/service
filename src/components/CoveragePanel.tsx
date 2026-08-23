import { formatCents } from "@/lib/money";
import type { CoverageAnswer } from "@/lib/billing";
import { Id, Panel, Pill } from "@/components/ui";

/**
 * Is this job covered, and if not, what does it bill at?
 *
 * lib/agreements already answers "what does this paper cover"; this only asks
 * it at the moment somebody is standing in front of the work order. It exists
 * because the two facts that cost the most money are both discovered too late:
 * that a visit is beyond the contract, and that AP has no PO to quote. Both
 * are cheap to fix before dispatch and expensive to fix at day forty-five.
 */
export default function CoveragePanel({ coverage, rateCents, poNumber, orgName }: {
  coverage: CoverageAnswer;
  /** The T&M hourly rate. Zero when labor is covered and nothing bills. */
  rateCents: number;
  poNumber: string;
  orgName: string;
}) {
  const covered = (coverage.labor || coverage.parts) && !coverage.exhausted;
  const lines = [
    coverage.exhausted && coverage.agreementNumber
      ? `The allowance on ${coverage.agreementNumber} is spent - this bills at the rate card, labelled "beyond contract". Say so before the work, not on the invoice.`
      : "",
    !covered && rateCents > 0
      ? `Not covered - time and materials at ${formatCents(rateCents)} an hour.`
      : "",
    covered && coverage.labor && coverage.parts ? "Labor and parts both draw on the agreement." : "",
    covered && coverage.labor && !coverage.parts ? "Labor is covered; parts pass through and bill." : "",
    !poNumber.trim()
      ? `No PO on file for ${orgName} - AP will bounce the invoice. Ask for one before dispatch, not after the work.`
      : "",
  ].filter(Boolean);
  if (!lines.length) return null;

  return (
    <Panel
      title="Coverage"
      actions={
        covered
          ? <Pill tone="good">Covered{coverage.agreementNumber ? ` · ${coverage.agreementNumber}` : ""}</Pill>
          : <Pill tone={coverage.exhausted ? "warn" : "neutral"}>
              {coverage.exhausted ? "Beyond contract" : "Time and materials"}
            </Pill>
      }
    >
      {lines.map((l, i) => (
        <div key={i} className="t-body" style={{ padding: "5px 0", borderTop: i ? "1px solid var(--line)" : undefined }}>
          {l}
        </div>
      ))}
      {poNumber.trim() && (
        <div className="mut t-small" style={{ marginTop: 6 }}>
          Billing against PO <Id>{poNumber}</Id>.
        </div>
      )}
    </Panel>
  );
}
