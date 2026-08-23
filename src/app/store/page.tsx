import { redirect } from "next/navigation";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { assets, instruments, orgs, partCatalog, partPhotos, partPrices, shareLinks } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole, tenantOf } from "@/lib/tenants";
import { forTenant } from "@/lib/tenancy";
import { groupByPn } from "@/lib/priceBook";
import { buildStore, ORDER_LABEL } from "@/lib/store";
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
  const bestCost = new Map<string, number>();
  for (const [pn, offers] of groupByPn(priceRows)) bestCost.set(pn, offers[0].priceCents);

  const photoRows = catalog.length
    ? await db.select({ catalogId: partPhotos.catalogId, url: partPhotos.url }).from(partPhotos)
        .where(inArray(partPhotos.catalogId, catalog.map((c) => c.id)))
        .orderBy(asc(partPhotos.sortOrder), asc(partPhotos.id))
    : [];
  const photoByCatalogId = new Map<number, string>();
  for (const p of photoRows) if (!photoByCatalogId.has(p.catalogId)) photoByCatalogId.set(p.catalogId, p.url);

  const items = buildStore(
    catalog, bestCost, ctx.policy.partsMarkupBps,
    {
      models: [...myInstruments.map((i) => i.model), ...myAssets.map((a) => a.model)],
      types: myAssets.map((a) => a.kind),
    },
    photoByCatalogId,
  );

  // Their own orders, in store language, with the portal door where one exists.
  const today = shopToday();
  const links = full.length
    ? await db.select({ invoiceId: shareLinks.invoiceId, token: shareLinks.token }).from(shareLinks)
        .where(and(inArray(shareLinks.invoiceId, full.map((f) => f.row.id)), isNull(shareLinks.revokedAt)))
    : [];
  const orders = full.slice(0, 12).map((f) => {
    const v = invoiceView(asStatementRow(f), today);
    const label = f.row.status === "draft" ? ORDER_LABEL.draft : STANDING_LABEL[v.standing];
    const tone: Tone = f.row.status === "draft" ? "info" : STANDING_TONE[v.standing];
    return {
      number: f.row.number, label, tone,
      totalCents: v.linesCents + v.feesCents,
      placedOn: shopMonthDay(f.row.createdAt),
      token: links.find((l) => l.invoiceId === f.row.id)?.token ?? "",
    };
  });

  return (
    <div className="container wide">
      <PageHead title="Order parts"
        sub={`Stocked and serviced by us, priced for ${org.name}.`} />
      <StoreFront items={items} orders={orders} orgName={org.name}
        hasYours={items.some((i) => i.fitsYours)} />
    </div>
  );
}
