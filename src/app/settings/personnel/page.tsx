import { asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { appSettings, clientAllowlist, people, orgs, systemShares } from "@/db/schema";
import { requireOwner } from "@/lib/authz";
import { isPlatformStaff, tenantViewer } from "@/lib/tenants";
import { forTenant, readTenant, visibleOrgs } from "@/lib/tenancy";
import SettingsTabs from "@/components/SettingsTabs";
import PersonnelForm from "@/components/PersonnelForm";

export const dynamic = "force-dynamic";

/** Settings > Personnel: the organizations on this instance and the shop roster. */
export default async function PersonnelPage() {
  let user;
  try { user = await requireOwner(); } catch { redirect("/"); }
  const isPlatform = isPlatformStaff(tenantViewer(user));
  const [[s], allowRows, peopleRows, orgRows, shareCounts] = await Promise.all([
    db.select().from(appSettings).where(eq(appSettings.id, 1)),
    db.select().from(clientAllowlist).orderBy(asc(clientAllowlist.entry)),
    db.select().from(people).where(forTenant(people.tenantOrgId, readTenant(user)))
      .orderBy(asc(people.org), asc(people.name)),
    visibleOrgs(user),
    // How much each org can reach, so its row states the consequence of removal.
    db.select({ orgId: systemShares.orgId }).from(systemShares),
  ]);
  return (
    <div className="container page">
      <SettingsTabs active="personnel" isPlatform={isPlatform} />
      <PersonnelForm
        clientAccessEnabled={s?.clientAccessEnabled ?? false}
        orgs={orgRows.map((o) => ({
          id: o.id, name: o.name, kind: o.kind, themeColor: o.themeColor, recipients: o.eodRecipients,
          systems: shareCounts.filter((c) => c.orgId === o.id).length,
          logins: allowRows.filter((r) => r.orgId === o.id).length,
          editors: allowRows.filter((r) => r.orgId === o.id && r.canEdit).length,
        }))}
        orphans={allowRows.filter((r) => r.orgId === null).map((r) => ({ id: r.id, entry: r.entry }))}
        people={peopleRows.map((p) => ({ id: p.id, name: p.name, email: p.email, org: p.org }))}
        orgNames={[...orgRows.filter((o) => o.id === s?.operatorOrgId), ...orgRows.filter((o) => o.id !== s?.operatorOrgId)].map((o) => o.name)}
        operatorOrgId={s?.operatorOrgId ?? null}
        sheetOrgId={s?.sheetOrgId ?? null}
        showRecipients={s?.eodEnabled ?? false}
        showSheetSync={s?.sheetSyncEnabled ?? false}
      />
    </div>
  );
}
