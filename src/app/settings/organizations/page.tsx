import { asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { appSettings, clientAllowlist, orgs, systemShares } from "@/db/schema";
import { requireOwner } from "@/lib/authz";
import { isPlatformStaff, tenantViewer } from "@/lib/tenants";
import { forTenant, readTenant, visibleOrgs } from "@/lib/tenancy";
import SettingsTabs from "@/components/SettingsTabs";
import PersonnelForm from "@/components/PersonnelForm";
import { visibleDirectory } from "@/lib/directory";

export const dynamic = "force-dynamic";

/** Settings > Organizations: who is on this instance, and who can be tagged. */
export default async function OrganizationsPage() {
  let user;
  try { user = await requireOwner(); } catch { redirect("/"); }
  const isPlatform = isPlatformStaff(tenantViewer(user));
  const [[s], allowRows, directory, orgRows, shareCounts] = await Promise.all([
    db.select().from(appSettings).where(eq(appSettings.id, 1)),
    db.select().from(clientAllowlist).orderBy(asc(clientAllowlist.entry)),
    // Assembled from the logins that exist rather than typed in here. See
    // lib/directory - this page shows it, nobody curates it.
    visibleDirectory(user),
    visibleOrgs(user),
    // How much each org can reach, so its row states the consequence of removal.
    db.select({ orgId: systemShares.orgId }).from(systemShares),
  ]);
  return (
    <div className="container settings">
      <SettingsTabs active="organizations" isPlatform={isPlatform} />
      <PersonnelForm
        clientAccessEnabled={s?.clientAccessEnabled ?? false}
        orgs={orgRows.map((o) => ({
          id: o.id, name: o.name, kind: o.kind, themeColor: o.themeColor, recipients: o.eodRecipients,
          systems: shareCounts.filter((c) => c.orgId === o.id).length,
          logins: allowRows.filter((r) => r.orgId === o.id).length,
          editors: allowRows.filter((r) => r.orgId === o.id && r.canEdit).length,
        }))}
        orphans={allowRows.filter((r) => r.orgId === null).map((r) => ({ id: r.id, entry: r.entry }))}
        directory={directory}
        operatorOrgId={s?.operatorOrgId ?? null}
        sheetOrgId={s?.sheetOrgId ?? null}
        showRecipients={s?.eodEnabled ?? false}
        showSheetSync={s?.sheetSyncEnabled ?? false}
      />
    </div>
  );
}
