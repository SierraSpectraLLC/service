import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orgs, providerLinks, providerProfiles } from "@/db/schema";
import { requireUser, myTenantOrgId } from "@/lib/authz";
import { listings, sharesFor } from "@/lib/clientShareData";
import { billableOrgs, feesFor } from "@/lib/referralData";
import { leadsFor } from "@/lib/leadData";
import { shopToday } from "@/lib/shopday";
import { PageHead } from "@/components/ui";
import ProviderProfileForm from "@/components/ProviderProfileForm";
import ProviderDirectory from "@/components/ProviderDirectory";
import ClientShareBoard from "@/components/ClientShareBoard";
import ReferralLedger from "@/components/ReferralLedger";
import LeadBoard from "@/components/LeadBoard";

export const dynamic = "force-dynamic";

/**
 * The other service companies.
 *
 * One room for the three things that are really one thing: how this shop is
 * listed, who it works with, and the clients moving between them. They were
 * never going to be three pages - a person opens this because somebody handed
 * them a client, or because they are looking for a shop in Spokane, and both
 * questions are about the same handful of companies.
 *
 * The owner's room, and nobody else's. Everything in it names a company the
 * owner deals with: the shortlist they added, the directory it is picked from,
 * the clients and leads they have offered out, the shops they have invited,
 * the offers other companies have made them, and the referral money either
 * way. Who the owner deals with is not the engineers' to read - not the
 * outbound half, and not the offers coming in either, because an offer names
 * the company making it and taking it on is the owner's decision. The
 * notifications say the same: every kind that arrives here is owner-tier in
 * lib/inbox, so an engineer is neither shown this room nor told what lands in
 * it.
 */
export default async function NetworkPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (user.role !== "owner") redirect("/");
  const mine = myTenantOrgId(user);
  if (mine === null) redirect("/");

  const [all, links, shares, profileRow, meRow, fees, leadRows, billable] = await Promise.all([
    listings(),
    db.select({ providerOrgId: providerLinks.providerOrgId, note: providerLinks.note })
      .from(providerLinks).where(eq(providerLinks.tenantOrgId, mine)),
    sharesFor(mine),
    db.select().from(providerProfiles).where(eq(providerProfiles.orgId, mine)).then((r) => r[0] ?? null),
    db.select({ name: orgs.name }).from(orgs).where(and(eq(orgs.id, mine))).then((r) => r[0] ?? null),
    feesFor(mine),
    leadsFor(mine),
    billableOrgs(mine),
  ]);

  const linked = new Set(links.map((l) => l.providerOrgId));
  // Never ourselves: a shop does not add itself to its own address book, and
  // sharing a client with yourself is the one move that means nothing.
  const others = all.filter((l) => l.orgId !== mine);

  return (
    <div className="container">
      <PageHead
        title="Service companies"
        sub="Who else is out there, who you work with, and the clients moving between you."
      />

      <ClientShareBoard inbox={shares.inbox} sent={shares.sent} today={shopToday()} />

      <LeadBoard mine={leadRows.mine} offered={leadRows.offered}
        providers={others.filter((l) => linked.has(l.orgId)).map((l) => ({ id: l.orgId, name: l.name }))} />

      <ReferralLedger earned={fees.earned} owed={fees.owed} today={shopToday()}
        canPay clients={billable.clients} />

      <ProviderDirectory
        listings={others}
        linked={[...linked]}
        notes={Object.fromEntries(links.map((l) => [l.providerOrgId, l.note]))}
      />

      <ProviderProfileForm
        orgName={meRow?.name ?? "This workspace"}
        canEdit
        profile={{
          listed: profileRow?.listed ?? false,
          blurb: profileRow?.blurb ?? "",
          services: (profileRow?.services ?? []).join(", "),
          regions: (profileRow?.regions ?? []).join(", "),
          contactName: profileRow?.contactName ?? "",
          contactEmail: profileRow?.contactEmail ?? "",
          contactPhone: profileRow?.contactPhone ?? "",
          website: profileRow?.website ?? "",
        }}
      />
    </div>
  );
}
