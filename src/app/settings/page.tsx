import { asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { appSettings, vocabTerms, assets, orgs } from "@/db/schema";
import { MODULE_KINDS } from "@/lib/stages";
import { requireOwner } from "@/lib/authz";
import { getStageDefs } from "@/lib/stageDefs";
import SettingsTabs from "@/components/SettingsTabs";
import ConfigurationForm from "@/components/ConfigurationForm";

export const dynamic = "force-dynamic";

/** Settings > Configuration: the instance, not the people on it. */
export default async function SettingsPage() {
  try { await requireOwner(); } catch { redirect("/"); }
  const [[s], stageDefList, vocabRows, kindRows, orgRows] = await Promise.all([
    db.select().from(appSettings).where(eq(appSettings.id, 1)),
    getStageDefs(),
    db.select().from(vocabTerms).orderBy(asc(vocabTerms.kind), asc(vocabTerms.assetType), asc(vocabTerms.name)),
    db.selectDistinct({ kind: assets.kind }).from(assets),
    db.select().from(orgs).orderBy(asc(orgs.kind), asc(orgs.name)),
  ]);
  return (
    <div className="container" style={{ maxWidth: 620 }}>
      <SettingsTabs active="configuration" />
      <ConfigurationForm
        stageDefs={stageDefList}
        orgs={orgRows.map((o) => ({ id: o.id, name: o.name, kind: o.kind }))}
        platformName={s?.platformName ?? ""}
        platformTagline={s?.platformTagline ?? ""}
        operatorOrgId={s?.operatorOrgId ?? null}
        modules={{ sheetSync: s?.sheetSyncEnabled ?? false, eod: s?.eodEnabled ?? false, digest: s?.digestEnabled ?? false }}
        vocab={vocabRows.map((v) => ({ id: v.id, kind: v.kind, assetType: v.assetType, name: v.name }))}
        assetTypes={[...new Set([...MODULE_KINDS, ...kindRows.map((k) => k.kind)].filter(Boolean))]}
      />
    </div>
  );
}
