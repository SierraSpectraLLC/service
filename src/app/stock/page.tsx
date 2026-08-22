import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { orgs, stockItems, stockrooms, stockroomShares } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { forTenant, isHouse, readTenant, visibleOrgs } from "@/lib/tenancy";
import { KIND_LABEL, needsReorder, stockAccess, stockTotals } from "@/lib/stock";
import NewStockroomForm from "@/components/NewStockroomForm";

export const dynamic = "force-dynamic";

/**
 * Every stockroom this viewer may see: the house's shelves, their own
 * organization's, and anyone else's that's been shared with them. Counts and
 * shortages are summarized here so "what needs ordering" is one glance.
 */
export default async function StockPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }

  const [rooms, myShares, orgRows] = await Promise.all([
    db.select().from(stockrooms)
      .where(and(eq(stockrooms.archived, false), forTenant(stockrooms.tenantOrgId, readTenant(user))))
      .orderBy(asc(stockrooms.name)),
    user.orgId === null ? Promise.resolve([]) : db.select({ stockroomId: stockroomShares.stockroomId, access: stockroomShares.access })
      .from(stockroomShares).where(eq(stockroomShares.orgId, user.orgId)),
    visibleOrgs(user),
  ]);

  const visible = rooms
    .map((r) => ({ room: r, acc: stockAccess(user, r, myShares.find((s) => s.stockroomId === r.id)) }))
    .filter((x) => x.acc.see);

  const roomIds = visible.map((v) => v.room.id);
  const lines = roomIds.length
    ? await db.select({ stockroomId: stockItems.stockroomId, qty: stockItems.qty, minQty: stockItems.minQty })
        .from(stockItems).where(inArray(stockItems.stockroomId, roomIds))
    : [];

  const orgName = (id: number | null) => (id === null ? "Us" : orgRows.find((o) => o.id === id)?.name ?? "Unknown");
  const shortAll = lines.filter(needsReorder).length;

  return (
    <div className="container wide">
      <div className="page-head">
        <h1 className="page-title">Inventory</h1>
        {shortAll > 0 && (
          <span className="pill bad">
            {shortAll} line{shortAll === 1 ? "" : "s"} at or below reorder point
          </span>
        )}
        <span className="page-actions">
          {/* Reachable for org editors too, who don't get the staff nav menu. */}
          {visible.some((v) => v.acc.issue) && (
            <Link href="/purchasing" className="btn sm" style={{ textDecoration: "none" }}>Purchase orders</Link>
          )}
          {(isHouse(user.role) || (user.orgId !== null && user.role === "client_editor")) && (
            <NewStockroomForm
              orgOptions={orgRows}
              isHouse={isHouse(user.role)}
              myOrgName={user.orgName || "your organization"}
            />
          )}
        </span>
        <p className="page-sub">
          Shelves, vans and client cages. A room belongs to one organization and can be
          shared with others - that&apos;s how a provider draws from a client&apos;s spares, or a
          client sees what&apos;s held for them.
        </p>
      </div>
      <div className="card">
        {visible.length === 0 && (
          <div className="empty">
            <b>No stockrooms yet</b>
            Create one with “+ New stockroom” to start tracking shelves, vans and cages.
          </div>
        )}

        {visible.map(({ room, acc }) => {
          const mine = lines.filter((l) => l.stockroomId === room.id);
          const totals = stockTotals(mine);
          return (
            <div key={room.id} style={{ borderTop: "1px solid var(--line)", padding: "9px 0", display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <Link href={`/stock/${room.id}`} style={{ fontSize: 14, fontWeight: 700, textDecoration: "none" }}>
                {room.name}
              </Link>
              <span className="pill neutral">{KIND_LABEL[room.kind] ?? room.kind}</span>
              <span className="mut" style={{ fontSize: 12 }}>{orgName(room.orgId)}</span>
              {room.keeper && <span className="mut" style={{ fontSize: 12 }}>· {room.keeper}</span>}
              {room.location && <span className="mut" style={{ fontSize: 12 }}>· {room.location}</span>}
              {!acc.issue && <span className="pill faint">read-only</span>}
              <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "baseline" }}>
                {totals.short > 0 && (
                  <span className="pill bad">{totals.short} short</span>
                )}
                <span className="mut" style={{ fontSize: 12 }}>
                  {totals.lines} line{totals.lines === 1 ? "" : "s"} · {totals.units} unit{totals.units === 1 ? "" : "s"}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
