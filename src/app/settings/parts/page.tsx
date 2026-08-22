import { asc, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import {
  partCatalog, partKitLines, partNumbers, partPhotos, partPrices, parts, pmSchedules, poLines,
  procedures, stockItems, vocabTerms,
} from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import { isPlatformStaff, tenantViewer } from "@/lib/tenants";
import { forTenant, readTenant } from "@/lib/tenancy";
import { makerNames } from "@/lib/makersData";
import { uncatalogued, type UsedPart } from "@/lib/partCatalog";
import { parseProcParts, schedulePartsOf } from "@/lib/procedures";
import PartCatalogPanel from "@/components/PartCatalogPanel";
import PriceBookCard from "@/components/PriceBookCard";

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
export default async function PartsCatalogPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  let user;
  try { user = await requireStaff(); } catch { redirect("/"); }
  const tenant = readTenant(user);

  const [rows, terms, usedParts, usedStock, usedPo] = await Promise.all([
    db.select().from(partCatalog).where(forTenant(partCatalog.tenantOrgId, tenant))
      .orderBy(asc(partCatalog.partNumber)),
    db.select({ name: vocabTerms.name, kind: vocabTerms.kind, assetType: vocabTerms.assetType, categories: vocabTerms.categories })
      .from(vocabTerms)
      .where(forTenant(vocabTerms.tenantOrgId, tenant)).orderBy(asc(vocabTerms.name)),
    // Every number the shop has actually used. Not tenant-filtered on parts,
    // which carries no stamp of its own - it belongs to whatever system it sits
    // on - so this is deliberately generous and the dedupe does the rest.
    db.selectDistinct({ pn: parts.partNumber }).from(parts),
    db.selectDistinct({ pn: stockItems.partNumber }).from(stockItems),
    db.selectDistinct({ pn: poLines.partNumber }).from(poLines),
  ]);
  // The maker/vendor book, suggested on every manufacturer and vendor field.
  const bookNames = await makerNames(tenant);
  // The parts maintenance says it will use - the PM checklist's consumables
  // list, typed once onto procedures and schedules. Unlike a number fitted at
  // 2am these arrive with a name, a module type and models, so describing one
  // is confirming a prefilled sheet rather than starting from a bare number.
  const [procRows, schedRows] = await Promise.all([
    db.select({ assetType: procedures.assetType, modelScope: procedures.modelScope, parts: procedures.parts })
      .from(procedures).where(forTenant(procedures.tenantOrgId, tenant)),
    db.select({ partName: pmSchedules.partName, partNumber: pmSchedules.partNumber, parts: pmSchedules.parts })
      .from(pmSchedules).where(forTenant(pmSchedules.tenantOrgId, tenant)),
  ]);
  const maintenanceParts: UsedPart[] = [
    ...procRows.flatMap((r) => parseProcParts(r.parts).map((pp) => ({
      partNumber: pp.number, name: pp.name,
      assetType: r.assetType === "system" ? "" : r.assetType,
      // The part's own model list when it has one, the procedure's scope when not.
      models: pp.models?.length ? pp.models : r.modelScope,
      source: "maintenance",
    }))),
    ...schedRows.flatMap((r) => schedulePartsOf(r).map((pp) => ({
      partNumber: pp.number, name: pp.name, source: "maintenance",
    }))),
  ].filter((u) => u.partNumber.trim());
  // Vendor prices live beside the numbers they price - this page - rather than
  // dangling off the equipment catalog, where they read as a second parts book.
  const priceRows = await db.select({
    id: partPrices.id, partNumber: partPrices.partNumber, vendor: partPrices.vendor,
    isOem: partPrices.isOem, priceCents: partPrices.priceCents, url: partPrices.url, note: partPrices.note,
  }).from(partPrices).where(forTenant(partPrices.tenantOrgId, tenant))
    .orderBy(asc(partPrices.partNumber), asc(partPrices.vendor));

  const kitIds = rows.filter((r) => r.kind === "kit").map((r) => r.id);
  const allIds = rows.map((r) => r.id);
  const [lines, aliasRows, photoRows] = await Promise.all([
    kitIds.length
      ? db.select().from(partKitLines).where(inArray(partKitLines.kitId, kitIds))
          .orderBy(asc(partKitLines.sortOrder), asc(partKitLines.id))
      : [],
    allIds.length
      ? db.select().from(partNumbers).where(inArray(partNumbers.catalogId, allIds))
          .orderBy(asc(partNumbers.sortOrder), asc(partNumbers.id))
      : [],
    allIds.length
      ? db.select().from(partPhotos).where(inArray(partPhotos.catalogId, allIds))
          .orderBy(asc(partPhotos.sortOrder), asc(partPhotos.id))
      : [],
  ]);
  const aliasesOf = (id: number) => aliasRows.filter((a) => a.catalogId === id)
    .map((a) => ({ kind: a.kind, partNumber: a.partNumber, manufacturer: a.manufacturer, note: a.note }));
  // The catalog as the matcher needs to see it. Passed to uncatalogued() as
  // well as to the panel, or a part described under the maker's number would
  // keep appearing in the list of numbers nobody has described.
  const withAliases = rows.map((r) => ({ ...r, aliases: aliasesOf(r.id) }));

  // What's INSIDE the catalogued kits. A kit is a bag of other numbers, and
  // listing six of them is the single fastest way to put six numbers into the
  // shop that nothing describes - each already typed with its name, right
  // there, and then invisible everywhere else. They arrive here carrying the
  // kit's own fit, because a seal in an LC-20 pump kit is an LC-20 pump seal:
  // describing one is confirming a filled-in sheet rather than starting from a
  // bare number.
  const kitParts: UsedPart[] = lines.flatMap((l) => {
    const kit = rows.find((r) => r.id === l.kitId);
    const types: (string | undefined)[] = kit?.assetTypes.length ? kit.assetTypes : [undefined];
    return types.map((assetType) => ({
      partNumber: l.partNumber, name: l.name,
      assetType, models: kit?.models ?? [],
      source: "kit",
    }));
  });

  const used: (string | UsedPart)[] = [
    ...usedParts.map((r) => ({ partNumber: r.pn, source: "fitted" })),
    ...usedStock.map((r) => ({ partNumber: r.pn, source: "stock" })),
    ...usedPo.map((r) => ({ partNumber: r.pn, source: "purchasing" })),
    ...maintenanceParts,
    ...kitParts,
  ];

  const { f = "" } = await searchParams;
  return (
    <div>
      <PartCatalogPanel
        items={rows.map((r) => ({
          id: r.id, partNumber: r.partNumber, name: r.name, manufacturer: r.manufacturer,
          mfrPartNumber: r.mfrPartNumber, kind: r.kind, assetTypes: r.assetTypes,
          models: r.models, note: r.note, archived: r.archived,
          lines: lines.filter((l) => l.kitId === r.id)
            .map((l) => ({ partNumber: l.partNumber, name: l.name, qty: l.qty })),
          aliases: aliasesOf(r.id),
          photos: photoRows.filter((ph) => ph.catalogId === r.id)
            .map((ph) => ({ id: ph.id, url: ph.url, caption: ph.caption })),
        }))}
        assetTypes={terms.filter((t) => t.kind === "asset_type").map((t) => t.name)}
        modelsByType={terms.reduce<Record<string, string[]>>((acc, t) => {
          if (t.kind !== "model") return acc;
          // Indexed under the module type AND every system type the model is
          // filed in - a "suits UV-Vis" chip has to offer the UV-1900 whether
          // "UV-Vis" names the module type or the system it belongs to.
          if (t.assetType) (acc[t.assetType] ??= []).push(t.name);
          for (const c of t.categories ?? []) (acc[c] ??= []).push(t.name);
          return acc;
        }, {})}
        prices={priceRows.map((p) => ({
          id: p.id, partNumber: p.partNumber, vendor: p.vendor, isOem: p.isOem,
          priceCents: p.priceCents, url: p.url,
        }))}
        unnamed={uncatalogued(withAliases, used)}
        makers={bookNames}
        initialFacet={f}
      />
      <PriceBookCard prices={priceRows} knownVendors={[...new Set([...bookNames, ...priceRows.map((p) => p.vendor)])].sort()} />
    </div>
  );
}
