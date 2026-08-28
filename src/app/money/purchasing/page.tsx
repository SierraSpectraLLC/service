import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { instruments, orgs, parts, poLines, purchaseOrders, stockrooms, stockroomShares } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { shopMonthDay } from "@/lib/shopday";
import { stockAccess } from "@/lib/stock";
import { makerNames } from "@/lib/makersData";
import { PO_LABEL, PO_TONE, poTotals } from "@/lib/po";
import { formatCents } from "@/lib/money";
import { canSeeCosts } from "@/lib/redact";
import { forTenant, isHouse, readTenant, visibleOrgs, visibleSystemIds } from "@/lib/tenancy";
import NeededPartsCard from "@/components/NeededPartsCard";
import NewPoButton from "@/components/NewPoButton";
import { DataTable, Dot, FacetStrip, Id, Legend, Pill, Toolbar } from "@/components/ui";
import FinanceShell from "@/components/FinanceShell";
import BackfillPoButton from "@/components/BackfillPoButton";
import { railContext } from "@/lib/financeData";
import { isStaffRole } from "@/lib/tenants";
import type { DataRow } from "@/components/ui/DataTable";
import DeleteRowAction from "@/components/DeleteRowAction";

export const dynamic = "force-dynamic";

/**
 * Every order for a stockroom this viewer may stock. Ordering follows the
 * destination room's access, so a client's own purchasing shows up in their
 * portal and a provider only sees orders for rooms they can stock.
 */
export default async function PurchasingPage({ searchParams }: {
  searchParams: Promise<{ q?: string; status?: string; period?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { q = "", status = "", period: periodParam } = await searchParams;

  /* A client contact sees their own orders here and always has. They do NOT
     get the financial section's rail: nine of its ten links redirect them to
     the front page, and an entry that leads nowhere is worse than no entry.
     The figures are not computed for them either - a number they may not have
     never enters the request. */
  const fin = isStaffRole(user.role) ? await railContext(user, periodParam) : null;

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
  const isOpen = (p: typeof pos[number]) => p.status === "draft" || p.status === "sent" || p.status === "partial";

  const needle = q.trim().toLowerCase();
  const hit = (p: typeof pos[number]) =>
    !needle
    || p.number.toLowerCase().includes(needle)
    || p.vendor.toLowerCase().includes(needle)
    || (p.stockroomId !== null && (roomName.get(p.stockroomId) ?? "").toLowerCase().includes(needle));
  const shown = pos.filter((p) => (!status || p.status === status) && hit(p));
  const open = shown.filter(isOpen);
  const closed = shown.filter((p) => !isOpen(p));
  const statusHref = (s: string) => {
    const p = new URLSearchParams();
    if (needle) p.set("q", needle);
    if (s && s !== status) p.set("status", s);
    return `/money/purchasing${p.size ? `?${p}` : ""}`;
  };

  const isOwner = user.role === "owner";
  const toRow = (p: typeof pos[number]): DataRow => {
    const mine = lines.filter((l) => l.poId === p.id);
    const t = poTotals(mine);
    // Order value follows the destination room's owner, same rule as part cost.
    const showCosts = canSeeCosts(user, p.stockroomId === null ? null : roomOrg.get(p.stockroomId) ?? null, p.tenantOrgId);
    return {
      key: p.id,
      href: `/money/purchasing/${p.id}`,
      group: isOpen(p) ? "Open" : "Closed",
      cells: {
        dot: <Dot tone={PO_TONE[p.status] ?? "neutral"} />,
        po: <Id>{p.number}</Id>,
        vendor: (
          <span style={{ minWidth: 0, display: "block" }}>
            <span style={{ fontWeight: 600 }}>{p.vendor}</span>
            <span className="mut t-meta" style={{ display: "block" }}>
              → {p.stockroomId === null ? "(room gone)" : roomName.get(p.stockroomId) ?? "?"}
            </span>
          </span>
        ),
        state: <Pill tone={PO_TONE[p.status] ?? "neutral"}>{PO_LABEL[p.status] ?? p.status}</Pill>,
        recd: <span className="mut">{t.received} of {t.ordered}{p.expectedAt ? ` · exp ${p.expectedAt}` : ""}</span>,
        total: showCosts && t.priced > 0 ? <b className="t-body">{formatCents(t.cents)}</b> : null,
        when: <span className="mut">{shopMonthDay(p.createdAt)}</span>,
        // Only where it could actually work: an order with goods received
        // against it is refused by the server, and offering the button anyway
        // would be offering a refusal.
        act: isOwner && t.received === 0 && p.status !== "received" && p.status !== "partial" ? (
          <DeleteRowAction kind="po" id={p.id} number={p.number} what="the order"
            note="For an order raised by mistake. Its lines go with it; any file or part that names it keeps the paperwork and loses the link." />
        ) : null,
      },
    };
  };

  return (
    <FinanceShell
      rail={fin && { active: "purchasing", amounts: fin.amounts, seesBooks: fin.seesBooks, seesPayroll: fin.seesPayroll }}
      period={fin?.period ?? "month"}
      path="/money/purchasing"
      title="Purchasing"
      sub="Vendor orders and committed spend, whether or not it has been received."
      actions={<>
        <NewPoButton rooms={orderRooms.map((r) => ({ id: r.id, name: r.name }))}
          vendors={isHouse(user.role) ? await makerNames(readTenant(user)) : []} />
        {/* The paper an order already has. Its siblings sit on Invoices and
            Quotes; this is the one a migrating shop needs most, because a part
            on a shelf with no order behind it cannot be traced to what was
            paid for it. */}
        {isHouse(user.role) && (
          <BackfillPoButton rooms={orderRooms.map((r) => ({ id: r.id, name: r.name }))} />
        )}
        <Link href="/stock" className="btn sm plain">Inventory →</Link>
      </>}
    >
      <Toolbar
        search={
          <form action="/money/purchasing">
            {status && <input type="hidden" name="status" value={status} />}
            <input name="q" defaultValue={q} placeholder="PO number, vendor or room" aria-label="Search orders" />
          </form>
        }
        facets={
          <FacetStrip facets={Object.keys(PO_LABEL).map((s) => ({
            key: s, label: PO_LABEL[s],
            count: pos.filter((p) => p.status === s && hit(p)).length || undefined,
            on: status === s, href: statusHref(s),
          }))} />
        }
      />
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

      <DataTable
        cols={[
          { key: "dot", label: "", width: "12px" },
          { key: "po", label: "PO", width: "90px" },
          { key: "vendor", label: "Vendor", width: "minmax(160px, 1.6fr)" },
          { key: "state", label: "Status", width: "120px" },
          { key: "recd", label: "Received", width: "minmax(120px, 1fr)", hideMobile: true },
          { key: "total", label: "Total", width: "90px", align: "right", hideMobile: true },
          { key: "when", label: "Raised", width: "70px", align: "right", hideMobile: true },
          ...(isOwner ? [{ key: "act", label: "", width: "64px" }] : []),
        ]}
        rows={[...open.map(toRow), ...closed.map(toRow)]}
        empty="No orders."
      />
      <Legend items={[
        { tone: "neutral", label: "draft" },
        { tone: "info", label: "ordered" },
        { tone: "warn", label: "part-received" },
        { tone: "good", label: "received" },
        { tone: "faint", label: "cancelled" },
      ]} />
    </FinanceShell>
  );
}
