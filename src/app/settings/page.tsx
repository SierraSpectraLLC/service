import { asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { appSettings, orgs } from "@/db/schema";
import { requireOwner } from "@/lib/authz";
import { getStageDefs } from "@/lib/stageDefs";
import SettingsTabs from "@/components/SettingsTabs";
import ConfigurationForm from "@/components/ConfigurationForm";

export const dynamic = "force-dynamic";

/** Settings > Configuration: the instance, not the people or the equipment. */
export default async function SettingsPage() {
  try { await requireOwner(); } catch { redirect("/"); }
  const [[s], stageDefList, orgRows] = await Promise.all([
    db.select().from(appSettings).where(eq(appSettings.id, 1)),
    getStageDefs(),
    db.select().from(orgs).orderBy(asc(orgs.kind), asc(orgs.name)),
  ]);
  return (
    <div className="container page">
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
