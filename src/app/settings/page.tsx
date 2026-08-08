import { asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { appSettings, clientAllowlist, people, vocabTerms, assets, orgs, systemShares } from "@/db/schema";
import { MODULE_KINDS } from "@/lib/stages";
import { requireOwner } from "@/lib/authz";
import { parseList } from "@/auth";
import { getStageDefs } from "@/lib/stageDefs";
import SettingsForm from "@/components/SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  try { await requireOwner(); } catch { redirect("/"); }
  const [[s], allowRows, stageDefList, peopleRows, vocabRows, kindRows, orgRows, shareCounts] = await Promise.all([
    db.select().from(appSettings).where(eq(appSettings.id, 1)),
    db.select().from(clientAllowlist).orderBy(asc(clientAllowlist.entry)),
    getStageDefs(),
    db.select().from(people).orderBy(asc(people.org), asc(people.name)),
    db.select().from(vocabTerms).orderBy(asc(vocabTerms.kind), asc(vocabTerms.assetType), asc(vocabTerms.name)),
    db.selectDistinct({ kind: assets.kind }).from(assets),
    db.select().from(orgs).orderBy(asc(orgs.kind), asc(orgs.name)),
    // How much each org can reach, so removing one states the consequence.
    db.select({ orgId: systemShares.orgId }).from(systemShares),
  ]);
  return (
    <div className="container" style={{ maxWidth: 620 }}>
      <SettingsForm
        clientAccessEnabled={s?.clientAccessEnabled ?? false}
        clientCanEdit={s?.clientCanEdit ?? false}
        allowlist={allowRows.map((r) => ({ id: r.id, entry: r.entry, addedBy: r.addedBy, orgId: r.orgId }))}
        envClients={parseList(process.env.CLIENT_EMAILS)}
        stageDefs={stageDefList}
        people={peopleRows.map((p) => ({ id: p.id, name: p.name, email: p.email, org: p.org }))}
        eodRecipients={s?.eodRecipients ?? ""}
        orgs={orgRows.map((o) => ({
          id: o.id, name: o.name, kind: o.kind,
          systems: shareCounts.filter((c) => c.orgId === o.id).length,
          logins: allowRows.filter((r) => r.orgId === o.id).length,
        }))}
        sheetOrgId={s?.sheetOrgId ?? null}
        vocab={vocabRows.map((v) => ({ id: v.id, kind: v.kind, assetType: v.assetType, name: v.name }))}
        assetTypes={[...new Set([...MODULE_KINDS, ...kindRows.map((k) => k.kind)].filter(Boolean))]}
      />
    </div>
  );
}
