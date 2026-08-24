import Link from "next/link";
import { formatCents } from "@/lib/money";
import { depositToClear } from "@/lib/credit";
import type { CreditStanding } from "@/lib/credit";
import type { BillingPolicy } from "@/lib/billingPolicy";
import CreditOverrideButton from "@/components/CreditOverrideButton";
import { Id, Panel, Pill } from "@/components/ui";

export type HoldInvoice = {
  id: number; number: string; title: string;
  balanceCents: number; daysLate: number;
};

/**
 * What the engineer sees before they drive.
 *
 * It is on the work order rather than only in Billing because the moment that
 * matters is the one where somebody is deciding whether to load the van, and
 * "this client is forty-one days past due" is not a fact that helps anybody
 * the following Tuesday.
 *
 * Never a refusal. The job exists; the owner can override with a reason; and
 * the panel says exactly what clearing it would take, because that is the
 * sentence somebody has to say on the phone.
 */
export default function CreditHoldPanel({ standing, invoices, policy, orgId, orgName, canOverride }: {
  standing: CreditStanding;
  invoices: HoldInvoice[];
  policy: BillingPolicy;
  orgId: number;
  orgName: string;
  /** Only an owner may override; anybody on the bench may ask for the deposit. */
  canOverride: boolean;
}) {
  if (!standing.onHold && !standing.override) return null;
  const deposit = depositToClear({
    policy,
    openInvoices: invoices.map((i) => ({ balanceCents: i.balanceCents, daysLate: i.daysLate })),
  });

  return (
    <Panel
      title={<>Credit hold · {orgName}</>}
      actions={<Pill tone={standing.tone}>{standing.onHold ? "On hold" : "Overridden"}</Pill>}
      hint={standing.line}
    >
      {invoices.map((i) => (
        <div key={i.id} className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
          <Link href={`/money/invoices/${i.id}`} className="t-body" style={{ textDecoration: "none", fontWeight: 600 }}>
            <Id>{i.number}</Id>
          </Link>
          <span className="mut t-small" style={{ flex: 1, minWidth: 0 }}>{i.title}</span>
          {i.daysLate > 0 && <span className="pill bad">{i.daysLate}d</span>}
          <b className="t-body">{formatCents(i.balanceCents)}</b>
        </div>
      ))}

      <div className="row-2" style={{ marginTop: 10 }}>
        <CreditOverrideButton
          orgId={orgId} orgName={orgName}
          overridden={standing.override !== null}
          canOverride={canOverride}
          depositCents={standing.onHold ? deposit : 0}
        />
        <Link href="/money/collections" className="btn sm" style={{ textDecoration: "none" }}>
          Open in Collections
        </Link>
      </div>
    </Panel>
  );
}
