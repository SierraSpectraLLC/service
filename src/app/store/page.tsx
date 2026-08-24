import { redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, assets, instruments, orgs, partCatalog, partPhotos, partPrices, stockItems, stockrooms } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole, tenantOf } from "@/lib/tenants";
import { forTenant } from "@/lib/tenancy";
import { groupByPn } from "@/lib/priceBook";
import { effectiveDays } from "@/lib/sourcing";
import { buildStore } from "@/lib/store";
import { billingContext } from "@/lib/invoiceData";
import StoreFront from "@/components/StoreFront";
import { PageHead } from "@/components/ui";
import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * The parts store, for a signed-in client. Everything on this page crossed
 * the client boundary already priced: lib/store builds the shelf server-side
 * from staff data (catalog, price book, markup) and only resale figures make
 * it into props. Vendors, costs and margins have no field to travel in.
 */
export default async function StorePage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  // Staff order through Purchasing; this door is the client's.
  if (isStaffRole(user.role) && user.orgId === null) redirect("/purchasing");
  if (user.orgId === null) redirect("/");
  const [org] = await db.select().from(orgs).where(eq(orgs.id, user.orgId));
  if (!org || org.kind !== "client") redirect("/");
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

  // The best COST per part number - it exists only on this side of buildStore.
  // Beside it, the honest ETA: the quickest door-to-door days any vendor
  // manages, cross-dock included. Days cross to the client; vendors never do.
  const [settingsRow] = await db.select({ crossDockDays: appSettings.crossDockDays })
    .from(appSettings).where(eq(appSettings.id, 1));
  const crossDockDays = settingsRow?.crossDockDays ?? 1;
  // Best cost per CLASS: the genuine article and the best equivalent priced
  // separately, because that is the one sourcing choice the client makes.
  const oemCost = new Map<string, number>();
  const altCost = new Map<string, number>();
  const etaByPn = new Map<string, number>();
  for (const [pn, offers] of groupByPn(priceRows)) {
    const oem = offers.find((o) => o.isOem);
    const alt = offers.find((o) => !o.isOem);
    if (oem) oemCost.set(pn, oem.priceCents);
    if (alt) altCost.set(pn, alt.priceCents);
    const days = offers
      .map((o) => effectiveDays(o, crossDockDays))
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

  const items = buildStore(catalog, {
    oemCostByPn: oemCost,
    altCostByPn: altCost,
    markupBps: ctx.policy.partsMarkupBps,
    yours: {
      models: [...myInstruments.map((i) => i.model), ...myAssets.map((a) => a.model)],
      types: myAssets.map((a) => a.kind),
    },
    photoByCatalogId, stockByPn, etaByPn, unitByModel,
  });

  return (
    <div className="container wide">
      <PageHead title="Parts"
        sub={`Stocked and serviced by us, priced for ${org.name}. Your equipment is already on file.`}
        actions={<Link href="/orders" className="btn sm" style={{ textDecoration: "none" }}>Your orders →</Link>} />
      <StoreFront items={items} orgName={org.name}
        hasYours={items.some((i) => i.fitsYours)}
        termsDays={org.termsDays} />
    </div>
  );
}
