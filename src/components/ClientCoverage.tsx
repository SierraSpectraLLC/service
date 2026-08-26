import { Panel, Pill } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { STANDING_LABEL, STANDING_TONE, daysLeft, standing } from "@/lib/agreements";

/**
 * What this client's agreement actually covers, in the terms of the agreement
 * rather than in a bar chart.
 *
 * The question it answers is the one a client cannot answer today: "will this
 * visit be billed". They have never had anywhere to look. Term, renewal, and
 * what is and is not included - the three facts that decide whether to pick up
 * the phone.
 *
 * Deliberately NOT a usage drawdown. The library that computes usage fires a
 * query per agreement and folds any failure into a zero, so a failed read
 * renders as "0 of 8 visits used" - good news, wrongly, on the one card whose
 * whole job is to be trusted about money. Entitlements are read straight off
 * the row and cannot be wrong that way. Usage belongs here eventually, once it
 * can tell "none yet" apart from "we could not find out".
 */
export default function ClientCoverage({ agreements, today, operatorName }: {
  agreements: {
    id: number;
    title: string;
    number: string;
    status: string;
    startsOn: string;
    endsOn: string;
    renewNoticeDays: number;
    visitsIncluded: number;
    visitsUnlimited: boolean;
    partsAllowanceCents: number;
    partsUnlimited: boolean;
    laborIncludedMinutes: number;
    pmPartsIncluded: boolean;
  }[];
  today: string;
  operatorName: string;
}) {
  if (agreements.length === 0) return null;

  return (
    <>
      <h3 className="band-label">Your coverage</h3>
      {agreements.map((a) => {
        const s = standing(a, today);
        const left = a.endsOn ? daysLeft(a.endsOn, today) : null;
        const noticeSoon = left !== null && a.renewNoticeDays > 0 && left <= a.renewNoticeDays;
        return (
          <Panel key={a.id}
            title={a.title || a.number || "Service agreement"}
            actions={<Pill tone={STANDING_TONE[s]}>{STANDING_LABEL[s]}</Pill>}
            hint={
              a.endsOn
                ? <>Runs {a.startsOn || "from an unrecorded date"} to <b>{a.endsOn}</b>
                    {left !== null && left >= 0 ? ` · ${left} day${left === 1 ? "" : "s"} left` : ""}
                    {noticeSoon && a.renewNoticeDays > 0
                      ? ` · renewal notice is ${a.renewNoticeDays} days, so now is when to talk to ${operatorName}`
                      : ""}</>
                : <>Open-ended · no end date recorded</>
            }
          >
            <div className="ledger">
              <span className="grow">
                Visits
                <span className="sub">An engineer coming to you</span>
              </span>
              <span>{entitlement(a.visitsUnlimited, a.visitsIncluded,
                (n) => `${n} included`)}</span>
            </div>
            <div className="ledger">
              <span className="grow">
                Parts
                <span className="sub">
                  {a.pmPartsIncluded
                    ? "A maintenance visit's own parts are part of the visit, not drawn from this"
                    : "Anything fitted during covered work"}
                </span>
              </span>
              <span>{entitlement(a.partsUnlimited, a.partsAllowanceCents,
                (n) => `${formatCents(n)} allowance`)}</span>
            </div>
            <div className="ledger">
              <span className="grow">
                Labor
                <span className="sub">Time on the bench and on your floor</span>
              </span>
              {/* No unlimited flag exists for labor in the record, so this
                  never claims one - a contract that really is all-in reads as
                  its hours until the column exists to say otherwise. */}
              <span>{entitlement(false, a.laborIncludedMinutes,
                (n) => `${Math.round(n / 60)} hour${Math.round(n / 60) === 1 ? "" : "s"} included`)}</span>
            </div>
            <div className="mut t-meta" style={{ marginTop: 8 }}>
              Anything outside this is quoted before it happens. You approve it first; nothing is
              charged without your answer.
            </div>
          </Panel>
        );
      })}
    </>
  );
}

/**
 * Zero means "not part of this agreement", never "zero allowed" - the schema
 * says so where the columns are defined, and an unlimited contract and a
 * no-visits contract are both real. The one nobody has filled in must not read
 * as the second.
 */
function entitlement(unlimited: boolean, amount: number, say: (n: number) => string) {
  if (unlimited) return <Pill tone="good">Unlimited</Pill>;
  if (amount > 0) return <b className="t-body">{say(amount)}</b>;
  return <span className="mut t-small">Not part of this agreement</span>;
}
