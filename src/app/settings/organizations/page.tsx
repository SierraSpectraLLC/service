import { and, asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { appSettings, clientAllowlist, houseMembers, orgSites, orgs, systemShares, users } from "@/db/schema";
import { requireOwner } from "@/lib/authz";
import { isPlatformStaff, tenantViewer } from "@/lib/tenants";
import { forTenant, readTenant, visibleOrgs } from "@/lib/tenancy";
import PersonnelForm from "@/components/PersonnelForm";
import { visibleDirectory } from "@/lib/directory";

export const dynamic = "force-dynamic";

/** Settings > Organizations: who is on this instance, and who can be tagged. */
export default async function OrganizationsPage({ searchParams }: { searchParams: Promise<{ q?: string; kind?: string }> }) {
  const filter = await searchParams;
  let user;
  try { user = await requireOwner(); } catch { redirect("/"); }
  const isPlatform = isPlatformStaff(tenantViewer(user));
  const tenant = readTenant(user);
  const [[s], allowRows, directory, orgRows, shareCounts, userRows, houseRows, siteRows] = await Promise.all([
    db.select().from(appSettings).where(eq(appSettings.id, 1)),
    db.select().from(clientAllowlist).orderBy(asc(clientAllowlist.entry)),
    // Assembled from the logins that exist rather than typed in here. See
    // lib/directory - this page shows it, nobody curates it.
    visibleDirectory(user),
    visibleOrgs(user),
    // How much each org can reach, so its row states the consequence of removal.
    db.select({ orgId: systemShares.orgId }).from(systemShares),
    db.select({
      email: users.email, firstName: users.firstName, lastName: users.lastName,
      title: users.title, siteId: users.siteId,
    }).from(users),
    db.select({ email: houseMembers.email, orgId: houseMembers.orgId }).from(houseMembers),
    // Site names go to the form whole, so this one is shipped rather than
    // merely joined against - another company's addresses, unfiltered.
    db.select({ id: orgSites.id, orgId: orgSites.orgId, name: orgSites.name })
      .from(orgSites)
      .where(and(eq(orgSites.archived, false), forTenant(orgSites.tenantOrgId, tenant)))
      .orderBy(asc(orgSites.name)),
  ]);

  // The directory rows, thickened into editable people: the profile off the
  // users row, and the handle that decides which org they belong to - an
  // allowlist row for a client login, a house membership for staff.
  // An allowlist row with no organization carries no tenant stamp either -
  // clientAllowlist has none - so there is nothing on it that says whose
  // invitation it was. Unassigned addresses therefore belong to whoever runs
  // the instance, and an operator's owner is shown none of them rather than
  // all of them. Failing closed is the only honest reading of a missing scope.
  const orphanRows = isPlatform ? allowRows.filter((r) => r.orgId === null) : [];
  const profile = new Map(userRows.map((r) => [r.email.trim().toLowerCase(), r]));
  const houseOrg = new Map(houseRows.map((r) => [r.email.trim().toLowerCase(), r.orgId]));
  const allowByEmail = new Map(allowRows.map((r) => [r.entry.trim().toLowerCase(), r]));
  const people = directory.map((p) => {
    const key = p.email.trim().toLowerCase();
    const prof = profile.get(key);
    const allow = allowByEmail.get(key);
    return {
      name: p.name, email: p.email, org: p.org,
      firstName: prof?.firstName ?? "", lastName: prof?.lastName ?? "",
      title: prof?.title ?? "", siteId: prof?.siteId ?? null,
      allowlistId: allow?.id ?? null,
      orgId: allow?.orgId ?? houseOrg.get(key) ?? null,
      isStaff: houseOrg.has(key),
    };
  });
  return (
    <div>
      <PersonnelForm
        isPlatform={isPlatform}
        clientAccessEnabled={s?.clientAccessEnabled ?? false}
        orgs={orgRows.map((o) => ({
          id: o.id, name: o.name, kind: o.kind, themeColor: o.themeColor, recipients: o.eodRecipients,
          systems: shareCounts.filter((c) => c.orgId === o.id).length,
          logins: allowRows.filter((r) => r.orgId === o.id).length,
          editors: allowRows.filter((r) => r.orgId === o.id && r.canEdit).length,
        }))}
        orphans={orphanRows.map((r) => ({ id: r.id, entry: r.entry }))}
        directory={people}
        sites={siteRows}
        filter={{ q: filter.q ?? "", kind: filter.kind ?? "" }}
        operatorOrgId={s?.operatorOrgId ?? null}
        sheetOrgId={s?.sheetOrgId ?? null}
        showRecipients={s?.eodEnabled ?? false}
        showSheetSync={s?.sheetSyncEnabled ?? false}
      />
    </div>
  );
}
