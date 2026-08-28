import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orgs, providerLinks, providerProfiles } from "@/db/schema";
import { requireUser, myTenantOrgId } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { listings, sharesFor } from "@/lib/clientShareData";
import { feesFor } from "@/lib/referralData";
import { shopToday } from "@/lib/shopday";
import { PageHead } from "@/components/ui";
import ProviderProfileForm from "@/components/ProviderProfileForm";
import ProviderDirectory from "@/components/ProviderDirectory";
import ClientShareBoard from "@/components/ClientShareBoard";
import ReferralLedger from "@/components/ReferralLedger";

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
 * Staff, not owner: taking on work that has been offered is a shop decision.
 * Publishing the listing is the owner's alone, and the form says so.
 */
export default async function NetworkPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const mine = myTenantOrgId(user);
  if (mine === null) redirect("/");

  const [all, links, shares, profileRow, meRow, fees] = await Promise.all([
    listings(),
    db.select({ providerOrgId: providerLinks.providerOrgId, note: providerLinks.note })
      .from(providerLinks).where(eq(providerLinks.tenantOrgId, mine)),
    sharesFor(mine),
    db.select().from(providerProfiles).where(eq(providerProfiles.orgId, mine)).then((r) => r[0] ?? null),
    db.select({ name: orgs.name }).from(orgs).where(and(eq(orgs.id, mine))).then((r) => r[0] ?? null),
    feesFor(mine),
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

      <ClientShareBoard inbox={shares.inbox} sent={shares.sent} />

      <ReferralLedger earned={fees.earned} owed={fees.owed} today={shopToday()}
        canPay={user.role === "owner"} />

      <ProviderDirectory
        listings={others}
        linked={[...linked]}
        notes={Object.fromEntries(links.map((l) => [l.providerOrgId, l.note]))}
      />

      <ProviderProfileForm
        orgName={meRow?.name ?? "This workspace"}
        canEdit={user.role === "owner"}
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
