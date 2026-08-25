import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, instruments, orgSites, orgs, poLines, purchaseOrders, stockrooms, stockroomShares, workOrders } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isHouse, readTenant, visibleSystemIds } from "@/lib/tenancy";
import { makerNames } from "@/lib/makersData";
import { shopMonthDay, shopTime } from "@/lib/shopday";
import { stockAccess } from "@/lib/stock";
import PoPanel from "@/components/PoPanel";
import { RecordHero, type HeroStat } from "@/components/ui";
import PoJobCard from "@/components/PoJobCard";
import PoShippingCard from "@/components/PoShippingCard";
import { woOpen } from "@/lib/workOrders";
import { PO_LABEL, PO_TONE, poEditable, poTotals } from "@/lib/po";

export const dynamic = "force-dynamic";

export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { id } = await params;
  const poId = parseInt(id);
  if (isNaN(poId)) notFound();

  const [[po], lines] = await Promise.all([
    db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)),
    db.select().from(poLines).where(eq(poLines.poId, poId)).orderBy(asc(poLines.id)),
  ]);
  if (!po) notFound();

  // Access follows the destination room, exactly like the actions do.
  const [room] = po.stockroomId === null ? [] : await db.select().from(stockrooms).where(eq(stockrooms.id, po.stockroomId));
  let see = isHouse(user.role);
  let manage = isHouse(user.role);
  if (room) {
    const [share] = user.orgId === null ? [] : await db.select({ access: stockroomShares.access })
      .from(stockroomShares).where(and(eq(stockroomShares.stockroomId, room.id), eq(stockroomShares.orgId, user.orgId)));
    const acc = stockAccess(user, room, share);
    see = acc.see;
    manage = acc.issue;
  }
  if (!see) notFound();

  const [org] = po.orgId === null ? [] : await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, po.orgId));

  // Drop-ship candidates: every unarchived client site in this tenant, named
  // by whose it is. House-only, like the vendor list - a client issuing their
  // own PO ships to their own dock and does not need the whole site book.
  const canRoute = isHouse(user.role) && manage;
  const siteRows = canRoute || po.shipToSiteId !== null
    ? await db.select({
        id: orgSites.id, name: orgSites.name, orgId: orgSites.orgId, archived: orgSites.archived,
        orgName: orgs.name, orgKind: orgs.kind,
      }).from(orgSites).innerJoin(orgs, eq(orgs.id, orgSites.orgId))
        .orderBy(asc(orgs.name), asc(orgSites.name))
    : [];
  const shipSites = siteRows
    .filter((s) => (!s.archived && s.orgKind === "client") || s.id === po.shipToSiteId)
    .map((s) => ({ id: s.id, label: `${s.orgName}${s.name ? ` - ${s.name}` : ""}` }));
  const [settingsRow] = canRoute || po.shipToSiteId !== null
    ? await db.select({ partsBrand: appSettings.partsBrand }).from(appSettings).where(eq(appSettings.id, 1))
    : [];

  // Which jobs this order could be filed against: the ones on systems this
  // person can see, still taking work - plus whichever it is already on, so an
  // order filed against a job that has since closed still names it rather than
  // silently reading as stock.
  const visible = await visibleSystemIds(user);
  const scoped = (col: AnyColumn): SQL | undefined =>
    visible === null ? undefined : visible.length ? inArray(col, visible) : sql`false`;
  const woRows = await db.select().from(workOrders)
    .where(scoped(workOrders.instrumentId)).orderBy(desc(workOrders.createdAt)).limit(200);
  const woInstIds = [...new Set(woRows.flatMap((w) => (w.instrumentId !== null ? [w.instrumentId] : [])))];
  const woInsts = woInstIds.length
    ? await db.select({ id: instruments.id, externalId: instruments.externalId, client: instruments.client })
        .from(instruments).where(inArray(instruments.id, woInstIds))
    : [];
  const jobOf = (w: typeof woRows[number]) => {
    const i = woInsts.find((x) => x.id === w.instrumentId);
    return {
      id: w.id, number: w.number, title: w.title,
      place: i ? `${i.externalId}${i.client ? ` · ${i.client}` : ""}` : "",
    };
  };
  const onJob = woRows.find((w) => w.id === po.workOrderId) ?? null;

  const totals = poTotals(lines);
  const dropSite = shipSites.find((s) => s.id === po.shipToSiteId) ?? null;
  const heroStats: HeroStat[] = [
    { value: PO_LABEL[po.status] ?? po.status, label: "", tone: (PO_TONE[po.status] ?? "neutral") === "neutral" ? undefined : PO_TONE[po.status] },
    ...(po.urgent ? [{ value: "URGENT", label: "overnight", tone: "bad" as const }] : []),
    { value: `${totals.received} of ${totals.ordered}`, label: "received", tone: po.status === "partial" ? "warn" : undefined },
    ...(po.expectedAt ? [{ value: po.expectedAt, label: "expected" }] : []),
  ];

  return (
    <div className="container page">
      <div className="crumb">
        Operations › <Link href="/purchasing" style={{ textDecoration: "none", color: "inherit" }}>Purchasing</Link> › <b>{po.number}</b>
      </div>

      <RecordHero
        eyebrow={org?.name ? `${org.name}'s order` : "Our order"}
        id={po.number}
        title={po.vendor}
        meta={dropSite
          ? <>→ drop-ship to {dropSite.label}</>
          : <>→ {room ? <Link href={`/stock/${room.id}`} style={{ color: "inherit" }}>{room.name}</Link> : "(stockroom gone)"}</>}
        stats={heroStats}
      />

      <div className="row-2" style={{ marginBottom: 10 }}>
        {/* The shop's own Excel layout, filled - templates/POTemplate.xlsx. */}
        <a className="btn sm" href={`/api/export/po/${po.id}`} download>
          Excel
        </a>
      </div>

      {(canRoute || po.shipToSiteId !== null || po.urgent) && (
        <PoShippingCard
          poId={po.id}
          editable={canRoute && poEditable(po.status)}
          shipToSiteId={po.shipToSiteId}
          urgent={po.urgent}
          sites={shipSites}
          brand={settingsRow?.partsBrand || "Ridgeline"}
        />
      )}

      <PoPanel
        po={{
          id: po.id, number: po.number, vendor: po.vendor, status: po.status, reference: po.reference,
          note: po.note, expectedAt: po.expectedAt, cancelReason: po.cancelReason,
          roomName: room?.name ?? "(stockroom gone)",
          when: shopMonthDay(po.createdAt),
          sentWhen: po.sentAt ? shopTime(po.sentAt) : "",
        }}
        lines={lines.map((l) => ({
          id: l.id, partNumber: l.partNumber, name: l.name, qtyOrdered: l.qtyOrdered,
          qtyReceived: l.qtyReceived, unitCents: l.unitCents, note: l.note,
        }))}
        canManage={manage}
        // Vendor suggestions come from the maker book - house only: a client
        // who can issue their own POs still shouldn't be handed the shop's
        // whole supplier list as autocomplete.
        makers={isHouse(user.role) && manage ? await makerNames(readTenant(user)) : []}
      />

      <PoJobCard poId={po.id} canManage={manage}
        workOrder={onJob ? jobOf(onJob) : null}
        options={woRows.filter((w) => woOpen(w.state) || w.state === "resolved").map(jobOf)} />
    </div>
  );
}
