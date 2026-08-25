import Link from "next/link";
import { asc, desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { agreements, instruments, orgs, rateCards } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { standing } from "@/lib/agreements";
import { usageForAll } from "@/lib/agreementUsage";
import { resolveRate } from "@/lib/rates";
import { contractProposal, renewalFromBurn } from "@/lib/quotes";
import { allInvoices } from "@/lib/invoiceData";
import MoneyTabs from "@/components/MoneyTabs";
import AgreementsPanel from "@/components/AgreementsPanel";
import RetainerCard from "@/components/RetainerCard";
import { FacetStrip, PageHead, Panel, Toolbar } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The standing arrangements, editable in place - and for the clients who have
 * none, what a contract would be worth to both sides.
 *
 * The drawdown bars are AgreementsPanel's bars, fed by lib/agreementUsage: the
 * same functions every other surface uses, so an invoice and a contract page
 * cannot disagree about the same allowance. Ended contracts stay reachable
 * behind a facet because "what did their last contract look like" is a billing
 * question, not an archives one.
 */
export default async function ContractsPage({ searchParams }: {
  searchParams: Promise<{ f?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const { f = "" } = await searchParams;

  const today = shopToday();
  const [rows, orgRows, cards, billed, systemRows] = await Promise.all([
    db.select().from(agreements).where(eq(agreements.kind, "contract"))
      .orderBy(asc(agreements.endsOn), desc(agreements.id)),
    db.select({ id: orgs.id, name: orgs.name, kind: orgs.kind }).from(orgs),
    db.select().from(rateCards),
    allInvoices(),
    db.select({
      id: instruments.id, ownerOrgId: instruments.ownerOrgId,
      externalId: instruments.externalId, model: instruments.model,
    }).from(instruments).orderBy(asc(instruments.externalId)),
  ]);
  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));
  const clientOrgs = orgRows.filter((o) => o.kind === "client").map((o) => ({ id: o.id, name: o.name }));
  const systems = systemRows
    .filter((r) => r.ownerOrgId !== null)
    .map((r) => ({ id: r.id, ownerOrgId: r.ownerOrgId, externalId: r.externalId, label: r.model }));

  const usage = await usageForAll(rows);
  const nothing = { partsCents: 0, visits: 0, laborMinutes: 0, pmPartsCents: 0 };

  const shaped = rows.map((r) => ({
    id: r.id, orgId: r.orgId, orgName: orgName.get(r.orgId) ?? "an organization",
    kind: r.kind, number: r.number, title: r.title, status: r.status,
    startsOn: r.startsOn, endsOn: r.endsOn, renewNoticeDays: r.renewNoticeDays,
    visitsIncluded: r.visitsIncluded, partsAllowanceCents: r.partsAllowanceCents,
    laborIncludedMinutes: r.laborIncludedMinutes,
    visitsUnlimited: r.visitsUnlimited, partsUnlimited: r.partsUnlimited,
    pmPartsIncluded: r.pmPartsIncluded, includedKits: r.includedKits,
    hourlyRateCents: r.hourlyRateCents, instrumentIds: r.instrumentIds,
    valueCents: r.valueCents, note: r.note,
    used: usage.get(r.id) ?? nothing,
  }));

  // In force is what the money answers to; ended is what it used to answer to.
  const inForce = shaped.filter((a) => ["active", "expiring"].includes(standing(a, today)));
  const ended = shaped.filter((a) => ["expired", "cancelled"].includes(standing(a, today)));
  const shown = f === "ended" ? ended : f === "all" ? shaped : inForce;
  // Standing billing reads the raw rows, not the shaped ones: it needs the
  // schedule columns, and it only ever concerns contracts still in force.
  const inForceIds = new Set(inForce.map((a) => a.id));
  const retainers = rows.filter((r) => inForceIds.has(r.id)).map((r) => ({
    id: r.id, orgId: r.orgId, orgName: orgName.get(r.orgId) ?? "an organization",
    number: r.number, title: r.title, status: r.status,
    startsOn: r.startsOn, endsOn: r.endsOn,
    billEveryMonths: r.billEveryMonths, billAmountCents: r.billAmountCents,
    billDescription: r.billDescription, billDayOfMonth: r.billDayOfMonth,
    billLeadDays: r.billLeadDays, billNextOn: r.billNextOn, billLastOn: r.billLastOn,
  }));

  // The renewal figure, priced off what the term actually cost to serve.
  const extra: Record<number, string> = {};
  for (const a of inForce) {
    const rate = resolveRate(cards, { orgId: a.orgId, agreementId: a.id });
    const renewal = renewalFromBurn({
      visitsUsed: a.used.visits, partsCents: a.used.partsCents,
      laborMinutes: a.used.laborMinutes, hourlyCents: rate.hourlyCents,
    });
    if (renewal.valueCents > 0) {
      extra[a.id] = `Renewal at this term's usage: ${formatCents(renewal.valueCents)}`;
    }
  }

  // Clients with no contract in force, and what their trailing
  // time-and-materials has actually come to. The proposal is only honest if
  // both numbers show.
  const contracted = new Set(inForce.map((a) => a.orgId));
  const uncontracted = orgRows
    .filter((o) => o.kind === "client" && !contracted.has(o.id))
    .map((o) => {
      const theirs = billed.filter((x) => x.row.orgId === o.id && x.row.status !== "void" && x.row.status !== "draft");
      const trailing = theirs.reduce(
        (n, x) => n + x.lines.reduce((m, l) => m + (l.covered ? 0 : Math.round((l.qty / 1000) * l.unitCents)), 0),
        0,
      );
      const first = theirs.map((x) => x.row.issuedOn).filter(Boolean).sort()[0] ?? "";
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
        sub=""
      />
      <MoneyTabs active="contracts" counts={{ contracts: inForce.length }} />
      <Toolbar
        facets={
          <FacetStrip facets={[
            { key: "inforce", label: "In force", count: inForce.length || undefined, on: f === "", href: "/money/contracts" },
            { key: "ended", label: "Ended", count: ended.length || undefined, on: f === "ended", href: "/money/contracts?f=ended" },
            { key: "all", label: "All", count: shaped.length || undefined, on: f === "all", href: "/money/contracts?f=all" },
          ]} />
        }
      />

      <RetainerCard rows={retainers} today={today} canEdit />

      <AgreementsPanel
        rows={shown} today={today} systems={systems} orgs={clientOrgs}
        canEdit extra={extra}
        title={f === "ended" ? "Ended" : f === "all" ? "All contracts" : "In force"}
      />

      {uncontracted.length > 0 && (
        <Panel
          title="No contract"
          count={uncontracted.length}
          hint="Trailing time-and-materials"
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
                <div className="mut t-small" style={{ marginTop: 4 }}>{proposal.line}</div>
              )}
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}
