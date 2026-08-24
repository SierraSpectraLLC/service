// The shelf, loaded once and read by both store surfaces.
//
// The list and a part's own page have to agree about price, availability and
// fit, so they ask the same function rather than each assembling the catalog
// their own way. This is the boundary lib/store's comment describes: staff
// data (catalog, price book, markup, stock) goes in, and StorePart - which has
// no field for a vendor, a cost or a margin - comes out.

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  appSettings, assets, instruments, orgs, partCatalog, partPhotos, partPrices, stockItems, stockrooms,
} from "@/db/schema";
import { forTenant } from "@/lib/tenancy";
import { tenantOf } from "@/lib/tenants";
import { groupByPn } from "@/lib/priceBook";
import { effectiveDays } from "@/lib/sourcing";
import { buildStore, type StorePart } from "@/lib/store";
import { billingContext } from "@/lib/invoiceData";

export type Shelf = { items: StorePart[]; termsDays: number };

/** Everything this client may be shown about what we sell, already priced. */
export async function shelfFor(org: typeof orgs.$inferSelect): Promise<Shelf> {
  const tenant = tenantOf(org);

  const [catalog, priceRows, ctx, myInstruments] = await Promise.all([
    db.select().from(partCatalog).where(and(
      forTenant(partCatalog.tenantOrgId, tenant), eq(partCatalog.archived, false))),
    db.select({
      partNumber: partPrices.partNumber, vendor: partPrices.vendor,
      isOem: partPrices.isOem, priceCents: partPrices.priceCents,
      leadDays: partPrices.leadDays, dropShips: partPrices.dropShips,
    }).from(partPrices).where(forTenant(partPrices.tenantOrgId, tenant)),
    billingContext(org.id),
    db.select({ id: instruments.id, externalId: instruments.externalId, model: instruments.model })
      .from(instruments).where(eq(instruments.ownerOrgId, org.id)),
  ]);

  const myAssets = myInstruments.length
    ? await db.select({ instrumentId: assets.instrumentId, kind: assets.kind, model: assets.model })
        .from(assets).where(inArray(assets.instrumentId, myInstruments.map((i) => i.id)))
    : [];

  // "fits your LZ-001 · 7890B" beats "Fits 7890B": name their unit when a
  // model on the part maps to one of theirs.
  const unitByModel = new Map<string, string>();
  for (const i of myInstruments) {
    if (i.model.trim()) unitByModel.set(i.model.trim().toLowerCase(), `${i.externalId} · ${i.model}`);
  }
  for (const a of myAssets) {
    const inst = myInstruments.find((i) => i.id === a.instrumentId);
    if (a.model.trim() && !unitByModel.has(a.model.trim().toLowerCase())) {
      unitByModel.set(a.model.trim().toLowerCase(), `${inst?.externalId ?? "your"} · ${a.model}`);
    }
  }

  // Best cost per CLASS - genuine and equivalent priced apart, because that is
  // the one sourcing choice the client makes - and beside it the honest ETA:
  // the quickest door-to-door days any vendor manages, cross-dock included.
  // Days cross to the client; vendors never do.
  const [settingsRow] = await db.select({ crossDockDays: appSettings.crossDockDays })
    .from(appSettings).where(eq(appSettings.id, 1));
  const crossDockDays = settingsRow?.crossDockDays ?? 1;
  const oemCostByPn = new Map<string, number>();
  const altCostByPn = new Map<string, number>();
  const etaByPn = new Map<string, number>();
  for (const [pn, offers] of groupByPn(priceRows)) {
    const oem = offers.find((o) => o.isOem);
    const alt = offers.find((o) => !o.isOem);
    if (oem) oemCostByPn.set(pn, oem.priceCents);
    if (alt) altCostByPn.set(pn, alt.priceCents);
    const days = offers.map((o) => effectiveDays(o, crossDockDays))
      .filter((d): d is number => d !== null);
    if (days.length) etaByPn.set(pn, Math.min(...days));
  }

  // On-hand across the house's own rooms - the same count placePartsOrder
  // splits the checkout on, so the badge and the outcome cannot disagree.
  const houseRooms = await db.select({ id: stockrooms.id }).from(stockrooms)
    .where(and(forTenant(stockrooms.tenantOrgId, tenant),
      isNull(stockrooms.orgId), eq(stockrooms.archived, false)));
  const stockByPn = new Map<string, number>();
  if (houseRooms.length) {
    const stockRows = await db.select({ partNumber: stockItems.partNumber, qty: stockItems.qty })
      .from(stockItems).where(inArray(stockItems.stockroomId, houseRooms.map((r) => r.id)));
    for (const s of stockRows) {
      const key = s.partNumber.trim().toLowerCase();
      stockByPn.set(key, (stockByPn.get(key) ?? 0) + s.qty);
    }
  }

  const photoRows = catalog.length
    ? await db.select({ catalogId: partPhotos.catalogId, url: partPhotos.url }).from(partPhotos)
        .where(inArray(partPhotos.catalogId, catalog.map((c) => c.id)))
        .orderBy(asc(partPhotos.sortOrder), asc(partPhotos.id))
    : [];
  const photoByCatalogId = new Map<number, string>();
  for (const p of photoRows) if (!photoByCatalogId.has(p.catalogId)) photoByCatalogId.set(p.catalogId, p.url);

  return {
    items: buildStore(catalog, {
      oemCostByPn, altCostByPn,
      markupBps: ctx.policy.partsMarkupBps,
      yours: {
        models: [...myInstruments.map((i) => i.model), ...myAssets.map((a) => a.model)],
        types: myAssets.map((a) => a.kind),
      },
      photoByCatalogId, stockByPn, etaByPn, unitByModel,
    }),
    termsDays: org.termsDays,
  };
}
