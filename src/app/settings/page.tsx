import { asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { appSettings, orgs } from "@/db/schema";
import { requirePlatformOwner } from "@/lib/authz";
import { getStageDefs } from "@/lib/stageDefs";
import { viewTenant, visibleOrgs } from "@/lib/tenancy";
import SettingsTabs from "@/components/SettingsTabs";
import ConfigurationForm from "@/components/ConfigurationForm";

export const dynamic = "force-dynamic";

/** Settings > Configuration: the instance, not the people or the equipment. */
export default async function SettingsPage() {
  let user;
  // The instance's own settings - its name, its modules, which organization runs
  // it. Another operator's owner runs a workspace, not the platform, so they land
  // on the tab that is theirs instead.
  try { user = await requirePlatformOwner(); } catch { redirect("/settings/personnel"); }
  const [[s], stageDefList, orgRows] = await Promise.all([
    db.select().from(appSettings).where(eq(appSettings.id, 1)),
    getStageDefs(await viewTenant(user)),
    visibleOrgs(user),
  ]);
  return (
    <div className="container settings">
      <SettingsTabs active="configuration" />
      <ConfigurationForm
        stageDefs={stageDefList}
        orgs={orgRows.map((o) => ({ id: o.id, name: o.name, kind: o.kind }))}
        platformName={s?.platformName ?? ""}
        platformTagline={s?.platformTagline ?? ""}
        operatorOrgId={s?.operatorOrgId ?? null}
        modules={{ sheetSync: s?.sheetSyncEnabled ?? false, eod: s?.eodEnabled ?? false, digest: s?.digestEnabled ?? false, remote: s?.remoteEnabled ?? false }}
      />
    </div>
  );
}
