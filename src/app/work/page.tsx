import Link from "next/link";
import { redirect } from "next/navigation";
import { desc, eq, inArray, isNull, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { assets, instruments, orgs, tasks, workOrders } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isHouse } from "@/lib/tenancy";
import { visibleAssetIds, visibleSystemIds } from "@/lib/tenancy";
import { getBrand } from "@/lib/brand";
import { getSystemLabels } from "@/lib/systemLabel";
import { shopToday } from "@/lib/shopday";
import { sortWorkOrders, woLine, woOpen, WO_COLOR, WO_LABEL } from "@/lib/workOrders";

export const dynamic = "force-dynamic";

/**
 * Every job this viewer can see, worst first.
 *
 * The page a shop opens in the morning, and the page a client opens to ask "what
 * is happening with the thing we reported". Both get the same list filtered by
 * what they can see, because there is no version of this that is only ours: a
 * work order exists precisely so that both sides can read the same state.
 *
 * Scoped through visibleSystemIds/visibleAssetIds rather than by workspace, so an
 * order on a system shared in from another operator appears here for the people
 * doing the work - which is the whole reason the sharing exists.
 */
export default async function WorkPage({ searchParams }: { searchParams: Promise<{ who?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const today = shopToday();
  // ?who=Name is an engineer's queue - bookmarkable, shareable, and the page
  // the dispatch notification can stand behind. "-" means the triage pile:
  // jobs nobody has taken yet.
  const { who } = await searchParams;

  const [sysIds, unitIds] = await Promise.all([visibleSystemIds(user), visibleAssetIds(user)]);
  const scoped = (col: AnyColumn, ids: number[] | null): SQL | undefined =>
    ids === null ? undefined : ids.length ? inArray(col, ids) : sql`false`;

  // Null on both sides means the house, which sees everything. Otherwise: orders
  // on a system they can see, or on a unit they can see, and nothing else.
  const where = sysIds === null && unitIds === null
    ? undefined
    : or(scoped(workOrders.instrumentId, sysIds), scoped(workOrders.assetId, unitIds));

  const rows = await db.select().from(workOrders).where(where)
    .orderBy(desc(workOrders.createdAt)).limit(500);

  const instIds = [...new Set(rows.flatMap((w) => (w.instrumentId !== null ? [w.instrumentId] : [])))];
  const assetIds = [...new Set(rows.flatMap((w) => (w.assetId !== null ? [w.assetId] : [])))];
  const orgIds = [...new Set(rows.flatMap((w) => (w.orgId !== null ? [w.orgId] : [])))];
  const [instRows, assetRows, orgRows, taskRows, brand] = await Promise.all([
    instIds.length ? db.select().from(instruments).where(inArray(instruments.id, instIds)) : [],
    assetIds.length ? db.select().from(assets).where(inArray(assets.id, assetIds)) : [],
    orgIds.length ? db.select({ id: orgs.id, name: orgs.name }).from(orgs).where(inArray(orgs.id, orgIds)) : [],
    rows.length
      ? db.select({ workOrderId: tasks.workOrderId, state: tasks.state }).from(tasks)
          .where(inArray(tasks.workOrderId, rows.map((w) => w.id)))
      : [],
    getBrand(),
  ]);
  const sysLabels = await getSystemLabels(instRows);
  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));

  const placeOf = (w: typeof rows[number]) => {
    if (w.instrumentId !== null) {
      const i = instRows.find((r) => r.id === w.instrumentId);
      const named = i ? sysLabels.get(i.id) ?? "" : "";
      return i ? (named ? `${i.externalId} - ${named}` : i.externalId) : "?";
    }
    const a = assetRows.find((r) => r.id === w.assetId);
    return a ? `${a.kind}${a.model ? ` — ${a.model}` : ""}${a.serial ? ` (SN ${a.serial})` : ""}` : "?";
  };

  const counts = (id: number) => {
    const mine = taskRows.filter((t) => t.workOrderId === id);
    return { tasks: mine.length, done: mine.filter((t) => t.state === "Done").length };
  };

  const sorted = sortWorkOrders(rows, today);
  const wanted = (w: typeof rows[number]) =>
    !who ? true
    : who === "-" ? !w.assignee.trim()
    : w.assignee.trim().toLowerCase() === who.trim().toLowerCase();
  const live = sorted.filter((w) => (woOpen(w.state) || w.state === "resolved") && wanted(w));
  const filed = sorted.filter((w) => !(woOpen(w.state) || w.state === "resolved") && wanted(w));

  // The queue chips: everyone with open work, plus the viewer even when their
  // plate is clean - "my queue is empty" is an answer worth being able to get.
  const staff = isHouse(user.role);
  const names = [...new Set([
    ...(user.name ? [user.name] : []),
    ...sorted.filter((w) => woOpen(w.state)).map((w) => w.assignee.trim()).filter(Boolean),
  ])].sort((a, b) => a.localeCompare(b));
  const openFor = (name: string) =>
    sorted.filter((w) => woOpen(w.state) && w.assignee.trim().toLowerCase() === name.toLowerCase()).length;
  const unassignedOpen = sorted.filter((w) => woOpen(w.state) && !w.assignee.trim()).length;
  const chip = (href: string, label: string, active: boolean, count?: number) => (
    <Link key={href} href={href} className="pill" style={{
      textDecoration: "none",
      background: active ? "var(--navy)" : "#EEF1F5",
      color: active ? "#fff" : "#475569",
    }}>
      {label}{count !== undefined && count > 0 ? ` · ${count}` : ""}
    </Link>
  );

  const row = (w: typeof rows[number]) => {
    const color = WO_COLOR[w.state] ?? WO_COLOR.open;
    return (
      <Link key={w.id} href={`/work/${w.id}`} className="row-hover"
        style={{
          display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap",
          padding: "8px 4px", borderTop: "1px solid var(--line)", textDecoration: "none", color: "inherit",
        }}>
        <span className="mono" style={{ fontWeight: 700, fontSize: 12, color: "var(--navy)" }}>{w.number}</span>
        <span style={{ fontSize: 13, flex: "1 1 180px" }}>{w.title}</span>
        <span className="pill" style={{ background: color.bg, color: color.fg }}>{WO_LABEL[w.state] ?? w.state}</span>
        <span className="mut" style={{ fontSize: 11, width: "100%" }}>
          {placeOf(w)} · {woLine(w, today, counts(w.id))}
          {` · ${w.orgId === null ? brand.operatorName : orgName.get(w.orgId) ?? "an organization"}`}
        </span>
      </Link>
    );
  };

  return (
    <div className="container page">
      <div className="page-head">
        <h1 className="page-title">Work orders</h1>
      </div>
      {/* Whose queue you're looking at. Staff only - a client's list is already
          just their own jobs, and the shop's roster is not their furniture. */}
      {staff && (names.length > 0 || unassignedOpen > 0) && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {chip("/work", "Everyone", !who)}
          {names.map((n) => chip(`/work?who=${encodeURIComponent(n)}`,
            n === user.name ? `Mine (${n})` : n,
            who?.trim().toLowerCase() === n.toLowerCase(), openFor(n)))}
          {chip("/work?who=-", "Unassigned", who === "-", unassignedOpen)}
        </div>
      )}
      <div className="card">
        {live.map(row)}
        {live.length === 0 && (
          <div className="empty">
            <b>{who ? (who === "-" ? "Nothing waiting for an owner" : `Nothing on ${who}'s plate`) : "Nothing outstanding"}</b>
            {who
              ? "Open jobs land here the moment one is dispatched."
              : "A work order opens when somebody asks for service on a system, or from the Work orders panel on the system itself."}
          </div>
        )}
        {filed.length > 0 && (
          <details style={{ borderTop: "1px solid var(--line)" }}>
            <summary style={{ cursor: "pointer", padding: "8px 4px", fontSize: 12.5 }}>
              <b>Finished</b> <span className="mut">· {filed.length}</span>
            </summary>
            {filed.map(row)}
          </details>
        )}
      </div>
    </div>
  );
}
