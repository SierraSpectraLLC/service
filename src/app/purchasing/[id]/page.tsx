import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { orgs, poLines, purchaseOrders, stockrooms, stockroomShares } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isHouse } from "@/lib/tenancy";
import { shopMonthDay, shopTime } from "@/lib/shopday";
import { stockAccess } from "@/lib/stock";
import PoPanel from "@/components/PoPanel";

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

  return (
    <div className="container page">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <Link href="/purchasing" className="mut" style={{ fontSize: 13, textDecoration: "none" }}>← Purchasing</Link>
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
      />
    </div>
  );
}
