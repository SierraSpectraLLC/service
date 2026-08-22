import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { instruments, orgs, parts, poLines, purchaseOrders, stockrooms, stockroomShares } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { shopMonthDay } from "@/lib/shopday";
import { stockAccess } from "@/lib/stock";
import { PO_LABEL, PO_TONE, poTotals } from "@/lib/po";
import { formatCents } from "@/lib/money";
import { canSeeCosts } from "@/lib/redact";
import { forTenant, readTenant, visibleOrgs, visibleSystemIds } from "@/lib/tenancy";
import NeededPartsCard from "@/components/NeededPartsCard";

export const dynamic = "force-dynamic";

/**
 * Every order for a stockroom this viewer may stock. Ordering follows the
 * destination room's access, so a client's own purchasing shows up in their
 * portal and a provider only sees orders for rooms they can stock.
 */
export default async function PurchasingPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }

  const [rooms, myShares, orgRows] = await Promise.all([
    db.select().from(stockrooms).where(forTenant(stockrooms.tenantOrgId, readTenant(user))).orderBy(asc(stockrooms.name)),
    user.orgId === null ? Promise.resolve([]) : db.select({ stockroomId: stockroomShares.stockroomId, access: stockroomShares.access })
      .from(stockroomShares).where(eq(stockroomShares.orgId, user.orgId)),
    visibleOrgs(user),
  ]);
  const seeRooms = rooms.filter((r) => stockAccess(user, r, myShares.find((s) => s.stockroomId === r.id)).see);
  const roomIds = seeRooms.map((r) => r.id);

  const pos = roomIds.length
    ? await db.select().from(purchaseOrders).where(inArray(purchaseOrders.stockroomId, roomIds))
        .orderBy(desc(purchaseOrders.createdAt)).limit(100)
    : [];
  const lines = pos.length
    ? await db.select().from(poLines).where(inArray(poLines.poId, pos.map((p) => p.id)))
    : [];

  // Parts a real system says it needs. Purchasing used to listen only to the
  // shelf - a stock item under its minimum - while a part marked Needed on an
  // instrument sat on that instrument's page waiting to be retyped into an
  // order. Both are "something has to be bought", and this one has a system
  // waiting on it.
  const visible = await visibleSystemIds(user);
  const needed = await db.select({
    id: parts.id, name: parts.name, partNumber: parts.partNumber, qty: parts.qty,
    status: parts.status, vendor: parts.vendor, costCents: parts.costCents,
    instrumentId: parts.instrumentId, assetId: parts.assetId,
    ownerOrgId: parts.ownerOrgId, requestedOrgId: parts.requestedOrgId, requestedAt: parts.requestedAt,
    externalId: instruments.externalId, systemOwnerOrgId: instruments.ownerOrgId,
  }).from(parts).leftJoin(instruments, eq(instruments.id, parts.instrumentId))
    .where(and(
      eq(parts.status, "Needed"),
      visible === null ? undefined : visible.length ? inArray(parts.instrumentId, visible) : sql`false`,
    ))
    .orderBy(asc(parts.id));

  const roomName = new Map(seeRooms.map((r) => [r.id, r.name]));
  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));
  // Rooms this person may actually order INTO, which is a stricter test than
  // seeing them - the same rule createPurchaseOrder enforces server-side.
  const orderRooms = rooms.filter((r) => stockAccess(user, r, myShares.find((s) => s.stockroomId === r.id)).issue);
  const roomOrg = new Map(seeRooms.map((r) => [r.id, r.orgId]));
  const open = pos.filter((p) => p.status === "draft" || p.status === "sent" || p.status === "partial");
  const closed = pos.filter((p) => !open.includes(p));

  const row = (p: typeof pos[number]) => {
    const mine = lines.filter((l) => l.poId === p.id);
    const t = poTotals(mine);
    // Order value follows the destination room's owner, same rule as part cost.
    const showCosts = canSeeCosts(user, p.stockroomId === null ? null : roomOrg.get(p.stockroomId) ?? null, p.tenantOrgId);
    return (
      <div key={p.id} style={{ borderTop: "1px solid var(--line)", padding: "9px 0", display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <Link href={`/purchasing/${p.id}`} className="mono" style={{ fontSize: 13, fontWeight: 700, textDecoration: "none" }}>
          {p.number}
        </Link>
        <span className={`pill ${PO_TONE[p.status] ?? "neutral"}`}>
          {PO_LABEL[p.status] ?? p.status}
        </span>
        <span style={{ fontSize: 13 }}>{p.vendor}</span>
        <span className="mut" style={{ fontSize: 12 }}>
          → {p.stockroomId === null ? "(room gone)" : roomName.get(p.stockroomId) ?? "?"}
        </span>
        <span className="mut" style={{ fontSize: 12 }}>
          {t.received} of {t.ordered} received
        </span>
        {p.expectedAt && <span className="mut" style={{ fontSize: 12 }}>· expected {p.expectedAt}</span>}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "baseline" }}>
          {showCosts && t.priced > 0 && <b style={{ fontSize: 13 }}>{formatCents(t.cents)}</b>}
          <span className="mut" style={{ fontSize: 11 }}>{shopMonthDay(p.createdAt)}</span>
        </span>
      </div>
    );
  };

  return (
    <div className="container wide">
      <div className="page-head">
        <h1 className="page-title">Purchasing</h1>
        {open.length > 0 && (
          <span className="pill" style={{ background: "#E7EFF8", color: "#1D6396", fontWeight: 700 }}>
            {open.length} open
          </span>
        )}
        <span className="page-actions">
          <Link href="/stock" className="btn sm" style={{ textDecoration: "none" }}>Inventory →</Link>
        </span>
        <p className="page-sub">
          Orders are raised from a stockroom&apos;s reorder list, priced from the price book.
          Receiving here is what puts stock on the shelf, so the count and the paperwork
          can&apos;t drift apart.
        </p>
      </div>
      {/* The floor's queue, above the paperwork: these have systems waiting. */}
      <NeededPartsCard
        parts={needed.map((n) => ({
          id: n.id, name: n.name, partNumber: n.partNumber, qty: n.qty, vendor: n.vendor,
          instrumentId: n.instrumentId, assetId: n.assetId, externalId: n.externalId,
          ownerOrgId: n.systemOwnerOrgId ?? n.ownerOrgId,
          ownerName: orgName.get(n.systemOwnerOrgId ?? n.ownerOrgId ?? -1) ?? "the owner",
          requestedOrgName: orgName.get(n.requestedOrgId ?? -1) ?? "",
          requestedAt: n.requestedAt?.toISOString() ?? null,
        }))}
        rooms={orderRooms.map((r) => ({ id: r.id, name: r.name }))}
        canOrder={orderRooms.length > 0}
      />

      <div className="card">
        {open.length === 0 && closed.length === 0 && (
          <div className="empty">
            <b>No orders yet</b>
            Open a stockroom and use its <b style={{ display: "inline" }}>Needs ordering</b> list to raise the first one.
          </div>
        )}
        {open.map(row)}
      </div>

      {closed.length > 0 && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>Closed</div>
          {closed.map(row)}
        </div>
      )}
    </div>
  );
}
