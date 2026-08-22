import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { instruments, orgs, poLines, purchaseOrders, stockrooms, stockroomShares, workOrders } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isHouse, readTenant, visibleSystemIds } from "@/lib/tenancy";
import { makerNames } from "@/lib/makersData";
import { shopMonthDay, shopTime } from "@/lib/shopday";
import { stockAccess } from "@/lib/stock";
import PoPanel from "@/components/PoPanel";
import PoJobCard from "@/components/PoJobCard";
import { woOpen } from "@/lib/workOrders";

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

  return (
    <div className="container page">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <div className="crumb" style={{ margin: 0 }}>
          Operations › <Link href="/purchasing" style={{ textDecoration: "none", color: "inherit" }}>Purchasing</Link> › <b>{po.number}</b>
        </div>
        {room && (
          <Link href={`/stock/${room.id}`} className="mut" style={{ fontSize: 13, textDecoration: "none" }}>
            {room.name} →
          </Link>
        )}
        <span className="mut" style={{ fontSize: 12, marginLeft: "auto" }}>
          {org?.name ? `${org.name}'s order` : "Our order"}
        </span>
      </div>

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
