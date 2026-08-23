import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { agreements, invoices, orgs, rateCards } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { allowance, drawdown, renewalLine, standing, STANDING_LABEL, STANDING_TONE } from "@/lib/agreements";
import { usageFor } from "@/lib/agreementUsage";
import { resolveRate } from "@/lib/rates";
import { contractProposal, renewalFromBurn } from "@/lib/quotes";
import { allInvoices } from "@/lib/invoiceData";
import MoneyTabs from "@/components/MoneyTabs";
import { EmptyState, Id, PageHead, Panel, Pill } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * What is on standing arrangement, how much of it is left, and - for the
 * clients who have none - what a contract would be worth to both sides.
 *
 * The drawdown is lib/agreements' drawdown, the same function the contract
 * page uses. Nothing here re-implements it: an invoice and a contract page
 * disagreeing about the same allowance is exactly the failure the whole
 * no-stored-balances rule exists to prevent.
 */
export default async function ContractsPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");

  const today = shopToday();
  const [rows, orgRows, cards, billed] = await Promise.all([
    db.select().from(agreements),
    db.select({ id: orgs.id, name: orgs.name, kind: orgs.kind }).from(orgs),
    db.select().from(rateCards),
    allInvoices(),
  ]);
  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));

  const live = rows.filter((a) => a.kind === "contract" && a.status !== "cancelled");
  const cards_ = await Promise.all(live.map(async (a) => {
    const used = await usageFor(a, a.orgId).catch(
      () => ({ partsCents: 0, visits: 0, laborMinutes: 0, pmPartsCents: 0, kitUsed: {} }),
    );
    const d = drawdown(a, used);
    const rate = resolveRate(cards, { orgId: a.orgId, agreementId: a.id });
    return {
      a, used, d, rate,
      visits: allowance(a.visitsIncluded, used.visits, a.visitsUnlimited),
      parts: allowance(a.partsAllowanceCents, used.partsCents, a.partsUnlimited),
      renewal: renewalFromBurn({
        visitsUsed: used.visits, partsCents: used.partsCents,
        laborMinutes: used.laborMinutes, hourlyCents: rate.hourlyCents,
      }),
    };
  }));

  // Clients with no contract, and what their trailing time-and-materials has
  // actually come to. The proposal is only honest if both numbers show.
  const contracted = new Set(live.map((a) => a.orgId));
  const uncontracted = orgRows
    .filter((o) => o.kind === "client" && !contracted.has(o.id))
    .map((o) => {
      const theirs = billed.filter((f) => f.row.orgId === o.id && f.row.status !== "void" && f.row.status !== "draft");
      const trailing = theirs.reduce(
        (n, f) => n + f.lines.reduce((m, l) => m + (l.covered ? 0 : Math.round((l.qty / 1000) * l.unitCents)), 0),
        0,
      );
      const first = theirs.map((f) => f.row.issuedOn).filter(Boolean).sort()[0] ?? "";
      const months = first
        ? Math.max(1, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / (86400000 * 30)))
        : 0;
      return {
        org: o, trailing, months, invoices: theirs.length,
        proposal: contractProposal({
          trailingCents: trailing, months,
          visitsPerYear: 4, partsAllowanceCents: 200000,
        }),
      };
    })
    .filter((x) => x.proposal !== null);

  return (
    <div className="container wide">
      <PageHead
        crumb={<><Link href="/money">Billing</Link> › <b>Contracts</b></>}
        title="Contracts"
        sub="What is on standing arrangement and how much of it is left - drawn down from the work itself, never from a stored balance."
      />
      <MoneyTabs active="contracts" counts={{ contracts: live.length }} />

      {live.length === 0 && uncontracted.length === 0 && (
        <EmptyState title="Nothing on contract yet" body="Agreements you write appear here with their burn-down." />
      )}

      {cards_.map(({ a, d, used, visits, parts, rate, renewal }) => {
        const s = standing(a, today);
        return (
          <Panel
            key={a.id}
            title={
              <Link href={`/agreements/${a.id}`} style={{ textDecoration: "none" }}>
                <Id>{a.number}</Id> {orgName.get(a.orgId) ?? ""}
              </Link>
            }
            actions={<Pill tone={STANDING_TONE[s]}>{STANDING_LABEL[s]}</Pill>}
            hint={renewalLine(a, today)}
          >
            <div className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <span className="mut t-small" style={{ width: 120 }}>Visits</span>
              <span className="t-body" style={{ flex: 1, minWidth: 0 }}>
                {visits.unlimited ? "unlimited" : visits.tracked ? `${visits.used} of ${visits.included} used` : "not capped"}
                {visits.tracked && !visits.unlimited && visits.over && (
                  <span className="pill warn" style={{ marginLeft: 8 }}>beyond contract</span>
                )}
              </span>
            </div>
            <div className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <span className="mut t-small" style={{ width: 120 }}>Parts allowance</span>
              <span className="t-body" style={{ flex: 1, minWidth: 0 }}>
                {parts.unlimited ? "unlimited" : parts.tracked
                  ? `${formatCents(parts.used)} of ${formatCents(parts.included)} drawn`
                  : "pass-through"}
                {parts.tracked && !parts.unlimited && parts.over && (
                  <span className="pill warn" style={{ marginLeft: 8 }}>beyond contract</span>
                )}
              </span>
            </div>
            <div className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <span className="mut t-small" style={{ width: 120 }}>Labor</span>
              <span className="t-body" style={{ flex: 1, minWidth: 0 }}>
                {Math.round(used.laborMinutes / 60)} h logged at {formatCents(rate.hourlyCents)} an hour
                {d.labor.tracked && !d.labor.unlimited && d.labor.over && (
                  <span className="pill warn" style={{ marginLeft: 8 }}>beyond contract</span>
                )}
              </span>
            </div>
            <div className="mut t-small" style={{ marginTop: 8 }}>
              A renewal priced off this term&apos;s burn would come to{" "}
              <b>{formatCents(renewal.valueCents)}</b> - {renewal.basis}. The renewals cron drafts it
              inside the notice window and leaves it for somebody to read.
            </div>
          </Panel>
        );
      })}

      {uncontracted.length > 0 && (
        <Panel
          title="No contract"
          count={uncontracted.length}
          hint="What their time-and-materials has actually come to, and what a contract would be worth to both sides."
        >
          {uncontracted.map(({ org, trailing, months, invoices: n, proposal }) => (
            <div key={org.id} style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
              <div className="row-2" style={{ alignItems: "baseline" }}>
                <span className="t-body" style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>{org.name}</span>
                <span className="mut t-small">
                  {`${formatCents(trailing)} over ${months} month${months === 1 ? "" : "s"}, `
                    + `${n} invoice${n === 1 ? "" : "s"}`}
                </span>
              </div>
              {proposal && (
                <div className="mut t-small" style={{ marginTop: 4 }}>
                  {proposal.line} That is {formatCents(proposal.savingCents)} a year cheaper for them and
                  predictable for you - and it ends the collections conversation.
                </div>
              )}
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}
