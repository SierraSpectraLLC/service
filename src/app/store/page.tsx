import { redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, assets, instruments, orgs, partCatalog, partPhotos, partPrices, quoteLines as quoteLinesTable, quotes as quotesTable, shareLinks, stockItems, stockrooms } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole, tenantOf } from "@/lib/tenants";
import { forTenant } from "@/lib/tenancy";
import { groupByPn } from "@/lib/priceBook";
import { effectiveDays } from "@/lib/sourcing";
import { buildStore, ORDER_LABEL } from "@/lib/store";
import { quoteStanding, STANDING_LABEL as QUOTE_LABEL, STANDING_TONE as QUOTE_TONE } from "@/lib/quotes";
import { asStatementRow, billingContext, invoicesForOrg } from "@/lib/invoiceData";
import { invoiceView, STANDING_LABEL, STANDING_TONE } from "@/lib/statement";
import { shopMonthDay, shopToday } from "@/lib/shopday";
import StoreFront from "@/components/StoreFront";
import { PageHead } from "@/components/ui";
import type { Tone } from "@/lib/tones";

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

  const [catalog, priceRows, ctx, myInstruments, full] = await Promise.all([
    db.select().from(partCatalog).where(and(
      forTenant(partCatalog.tenantOrgId, tenant), eq(partCatalog.archived, false))),
    db.select({
      partNumber: partPrices.partNumber, vendor: partPrices.vendor,
      isOem: partPrices.isOem, priceCents: partPrices.priceCents,
      leadDays: partPrices.leadDays, dropShips: partPrices.dropShips,
    }).from(partPrices).where(forTenant(partPrices.tenantOrgId, tenant)),
    billingContext(org.id),
    db.select({ id: instruments.id, model: instruments.model }).from(instruments)
      .where(eq(instruments.ownerOrgId, org.id)),
    invoicesForOrg(org.id),
  ]);

  const myAssets = myInstruments.length
    ? await db.select({ kind: assets.kind, model: assets.model }).from(assets)
        .where(inArray(assets.instrumentId, myInstruments.map((i) => i.id)))
    : [];

  // The best COST per part number - it exists only on this side of buildStore.
  // Beside it, the honest ETA: the quickest door-to-door days any vendor
  // manages, cross-dock included. Days cross to the client; vendors never do.
  const [settingsRow] = await db.select({ crossDockDays: appSettings.crossDockDays })
    .from(appSettings).where(eq(appSettings.id, 1));
  const crossDockDays = settingsRow?.crossDockDays ?? 1;
  const bestCost = new Map<string, number>();
  const etaByPn = new Map<string, number>();
  for (const [pn, offers] of groupByPn(priceRows)) {
    bestCost.set(pn, offers[0].priceCents);
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
    bestCostByPn: bestCost,
    markupBps: ctx.policy.partsMarkupBps,
    yours: {
      models: [...myInstruments.map((i) => i.model), ...myAssets.map((a) => a.model)],
      types: myAssets.map((a) => a.kind),
    },
    photoByCatalogId, stockByPn, etaByPn,
  });

  // Their own orders, in store language, with the portal door where one exists.
  const today = shopToday();
  const links = full.length
    ? await db.select({ invoiceId: shareLinks.invoiceId, token: shareLinks.token }).from(shareLinks)
        .where(and(inArray(shareLinks.invoiceId, full.map((f) => f.row.id)), isNull(shareLinks.revokedAt)))
    : [];
  const myQuotes = await db.select().from(quotesTable)
    .where(eq(quotesTable.orgId, org.id)).orderBy(desc(quotesTable.id)).limit(12);
  const quoteLinks = myQuotes.length
    ? await db.select({ quoteId: shareLinks.quoteId, token: shareLinks.token }).from(shareLinks)
        .where(and(inArray(shareLinks.quoteId, myQuotes.map((q) => q.id)), isNull(shareLinks.revokedAt)))
    : [];
  const qLines = myQuotes.length
    ? await db.select().from(quoteLinesTable)
        .where(inArray(quoteLinesTable.quoteId, myQuotes.map((q) => q.id)))
    : [];
  const orders = [
    ...full.slice(0, 12).map((f) => {
      const v = invoiceView(asStatementRow(f), today);
      const label = f.row.status === "draft" ? ORDER_LABEL.draft : STANDING_LABEL[v.standing];
      const tone: Tone = f.row.status === "draft" ? "info" : STANDING_TONE[v.standing];
      return {
        number: f.row.number, kind: "invoice" as const, label, tone,
        totalCents: v.linesCents + v.feesCents,
        placedOn: shopMonthDay(f.row.createdAt), at: f.row.createdAt.getTime(),
        token: links.find((l) => l.invoiceId === f.row.id)?.token ?? "",
      };
    }),
    ...myQuotes.map((q) => {
      const s = quoteStanding(q, today);
      return {
        number: q.number, kind: "quote" as const,
        label: q.status === "draft" ? "Quote being prepared" : QUOTE_LABEL[s],
        tone: (q.status === "draft" ? "info" : QUOTE_TONE[s]) as Tone,
        totalCents: qLines.filter((l) => l.quoteId === q.id && !l.covered)
          .reduce((n, l) => n + Math.round((l.qty / 1000) * l.unitCents), 0),
        placedOn: shopMonthDay(q.createdAt), at: q.createdAt.getTime(),
        token: quoteLinks.find((l) => l.quoteId === q.id)?.token ?? "",
      };
    }),
  ].sort((a, b) => b.at - a.at).slice(0, 14);

  return (
    <div className="container wide">
      <PageHead title="Order parts"
        sub={`Stocked and serviced by us, priced for ${org.name}.`} />
      <StoreFront items={items} orders={orders} orgName={org.name}
        hasYours={items.some((i) => i.fitsYours)} />
    </div>
  );
}
