import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orgs, providerLinks, providerProfiles } from "@/db/schema";
import { requireUser, myTenantOrgId } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
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
 * Two readers, two halves. INBOUND - clients and leads other companies have
 * offered this shop - is every staff member's: taking on work that has been
 * offered is a shop decision, and the company offering it has already chosen
 * to be named. OUTBOUND is the owner's alone: the shortlist of companies they
 * have added, the directory it is picked from, the clients and leads they have
 * offered out and the invitations they have sent, and the referral money
 * moving either way. Every one of those names a company the owner chose to
 * deal with, and who the owner deals with is not the engineers' to read. So a
 * staff member here sees what has been offered TO the shop and nothing about
 * who the shop has reached out to - not as an empty list, which would still
 * say the list exists, but not at all.
 */
export default async function NetworkPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const mine = myTenantOrgId(user);
  if (mine === null) redirect("/");
  const owner = user.role === "owner";

  const [shares, leadRows, profileRow, meRow] = await Promise.all([
    sharesFor(mine),
    leadsFor(mine),
    db.select().from(providerProfiles).where(eq(providerProfiles.orgId, mine)).then((r) => r[0] ?? null),
    db.select({ name: orgs.name }).from(orgs).where(and(eq(orgs.id, mine))).then((r) => r[0] ?? null),
  ]);
  // The outbound half is not fetched for staff, not merely not rendered: a
  // list that reaches the page reaches the wire.
  const [all, links, fees, billable] = owner
    ? await Promise.all([
      listings(),
      db.select({ providerOrgId: providerLinks.providerOrgId, note: providerLinks.note })
        .from(providerLinks).where(eq(providerLinks.tenantOrgId, mine)),
      feesFor(mine),
      billableOrgs(mine),
    ])
    : [[], [], { earned: [], owed: [] }, { clients: [], peers: [] }];

  const linked = new Set(links.map((l) => l.providerOrgId));
  // Never ourselves: a shop does not add itself to its own address book, and
  // sharing a client with yourself is the one move that means nothing.
  const others = all.filter((l) => l.orgId !== mine);

  return (
    <div className="container">
      <PageHead
        title="Service companies"
        sub={owner
          ? "Who else is out there, who you work with, and the clients moving between you."
          : "Clients and leads other service companies have offered this shop."}
      />

      <ClientShareBoard inbox={shares.inbox} sent={owner ? shares.sent : []} today={shopToday()} />

      <LeadBoard mine={owner ? leadRows.mine : []} offered={leadRows.offered} outbound={owner}
        providers={others.filter((l) => linked.has(l.orgId)).map((l) => ({ id: l.orgId, name: l.name }))} />

      {owner && (
        <>
          <ReferralLedger earned={fees.earned} owed={fees.owed} today={shopToday()}
            canPay clients={billable.clients} />

          <ProviderDirectory
            listings={others}
            linked={[...linked]}
            notes={Object.fromEntries(links.map((l) => [l.providerOrgId, l.note]))}
          />
        </>
      )}

      <ProviderProfileForm
        orgName={meRow?.name ?? "This workspace"}
        canEdit={owner}
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
