import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { orgs, stockItems, stockrooms, stockroomShares } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { forTenant, isHouse, readTenant, visibleOrgs } from "@/lib/tenancy";
import { KIND_LABEL, needsReorder, stockAccess, stockTotals } from "@/lib/stock";
import NewStockroomForm from "@/components/NewStockroomForm";
import { DataTable, Dot, FacetStrip, Legend, PageHead, Pill, Toolbar } from "@/components/ui";
import type { DataRow } from "@/components/ui/DataTable";

export const dynamic = "force-dynamic";

/**
 * Every stockroom this viewer may see: the house's shelves, their own
 * organization's, and anyone else's that's been shared with them. Counts and
 * shortages are summarized here so "what needs ordering" is one glance.
 */
export default async function StockPage({ searchParams }: { searchParams: Promise<{ q?: string; kind?: string; short?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { q = "", kind = "", short = "" } = await searchParams;

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

  const totalsOf = new Map(visible.map(({ room }) => [room.id, stockTotals(lines.filter((l) => l.stockroomId === room.id))]));
  const needle = q.trim().toLowerCase();
  const shown = visible.filter(({ room }) => {
    if (kind && room.kind !== kind) return false;
    if (short === "1" && (totalsOf.get(room.id)?.short ?? 0) === 0) return false;
    if (!needle) return true;
    return [room.name, orgName(room.orgId), room.keeper, room.location].join(" ").toLowerCase().includes(needle);
  });
  const href = (next: { kind?: string; short?: string }) => {
    const p = new URLSearchParams();
    const merged = { kind, short, ...next };
    if (needle) p.set("q", needle);
    if (merged.kind) p.set("kind", merged.kind);
    if (merged.short === "1") p.set("short", "1");
    return `/stock${p.size ? `?${p}` : ""}`;
  };

  const toRow = ({ room, acc }: typeof visible[number]): DataRow => {
    const totals = totalsOf.get(room.id) ?? { lines: 0, units: 0, short: 0 };
    return {
      key: room.id,
      href: `/stock/${room.id}`,
      cells: {
        dot: <Dot tone={totals.short > 0 ? "bad" : "neutral"} />,
        name: (
          <span style={{ minWidth: 0, display: "block" }}>
            <span className="t-lead" style={{ fontWeight: 700 }}>{room.name}</span>
            <span className="mut t-meta" style={{ display: "block" }}>
              {orgName(room.orgId)}{room.keeper ? ` · ${room.keeper}` : ""}{room.location ? ` · ${room.location}` : ""}
            </span>
          </span>
        ),
        kind: <span className="mut">{KIND_LABEL[room.kind] ?? room.kind}</span>,
        state: totals.short > 0
          ? <Pill tone="bad">{totals.short} short</Pill>
          : !acc.issue ? <Pill tone="faint">read-only</Pill> : null,
        size: <span className="mut">{totals.lines} line{totals.lines === 1 ? "" : "s"} · {totals.units} unit{totals.units === 1 ? "" : "s"}</span>,
      },
    };
  };

  return (
    <div className="container wide">
      <PageHead
        title="Inventory"
        sub="Shelves, vans and client cages."
        actions={
          <>
            {/* Reachable for org editors too, who don't get the staff nav menu. */}
            {visible.some((v) => v.acc.issue) && (
              <Link href="/money/purchasing" className="btn sm" style={{ textDecoration: "none" }}>Purchase orders</Link>
            )}
            {(isHouse(user.role) || (user.orgId !== null && user.role === "client_editor")) && (
              <NewStockroomForm
                orgOptions={orgRows}
                isHouse={isHouse(user.role)}
                myOrgName={user.orgName || "your organization"}
              />
            )}
          </>
        }
      />
      <Toolbar
        search={
          <form action="/stock">
            {kind && <input type="hidden" name="kind" value={kind} />}
            {short === "1" && <input type="hidden" name="short" value="1" />}
            <input name="q" defaultValue={q} placeholder="Room, organization or keeper" aria-label="Search stockrooms" />
          </form>
        }
        facets={
          <FacetStrip facets={[
            ...Object.entries(KIND_LABEL).map(([k, label]) => ({
              key: k, label,
              count: visible.filter((v) => v.room.kind === k).length || undefined,
              on: kind === k, href: href({ kind: kind === k ? "" : k }),
            })),
            {
              key: "short", label: "Needs ordering",
              count: visible.filter((v) => (totalsOf.get(v.room.id)?.short ?? 0) > 0).length || undefined,
              on: short === "1", href: href({ short: short === "1" ? "" : "1" }),
            },
          ]} />
        }
      />
      <DataTable
        cols={[
          { key: "dot", label: "", width: "12px" },
          { key: "name", label: "Stockroom", width: "minmax(180px, 2fr)" },
          { key: "kind", label: "Kind", width: "110px", hideMobile: true },
          { key: "state", label: "", width: "110px" },
          { key: "size", label: "Holdings", width: "minmax(120px, 1fr)", align: "right", hideMobile: true },
        ]}
        rows={shown.map(toRow)}
        empty="No stockrooms yet - create one with + New stockroom"
      />
      <Legend items={[
        { tone: "bad", label: "lines at or below reorder point" },
        { tone: "neutral", label: "stocked" },
      ]} />
    </div>
  );
}
