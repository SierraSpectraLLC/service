import { asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { appSettings, orgs } from "@/db/schema";
import { myTenantOrgId, requirePlatformOwner } from "@/lib/authz";
import { houseEmails } from "@/lib/house";
import { getStageDefs } from "@/lib/stageDefs";
import { getAppearance } from "@/lib/appearanceData";
import { viewTenant, visibleOrgs } from "@/lib/tenancy";
import ConfigurationForm from "@/components/ConfigurationForm";

export const dynamic = "force-dynamic";

/** Settings > Configuration: the instance, not the people or the equipment. */
export default async function SettingsPage() {
  let user;
  // The instance's own settings - its name, its modules, which organization runs
  // it. Another operator's owner runs a workspace, not the platform, so they land
  // on the tab that is theirs instead.
  try { user = await requirePlatformOwner(); } catch { redirect("/settings/organizations"); }
  const [[s], stageDefList, orgRows, digestTo] = await Promise.all([
    db.select().from(appSettings).where(eq(appSettings.id, 1)),
    getStageDefs(await viewTenant(user)),
    visibleOrgs(user),
    houseEmails(myTenantOrgId(user)),
  ]);
  const look = await getAppearance();
  // The internal digest's hour lives on the operator's org row, or on the
  // settings singleton where no operator has been named. Read from the row
  // itself rather than from the visible-orgs list, which is scoped for display
  // and is not where setDigestHour writes - a mismatch there would show one
  // hour and save another.
  const operatorRow = s?.operatorOrgId === null || s?.operatorOrgId === undefined
    ? undefined
    : (await db.select({ digestHour: orgs.digestHour, digestDays: orgs.digestDays })
        .from(orgs).where(eq(orgs.id, s.operatorOrgId)))[0];
  const digestHour = operatorRow?.digestHour ?? s?.digestHour ?? 7;
  const digestDays = operatorRow?.digestDays ?? s?.digestDays ?? "";
  return (
    <div>
      <ConfigurationForm
        stageDefs={stageDefList}
        orgs={orgRows.map((o) => ({ id: o.id, name: o.name, kind: o.kind }))}
        platformName={s?.platformName ?? ""}
        platformTagline={s?.platformTagline ?? ""}
        publicContactEmail={s?.publicContactEmail ?? ""}
        operatorOrgId={s?.operatorOrgId ?? null}
        digestHour={digestHour}
        digestDays={digestDays}
        digestTo={digestTo}
        appearance={{
          headerColor: look.storedHeaderColor,
          spectrumHeight: look.spectrumHeight,
          spectrumStops: look.spectrumStops,
        }}
        modules={{ sheetSync: s?.sheetSyncEnabled ?? false, eod: s?.eodEnabled ?? false, digest: s?.digestEnabled ?? false, remote: s?.remoteEnabled ?? false, publicCatalog: s?.publicCatalogEnabled ?? false }}
      />
    </div>
  );
}
