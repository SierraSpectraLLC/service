import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { instruments, orgSites } from "@/db/schema";
import { navSection } from "@/lib/navData";
import { mayAdminOrg, tenantViewer } from "@/lib/tenants";
import { requireOrgAdmin } from "@/lib/orgAdmin";
import SectionShell from "@/components/SectionShell";
import SitesCard from "@/components/SitesCard";

export const dynamic = "force-dynamic";

/**
 * The company's own site locations: the shop, the offices, the yard - the
 * places an employee is stationed at and a trip starts from.
 *
 * The same rows, card and actions a client's labs use (org_sites, keyed on
 * the workspace's own organization), reached from the organization section
 * rather than from the organization's Settings page, where they sat beside
 * the billing address looking like part of invoicing. Editing is the owner's
 * (assertOrgConfigurable, in the actions); HR reads them, because "where is
 * Bill stationed" needs the list and not the pencil.
 */
export default async function OrganizationSitesPage() {
  const { user, org } = await requireOrgAdmin();
  const section = await navSection("org");
  const canEdit = mayAdminOrg(tenantViewer(user), org);

  const [siteRows, siteSystems] = await Promise.all([
    db.select().from(orgSites).where(eq(orgSites.orgId, org.id))
      .orderBy(asc(orgSites.name), asc(orgSites.id)),
    db.select({ siteId: instruments.siteId }).from(instruments).where(eq(instruments.ownerOrgId, org.id)),
  ]);

  return (
    <SectionShell section={section} active="/organization/sites"
      title="Site locations"
      sub={`Where ${org.name} is. An employee's staffed location is one of these.`}>
      <SitesCard orgId={org.id} orgName={org.name} billingAddress={org.billingAddress}
        contactEmail={org.contactEmail}
        showBilling={false} canEdit={canEdit}
        sites={siteRows.map((r) => ({
          id: r.id, name: r.name, address: r.address, accessNotes: r.accessNotes,
          contactName: r.contactName, contactPhone: r.contactPhone, contactEmail: r.contactEmail,
          archived: r.archived, onewayMiles: r.onewayMiles,
          systems: siteSystems.filter((s) => s.siteId === r.id).length,
        }))} />
    </SectionShell>
  );
}
