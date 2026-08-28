// The reads behind the model lookup. The rules are lib/pmKit and stay pure.
//
// One fetch serves a whole estimate: a bid touching seven systems across two
// buildings asks for the catalog ONCE and then answers seven times from it,
// because the alternative is seven round trips per keystroke in a picker.

import { cache } from "react";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { partCatalog, partKitLines, partPrices, procedures, vocabTerms } from "@/db/schema";
import { forTenant } from "@/lib/tenancy";
import { kitForModel, type CatalogEntry, type KitProcedure, type ModelKit } from "@/lib/pmKit";
import type { PriceEntry } from "@/lib/priceBook";

export type KitSource = {
  procedures: KitProcedure[];
  catalog: CatalogEntry[];
  prices: PriceEntry[];
};

/**
 * Everything the lookup needs, in three reads.
 *
 * cache() so a page building an estimate over a dozen systems pays for this
 * once. The catalog is small - part numbers a shop stocks, not a distributor's
 * database - and the join to kit lines is done here rather than in SQL so the
 * pure side never learns what a row looks like.
 */
export const kitSourceFor = cache(async (tenantOrgId: number | null): Promise<KitSource> => {
  const [procRows, catRows, priceRows] = await Promise.all([
    db.select({
      id: procedures.id, name: procedures.name, assetType: procedures.assetType,
      parts: procedures.parts, estMinutes: procedures.estMinutes,
      intervalDays: procedures.intervalDays, modelScope: procedures.modelScope,
      categoryScope: procedures.categoryScope,
    }).from(procedures).where(forTenant(procedures.tenantOrgId, tenantOrgId)),
    db.select({
      id: partCatalog.id, partNumber: partCatalog.partNumber, name: partCatalog.name,
      kind: partCatalog.kind, models: partCatalog.models,
    }).from(partCatalog).where(forTenant(partCatalog.tenantOrgId, tenantOrgId)),
    db.select({
      partNumber: partPrices.partNumber, vendor: partPrices.vendor,
      isOem: partPrices.isOem, priceCents: partPrices.priceCents,
    }).from(partPrices).where(forTenant(partPrices.tenantOrgId, tenantOrgId)),
  ]);

  // Kit contents, for the bags only. A shop with no kits does no second query.
  const kitIds = catRows.filter((c) => c.kind === "kit").map((c) => c.id);
  const lines = kitIds.length
    ? await db.select({
        kitId: partKitLines.kitId, partNumber: partKitLines.partNumber,
        name: partKitLines.name, qty: partKitLines.qty,
      }).from(partKitLines).where(inArray(partKitLines.kitId, kitIds))
    : [];
  const byKit = new Map<number, { partNumber: string; name: string; qty: number }[]>();
  for (const l of lines) {
    const list = byKit.get(l.kitId) ?? [];
    list.push({ partNumber: l.partNumber, name: l.name, qty: l.qty });
    byKit.set(l.kitId, list);
  }

  return {
    procedures: procRows.map((p) => ({ ...p, estMinutes: p.estMinutes ?? 0 })),
    catalog: catRows.map((c) => ({
      partNumber: c.partNumber, name: c.name, kind: c.kind, lines: byKit.get(c.id),
    })),
    prices: priceRows,
  };
});

/** One model's kit, off a source already fetched. */
export const kitFrom = (source: KitSource, model: string, category: string): ModelKit =>
  kitForModel({ model, category, procedures: source.procedures, catalog: source.catalog, prices: source.prices });

/**
 * What a person can type into the lookup: every model the shop has vocabulary
 * for, with the category it belongs to.
 *
 * From the catalog rather than from the client's own fleet on purpose - a bid
 * is usually for equipment we have never touched, which is the whole reason
 * the lookup exists. `categories` is [] on a model that belongs to every
 * system type (a control PC), and the picker shows it under all of them.
 */
export const modelOptions = cache(async (tenantOrgId: number | null): Promise<
  { model: string; assetType: string; manufacturer: string; categories: string[] }[]
> => {
  const rows = await db.select({
    name: vocabTerms.name, kind: vocabTerms.kind, assetType: vocabTerms.assetType,
    manufacturer: vocabTerms.manufacturer, categories: vocabTerms.categories,
  }).from(vocabTerms).where(forTenant(vocabTerms.tenantOrgId, tenantOrgId));
  return rows
    .filter((r) => r.kind === "model")
    .map((r) => ({
      model: r.name, assetType: r.assetType ?? "",
      manufacturer: r.manufacturer ?? "", categories: r.categories ?? [],
    }))
    .sort((a, b) => a.model.localeCompare(b.model));
});
