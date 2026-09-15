import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agreements, attachments, instruments, orgSites, orgs, rateCards } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { forTenant, visibleOrgs } from "@/lib/tenancy";
import { formatCents } from "@/lib/money";
import { shopDay } from "@/lib/shopday";
import { booksContext } from "@/lib/financeData";
import { periodSpan } from "@/lib/finance";
import { billingContext, creditForMany } from "@/lib/invoiceData";
import { standing as agreementStanding } from "@/lib/agreements";
import { usageForAll } from "@/lib/agreementUsage";
import { resolveRate } from "@/lib/rates";
import { renewalFromBurn } from "@/lib/quotes";
import { providerNameOf, providerNames } from "@/lib/providers";
import { awardsFor } from "@/lib/awardData";
import { brandForTenant } from "@/lib/brand";
import { entries } from "@/lib/ledger";
import FinanceShell from "@/components/FinanceShell";
import AgreementsPanel from "@/components/AgreementsPanel";
import AwardLadder from "@/components/AwardLadder";
import RetainerCard from "@/components/RetainerCard";
import CreditOverrideButton from "@/components/CreditOverrideButton";
import { depositToClear } from "@/lib/credit";
import { Figure, Id, Pill } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Who owes what, who is on hold, and what they see.
 *
 * Standing is computed from the same balances the receivable is - the
 * scheduler's dispatch gate reads creditFor(), not this page - and the hold
 * rule is each client's billing policy. The drawer is two views of one
 * client: ours, with the hold and the agreement; theirs, the statement the
 * portal shows. The contracts that used to be a room of their own are here,
 * under the standing table, because a contract is a fact about a client.
 */
