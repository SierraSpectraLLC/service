import { asc, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { partCatalog, partKitLines, parts, poLines, stockItems, vocabTerms } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import { isPlatformStaff, tenantViewer } from "@/lib/tenants";
import { forTenant, readTenant } from "@/lib/tenancy";
import { uncatalogued } from "@/lib/partCatalog";
import SettingsTabs from "@/components/SettingsTabs";
import PartCatalogPanel from "@/components/PartCatalogPanel";

export const dynamic = "force-dynamic";

/**
 * Settings > Parts: what each part number IS.
 *
 * The spine the five tables that store part numbers as bare strings were
 * missing. Nothing here is required to record a part - the whole point of
 * keeping this a lookup rather than a foreign key is that a part fitted at 2am
 * lands in the record whether or not anybody has catalogued it - so the page
 * leads with the numbers already in use that nothing describes, which is the
 * list that makes filling a parts book a job somebody finishes.
 */
export default async function PartsCatalogPage() {
  let user;
  try { user = await requireStaff(); } catch { redirect("/"); }
  const tenant = readTenant(user);

  const [rows, terms, usedParts, usedStock, usedPo] = await Promise.all([
    db.select().from(partCatalog).where(forTenant(partCatalog.tenantOrgId, tenant))
      .orderBy(asc(partCatalog.partNumber)),
    db.select({ name: vocabTerms.name, kind: vocabTerms.kind, assetType: vocabTerms.assetType }).from(vocabTerms)
      .where(forTenant(vocabTerms.tenantOrgId, tenant)).orderBy(asc(vocabTerms.name)),
    // Every number the shop has actually used. Not tenant-filtered on parts,
    // which carries no stamp of its own - it belongs to whatever system it sits
    // on - so this is deliberately generous and the dedupe does the rest.
    db.selectDistinct({ pn: parts.partNumber }).from(parts),
    db.selectDistinct({ pn: stockItems.partNumber }).from(stockItems),
    db.selectDistinct({ pn: poLines.partNumber }).from(poLines),
  ]);

  const kitIds = rows.filter((r) => r.kind === "kit").map((r) => r.id);
  const lines = kitIds.length
    ? await db.select().from(partKitLines).where(inArray(partKitLines.kitId, kitIds))
        .orderBy(asc(partKitLines.sortOrder), asc(partKitLines.id))
    : [];

  const used = [...usedParts, ...usedStock, ...usedPo].map((r) => r.pn);

  return (
    <div className="container settings">
      <SettingsTabs active="parts" isOwner={user.role === "owner"} isPlatform={isPlatformStaff(tenantViewer(user))} />
      <PartCatalogPanel
        items={rows.map((r) => ({
          id: r.id, partNumber: r.partNumber, name: r.name, manufacturer: r.manufacturer,
          mfrPartNumber: r.mfrPartNumber, kind: r.kind, assetTypes: r.assetTypes,
          models: r.models, note: r.note, archived: r.archived,
          lines: lines.filter((l) => l.kitId === r.id)
            .map((l) => ({ partNumber: l.partNumber, name: l.name, qty: l.qty })),
        }))}
        assetTypes={terms.filter((t) => t.kind === "asset_type").map((t) => t.name)}
        modelsByType={terms.reduce<Record<string, string[]>>((acc, t) => {
          if (t.kind === "model" && t.assetType) (acc[t.assetType] ??= []).push(t.name);
          return acc;
        }, {})}
        unnamed={uncatalogued(rows, used)}
      />
    </div>
  );
}
