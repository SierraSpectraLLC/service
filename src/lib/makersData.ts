// Server half of the maker book: gather every column a manufacturer or vendor
// name is typed into, feed lib/makers the pile. The settings page renders the
// result; other pages call makerNames() for their datalists so every maker
// input in the app suggests from the same list.
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  assets, instruments, partCatalog, partNumbers, partPrices, parts, purchaseOrders, vocabTerms,
} from "@/db/schema";
import { forTenant } from "@/lib/tenancy";
import { mergeMakers, type MakerRow, type MakerSource } from "@/lib/makers";

/** Everything typed where a maker/vendor goes, tagged by where. */
export async function makerBook(tenantOrgId: number | null): Promise<MakerRow[]> {
  const [defined, models, systems, units, catRows, aliasRows, partRows, poRows, priceRows] = await Promise.all([
    db.select({ id: vocabTerms.id, name: vocabTerms.name }).from(vocabTerms)
      .where(and(eq(vocabTerms.kind, "maker"), forTenant(vocabTerms.tenantOrgId, tenantOrgId))),
    db.select({ name: vocabTerms.manufacturer }).from(vocabTerms)
      .where(and(eq(vocabTerms.kind, "model"), forTenant(vocabTerms.tenantOrgId, tenantOrgId))),
    db.select({ name: instruments.manufacturer }).from(instruments)
      .where(forTenant(instruments.tenantOrgId, tenantOrgId)),
    db.select({ name: assets.manufacturer }).from(assets)
      .where(forTenant(assets.tenantOrgId, tenantOrgId)),
    db.select({ name: partCatalog.manufacturer }).from(partCatalog)
      .where(forTenant(partCatalog.tenantOrgId, tenantOrgId)),
    // part_numbers carries no tenant stamp; its catalog entry does.
    db.select({ name: partNumbers.manufacturer }).from(partNumbers)
      .innerJoin(partCatalog, eq(partCatalog.id, partNumbers.catalogId))
      .where(forTenant(partCatalog.tenantOrgId, tenantOrgId)),
    // parts carries no tenant stamp of its own - it belongs to whatever record
    // it sits on. Deliberately generous, same as the parts-book page: these are
    // suggestion names, and the dedupe does the rest.
    db.selectDistinct({ name: parts.vendor }).from(parts),
    db.select({ name: purchaseOrders.vendor }).from(purchaseOrders)
      .where(forTenant(purchaseOrders.tenantOrgId, tenantOrgId)),
    db.select({ name: partPrices.vendor }).from(partPrices)
      .where(forTenant(partPrices.tenantOrgId, tenantOrgId)),
  ]);
  const tag = (rows: { name: string }[], source: MakerSource) =>
    rows.map((r) => ({ name: r.name, source }));
  return mergeMakers(defined, [
    ...tag(models, "models"),
    ...tag(systems, "systems"),
    ...tag(units, "units"),
    ...tag(catRows, "parts"),
    ...tag(aliasRows, "parts"),
    ...tag(partRows, "buying"),
    ...tag(poRows, "buying"),
    ...tag(priceRows, "buying"),
  ]);
}

/** Just the names, for datalist suggestions on maker/vendor inputs. */
export async function makerNames(tenantOrgId: number | null): Promise<string[]> {
  return (await makerBook(tenantOrgId)).map((r) => r.name);
}

/**
 * The tenant's part-catalog ids, for updates that must reach part_numbers.
 * Exported for actions.renameMaker; null tenant means the whole instance.
 */
export async function tenantCatalogIds(tenantOrgId: number | null): Promise<number[] | null> {
  if (tenantOrgId === null) return null;
  const rows = await db.select({ id: partCatalog.id }).from(partCatalog)
    .where(forTenant(partCatalog.tenantOrgId, tenantOrgId));
  return rows.map((r) => r.id);
}