export default async function ClientsPage({ searchParams }: {
  searchParams: Promise<{ period?: string; org?: string; view?: string; f?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const sp = await searchParams;
  const { period, today, mine, figures: f, rail } = await booksContext(user, sp.period);
  const openOrg = sp.org && /^\d+$/.test(sp.org) ? Number(sp.org) : null;
  const theirView = sp.view === "theirs";

  const orgRows = await visibleOrgs(user);
  const clients = orgRows.filter((o) => o.kind === "client");
  const ids = clients.map((o) => o.id);
  const [standings, agreementRows, sites] = await Promise.all([
    creditForMany(ids, today),
    db.select().from(agreements).where(and(eq(agreements.kind, "contract"), forTenant(agreements.tenantOrgId, mine)))
      .orderBy(asc(agreements.endsOn), desc(agreements.id)),
    ids.length ? db.select().from(orgSites).where(inArray(orgSites.orgId, ids)) : Promise.resolve([]),
  ]);
  const usage = await usageForAll(agreementRows);
  const inForce = agreementRows.filter((a) => ["active", "expiring"].includes(agreementStanding(a, today)));
  const openBy = new Map<number, { n: number; cents: number }>();
  const quotedBy = new Map<number, number>();
  for (const r of f.receivables) {
    if (r.stage === "current" || r.stage === "pastdue") {
      const o = openBy.get(r.orgId) ?? { n: 0, cents: 0 }; o.n++; o.cents += r.cents; openBy.set(r.orgId, o);
    }
    if (r.stage === "quoted") quotedBy.set(r.orgId, (quotedBy.get(r.orgId) ?? 0) + r.cents);
  }

  const rows = await Promise.all(clients.map(async (c) => {
    const s = standings.get(c.id);
    const { policy } = await billingContext(c.id);
    const agr = inForce.find((a) => a.orgId === c.id);
    const tax = sites.filter((x) => x.orgId === c.id).map((x) => x.taxRateBps).find((b) => b > 0) ?? 0;
    const tone: "bad" | "warn" | "good" = s?.onHold ? "bad" : s && s.oldestDaysLate > 0 ? "warn" : "good";
    const label = s?.onHold ? "On hold" : s?.override ? "Held, overridden" : s && s.oldestDaysLate > 0 ? `${s.oldestDaysLate}d past due` : "In good standing";
    return { c, s, policy, agr, tax, tone, label, open: openBy.get(c.id) ?? { n: 0, cents: 0 }, quoted: quotedBy.get(c.id) ?? 0 };
  }));
  const order = { bad: 0, warn: 1, good: 2 };
  rows.sort((a, b) => order[a.tone] - order[b.tone] || b.open.cents - a.open.cents);

  const detail = openOrg === null ? null : rows.find((r) => r.c.id === openOrg) ?? null;
  const detailHistory = detail
    ? entries({ tenant: mine, refOrgId: detail.c.id, account: "receivable", liveOnly: true }, 8)
    : Promise.resolve([]);
  const detailRows = f.receivables.filter((r) => detail && r.orgId === detail.c.id && (r.stage === "current" || r.stage === "pastdue"));

  // The contracts, as the Contracts room drew them.
  const [cards, systemRows, awardRows, brand, provNames] = await Promise.all([
    db.select().from(rateCards).where(forTenant(rateCards.tenantOrgId, mine)),
    db.select({ id: instruments.id, ownerOrgId: instruments.ownerOrgId, externalId: instruments.externalId, model: instruments.model })
      .from(instruments).where(forTenant(instruments.tenantOrgId, mine)).orderBy(asc(instruments.externalId)),
    awardsFor(mine),
    brandForTenant(mine),
    providerNames(agreementRows),
  ]);
  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));
  const nothing = { partsCents: 0, visits: 0, laborMinutes: 0, pmPartsCents: 0 };
  const shaped = agreementRows.map((r) => ({
    id: r.id, orgId: r.orgId, orgName: orgName.get(r.orgId) ?? "an organization",
    kind: r.kind, number: r.number, title: r.title, status: r.status,
    startsOn: r.startsOn, endsOn: r.endsOn, renewNoticeDays: r.renewNoticeDays,
    visitsIncluded: r.visitsIncluded, partsAllowanceCents: r.partsAllowanceCents,
    laborIncludedMinutes: r.laborIncludedMinutes,
    visitsUnlimited: r.visitsUnlimited, partsUnlimited: r.partsUnlimited, laborUnlimited: r.laborUnlimited,
    pmPartsIncluded: r.pmPartsIncluded, includedKits: r.includedKits,
    hourlyRateCents: r.hourlyRateCents, instrumentIds: r.instrumentIds,
    providerName: providerNameOf(r.providerOrgId, provNames),
    valueCents: r.valueCents, note: r.note,
    used: usage.get(r.id) ?? nothing,
  }));
  const shapedInForce = shaped.filter((a) => ["active", "expiring"].includes(agreementStanding(a, today)));
  const ended = shaped.filter((a) => ["expired", "cancelled"].includes(agreementStanding(a, today)));
  const facet = sp.f ?? "";
  const shown = facet === "ended" ? ended : facet === "all" ? shaped : shapedInForce;
  const inForceIds = new Set(shapedInForce.map((a) => a.id));
  const papers = agreementRows.length
    ? (await db.select({
        id: attachments.id, agreementId: attachments.agreementId, fileName: attachments.fileName, kind: attachments.kind,
        size: attachments.size, uploadedBy: attachments.uploadedBy, createdAt: attachments.createdAt,
      }).from(attachments).where(inArray(attachments.agreementId, agreementRows.map((r) => r.id))).orderBy(asc(attachments.createdAt)))
      .map((a) => ({ id: a.id, agreementId: a.agreementId!, fileName: a.fileName, kind: a.kind, size: a.size, uploadedBy: a.uploadedBy, when: shopDay(a.createdAt) }))
    : [];
  const retainers = agreementRows.filter((r) => inForceIds.has(r.id)).map((r) => ({
    id: r.id, orgId: r.orgId, orgName: orgName.get(r.orgId) ?? "an organization",
    number: r.number, title: r.title, status: r.status, startsOn: r.startsOn, endsOn: r.endsOn,
    billEveryMonths: r.billEveryMonths, billAmountCents: r.billAmountCents, billDescription: r.billDescription,
    billDayOfMonth: r.billDayOfMonth, billLeadDays: r.billLeadDays, billNextOn: r.billNextOn, billLastOn: r.billLastOn,
  }));
  const extra: Record<number, string> = {};
  for (const a of shapedInForce) {
    const rate = resolveRate(cards, { orgId: a.orgId, agreementId: a.id });
    const renewal = renewalFromBurn({ visitsUsed: a.used.visits, partsCents: a.used.partsCents, laborMinutes: a.used.laborMinutes, hourlyCents: rate.hourlyCents });
    if (renewal.valueCents > 0) extra[a.id] = `Renewal at this term's usage: ${formatCents(renewal.valueCents)}`;
  }
  const systems = systemRows.filter((r) => r.ownerOrgId !== null).map((r) => ({ id: r.id, ownerOrgId: r.ownerOrgId, externalId: r.externalId, label: r.model }));
  const hist = await detailHistory;

  return (
    <FinanceShell
      rail={rail} active="clients"
      period={period}
      path="/money/clients"
      title="Clients"
      sub={`Who owes what, who is on hold, and what they see · ${periodSpan(today, period)}`}
    >
      <div className="panel">
        <div className="ph"><h2>Standing</h2><span className="t-meta mut">the hold rule is each client&apos;s billing policy · the scheduler reads this, not a person</span></div>
        <div className="tblwrap">
          <table className="list">
            <thead><tr><th>Client</th><th>Standing</th><th className="r">Owes</th><th>Terms</th><th>Agreement</th><th className="r">Quoted</th><th></th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} className="empty">No clients yet.</td></tr>}
              {rows.map(({ c, s, policy, agr, tax, tone, label, open, quoted }) => {
                const used = agr ? usage.get(agr.id)?.partsCents ?? 0 : 0;
                return (
                  <tr key={c.id} className="row">
                    <td><Link className="plain" href={`/money/clients?org=${c.id}`} style={{ fontWeight: 600 }}>{c.name}</Link></td>
                    <td>
                      <span className={`stand ${tone}`}><i />{label}</span>
                      {s?.override && <span className="meta">until {s.override.untilOn || "lifted"}: {s.override.reason}</span>}
                    </td>
                    <td className={`num${tone === "bad" ? " fig bad" : ""}`}>
                      <Figure cents={open.cents} filter={{ acct: "receivable", org: c.id }} tone={tone === "bad" ? "bad" : undefined} />
                      <span className="meta">{open.n} open</span>
                    </td>
                    <td>Net {c.termsDays}<span className="meta">hold at {policy.holdDays}d · tax {(tax / 100).toFixed(2)}%</span></td>
                    <td>
                      {agr ? <><Id>{agr.number}</Id><span className="meta">
                        {agr.partsUnlimited ? "parts unlimited" : `allowance ${formatCents(Math.max(0, agr.partsAllowanceCents - used))} left of ${formatCents(agr.partsAllowanceCents)}`}
                      </span></> : <span className="meta">time and materials</span>}
                    </td>
                    <td className="num">{quoted ? formatCents(quoted) : ""}</td>
                    <td className="acts"><Link className="btn sm" href={`/money/clients?org=${c.id}&view=theirs`}>Statement</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {detail && (
        <div className="panel">
          <div className="ph">
            <h2>{detail.c.name} <span className={`stand ${detail.tone} t-small`} style={{ fontWeight: 400 }}><i />{detail.label}</span></h2>
            <div className="seg" role="group" aria-label="View">
              <Link href={`/money/clients?org=${detail.c.id}`} aria-current={!theirView ? "true" : undefined}>Our view</Link>
              <Link href={`/money/clients?org=${detail.c.id}&view=theirs`} aria-current={theirView ? "true" : undefined}>What they see</Link>
            </div>
          </div>
          <div className="pb">
            {theirView ? (
              <div className="portal">
                <div className="ph2"><b>{brand.operatorName}</b><span className="meta">Statement for {detail.c.name}</span></div>
                <table className="list"><tbody>
                  {detailRows.length === 0 && <tr><td className="mut">Nothing open. Thank you.</td></tr>}
                  {detailRows.map((r) => (
                    <tr key={r.doc}>
                      <td><Id>{r.doc}</Id><span className="meta">{r.title} · due {r.sort}{r.pastDue ? " · past due" : ""}{r.disputed ? " · question open" : ""}</span></td>
                      <td className="num">{formatCents(r.cents)}</td>
                    </tr>
                  ))}
                  <tr><td><b>Balance due</b></td><td className="num"><b>{formatCents(detail.open.cents)}</b></td></tr>
                </tbody></table>
                {detail.agr && (
                  <p className="t-small" style={{ margin: "10px 0 0" }}>
                    <b>{detail.agr.number}</b> · {detail.agr.partsUnlimited ? "parts unlimited" : `parts allowance: ${formatCents(Math.max(0, detail.agr.partsAllowanceCents - (usage.get(detail.agr.id)?.partsCents ?? 0)))} remaining of ${formatCents(detail.agr.partsAllowanceCents)} this term`}.
                    {detail.agr.billNextOn ? ` Next installment ${detail.agr.billNextOn}.` : ""}
                  </p>
                )}
                <p className="t-meta mut" style={{ margin: "10px 0 0" }}>
                  Questions about a line go to the shop from the invoice itself. Paying is Stripe Connect; {brand.operatorName} never holds the card.
                </p>
              </div>
            ) : (
              <>
                <table className="list"><tbody>
                  {detailRows.length === 0 && <tr><td className="mut">Nothing open.</td></tr>}
                  {detailRows.map((r) => (
                    <tr key={r.doc}>
                      <td><Link className="plain doc" href={r.href}><Id>{r.doc}</Id></Link><span className="meta">{r.title} · due {r.sort}</span></td>
                      <td className={`num${r.pastDue ? " fig bad" : ""}`}>{formatCents(r.cents)}</td>
                    </tr>
                  ))}
                  <tr><td><b>Owes</b></td><td className="num"><b>{formatCents(detail.open.cents)}</b></td></tr>
                </tbody></table>
                <div className="card" style={{ marginTop: 12 }}>
                  <div className="card-title">Credit hold</div>
                  <p className="t-small" style={{ margin: "6px 0" }}>
                    {detail.s?.onHold
                      ? `On hold: ${detail.s.line} Scheduling new work is blocked until this is paid or overridden.`
                      : detail.s?.override
                        ? `Overridden${detail.s.override.untilOn ? ` until ${detail.s.override.untilOn}` : ""} by ${detail.s.override.grantedBy}: "${detail.s.override.reason}"`
                        : detail.s && detail.s.oldestDaysLate > 0
                          ? `${detail.s.oldestDaysLate} days past due; the hold begins at ${detail.policy.holdDays}.`
                          : "In good standing."}
                  </p>
                  {detail.s && (detail.s.onHold || detail.s.override) && (
                    <CreditOverrideButton orgId={detail.c.id} orgName={detail.c.name} overridden={!!detail.s.override}
                      canOverride={user.role === "owner"}
                      depositCents={depositToClear({ policy: detail.policy, openInvoices: detailRows.map((r) => ({ balanceCents: r.cents, daysLate: r.pastDue ? 1 : 0 })) })} />
                  )}
                </div>
                <h3 className="t-lead" style={{ marginTop: 16 }}>Statement history</h3>
                <table className="list"><tbody>
                  {hist.length === 0 && <tr><td className="mut">Nothing posted yet.</td></tr>}
                  {hist.map((e) => (
                    <tr key={e.id}><td className="t-small mut" style={{ width: 90 }}>{e.postedOn}</td><td>{e.memo}</td><td className="num">{formatCents(e.totalCents)}</td></tr>
                  ))}
                </tbody></table>
                <Link className="btn sm" style={{ marginTop: 8 }} href={`/money/ledger?org=${detail.c.id}`}>Open in ledger</Link>
              </>
            )}
          </div>
        </div>
      )}

      <div className="panel ghost">
        <div className="pb">
          <b>What the client gets:</b> a statement, a pay link on every invoice, a place to question a line, and their allowance balance.
          {" "}<b>What waits for Craton:</b> a funded pocket they can watch draw down, and escrow on an instrument purchase through a broker.
        </div>
      </div>

      <div className="facets" style={{ marginBottom: 12 }}>
        <Link className={`facet${facet === "" ? " on" : ""}`} href="/money/clients">In force<b>{shapedInForce.length}</b></Link>
        <Link className={`facet${facet === "ended" ? " on" : ""}`} href="/money/clients?f=ended">Ended<b>{ended.length}</b></Link>
        <Link className={`facet${facet === "all" ? " on" : ""}`} href="/money/clients?f=all">All<b>{shaped.length}</b></Link>
      </div>
      <AwardLadder awards={awardRows} today={today} canEdit />
      <RetainerCard rows={retainers} today={today} canEdit />
      <AgreementsPanel
        operatorName={brand.operatorName}
        rows={shown} today={today} systems={systems} orgs={clients.map((o) => ({ id: o.id, name: o.name }))} papers={papers}
        canEdit extra={extra}
        title={facet === "ended" ? "Ended" : facet === "all" ? "All contracts" : "In force"}
      />
      {rows.some((r) => r.s?.onHold) && <Pill tone="bad">{rows.filter((r) => r.s?.onHold).length} on hold</Pill>}
    </FinanceShell>
  );
}
