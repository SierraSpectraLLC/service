import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { instruments, orgs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { quoteById } from "@/lib/invoiceData";
import { proposalForQuote } from "@/lib/proposalData";
import ProposalBuilder from "@/components/ProposalBuilder";
import StartProposalButton from "@/components/StartProposalButton";
import { EmptyState, Id, PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The long document for one quote, edited.
 *
 * A quote is a price; this is the argument for it. The words start as the
 * house template - see lib/proposal - copied in at creation rather than read
 * live, so improving a sentence next quarter cannot rewrite what a client
 * already read.
 */
export default async function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const id = parseInt((await params).id, 10);
  if (!Number.isInteger(id)) notFound();

  const full = await quoteById(id);
  if (!full) notFound();
  const [org, p] = await Promise.all([
    db.select().from(orgs).where(eq(orgs.id, full.row.orgId)).then((r) => r[0] ?? null),
    proposalForQuote(id),
  ]);

  const crumb = (
    <div className="crumb">
      <Link href="/money">Financial</Link> › <Link href="/money/quotes">Quotes</Link> ›{" "}
      <Link href={`/money/quotes/${id}`}>{full.row.number}</Link> › <b>Proposal</b>
    </div>
  );

  if (!p) {
    return (
      <div className="container">
        {crumb}
        <PageHead title="Service proposal" sub={`The long document behind ${full.row.number}.`} />
        <EmptyState
          title="No proposal yet"
          body="Start one and it arrives filled in with the house template - the parts policy, the geography, the compliance section and the terms - plus the four standard coverage tiers, ready to price. Everything is yours to edit from there."
          action={<StartProposalButton quoteId={id} />}
        />
      </div>
    );
  }

  // Their own machines, so adding a covered system is a pick and not a retype.
  const fleet = await db.select().from(instruments)
    .where(and(eq(instruments.ownerOrgId, full.row.orgId), eq(instruments.archived, false)))
    .catch(() => []);

  return (
    <div className="container">
      {crumb}
      <PageHead
        title={<>Service proposal <Id>{p.row.number}</Id></>}
        sub={`${org?.name ?? "The client"} · behind quote ${full.row.number}`}
        actions={
          <a className="btn sm primary" href={`/money/quotes/${id}/proposal/print`}>Read it as paper</a>
        }
      />
      <ProposalBuilder
        proposalId={p.row.id}
        quoteId={id}
        header={{
          title: p.row.title, subtitle: p.row.subtitle,
          pricingValid: p.row.pricingValid, recommendedTier: p.row.recommendedTier,
        }}
        systems={p.systems.map((s) => ({
          instrumentId: s.instrumentId, name: s.name, model: s.model, note: s.note,
        }))}
        tiers={p.tiers.map((t) => ({
          key: t.key, name: t.name, annualCents: t.annualCents, bestFor: t.bestFor,
          includes: t.includes, notIncluded: t.notIncluded, features: t.features,
        }))}
        sections={p.sections.map((s) => ({ kind: s.kind, heading: s.heading, body: s.body }))}
        /* Their own machines, named the way the fleet page names them: the
           chosen name where there is one, the legacy description otherwise,
           and the tag either way so two LC-MS systems are tellable apart. */
        fleet={fleet.map((i) => ({
          id: i.id,
          label: [i.name.trim() || i.model.trim(), i.externalId].filter(Boolean).join(" · "),
          model: i.model,
        }))}
      />
    </div>
  );
}
