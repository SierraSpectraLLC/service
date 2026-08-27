import { redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { assets, instruments, orgs, tasks, workOrders } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { forTenant, isHouse, readTenant, viewTenant, visibleAssetIds, visibleOrgs, visibleSystemIds } from "@/lib/tenancy";
import { brandForTenant } from "@/lib/brand";
import { getSystemLabels } from "@/lib/systemLabel";
import { shopToday } from "@/lib/shopday";
import { creditForMany } from "@/lib/invoiceData";
import type { CreditStanding } from "@/lib/credit";
import { ageDays, sortWorkOrders, woLate, woOpen, WO_LABEL, WO_TONE } from "@/lib/workOrders";
import { DataTable, Dot, FacetStrip, Id, Legend, PageHead, Pill, Toolbar } from "@/components/ui";
import type { DataRow } from "@/components/ui/DataTable";
import NewWorkOrderButton from "@/components/NewWorkOrderButton";
import { directoryNames, visibleDirectory } from "@/lib/directory";

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
export default async function WorkPage({ searchParams }: { searchParams: Promise<{ who?: string; q?: string; done?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const today = shopToday();
  // ?who=Name is an engineer's queue - bookmarkable, shareable, and the page
  // the dispatch notification can stand behind. "-" means the triage pile:
  // jobs nobody has taken yet. ?q= searches, ?done=1 folds the finished
  // orders in; all of it lives in the URL so a filtered view can be shared.
  const { who, q, done } = await searchParams;

  const [sysIds, unitIds] = await Promise.all([visibleSystemIds(user), visibleAssetIds(user)]);
  const scoped = (col: AnyColumn, ids: number[] | null): SQL | undefined =>
    ids === null ? undefined : ids.length ? inArray(col, ids) : sql`false`;

  // Null on both sides means the house, which sees everything. Otherwise: orders
  // on a system they can see, on a unit they can see, or - for a job with no
  // record behind it - one opened for their own organization. That last is not
  // a widening: without it a client cannot see the move they asked us for,
  // because there is no system to hang the permission on.
  const recordless = and(isNull(workOrders.instrumentId), isNull(workOrders.assetId));
  const mine = isHouse(user.role)
    // The shop sees the record-less jobs its own workspace opened. Without
    // this an operator whose scope is an id list - which is every operator
    // but the one running the instance - could not see the moves and surveys
    // they filed themselves.
    ? and(recordless, forTenant(workOrders.tenantOrgId, readTenant(user)))
    : user.orgId === null ? sql`false` : and(recordless, eq(workOrders.orgId, user.orgId));
  const where = sysIds === null && unitIds === null
    ? undefined
    : or(scoped(workOrders.instrumentId, sysIds), scoped(workOrders.assetId, unitIds), mine);

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
    // The workspace this page speaks for, not the one that runs the instance.
    // getBrand().operatorName is the landlord's company name, and these render
    // it as "who has your equipment" / "who asked for this job".
    viewTenant(user).then(brandForTenant),
  ]);
  const sysLabels = await getSystemLabels(instRows);
  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));

  const placeOf = (w: typeof rows[number]) => {
    // A job can be a client's rather than a system's - a move, a survey, a
    // call. "No system" is the truth about it, not a missing lookup, so it
    // says so rather than showing the "?" that means something is broken.
    if (w.instrumentId === null && w.assetId === null) return "No system";
    if (w.instrumentId !== null) {
      const i = instRows.find((r) => r.id === w.instrumentId);
      const named = i ? sysLabels.get(i.id) ?? "" : "";
      return i ? (named ? `${i.externalId} - ${named}` : i.externalId) : "?";
    }
    const a = assetRows.find((r) => r.id === w.assetId);
    return a ? `${a.kind}${a.model ? ` - ${a.model}` : ""}${a.serial ? ` (SN ${a.serial})` : ""}` : "?";
  };

  const counts = (id: number) => {
    const mine = taskRows.filter((t) => t.workOrderId === id);
    return { tasks: mine.length, done: mine.filter((t) => t.state === "Done").length };
  };

  const sorted = sortWorkOrders(rows, today);
  const orgOf = (w: typeof rows[number]) =>
    w.orgId === null ? brand.operatorName : orgName.get(w.orgId) ?? "an organization";
  const wanted = (w: typeof rows[number]) =>
    !who ? true
    : who === "-" ? !w.assignee.trim()
    : w.assignee.trim().toLowerCase() === who.trim().toLowerCase();
  const needle = (q ?? "").trim().toLowerCase();
  const hit = (w: typeof rows[number]) =>
    !needle
    || w.number.toLowerCase().includes(needle)
    || w.title.toLowerCase().includes(needle)
    || placeOf(w).toLowerCase().includes(needle)
    || w.assignee.toLowerCase().includes(needle)
    || orgOf(w).toLowerCase().includes(needle);
  const live = sorted.filter((w) => (woOpen(w.state) || w.state === "resolved") && wanted(w) && hit(w));
  const filed = sorted.filter((w) => !(woOpen(w.state) || w.state === "resolved") && wanted(w) && hit(w));
  const showDone = done === "1";

  // The queue facets: everyone with open work, plus the viewer even when their
  // plate is clean - "my queue is empty" is an answer worth being able to get.
  const staff = isHouse(user.role);
  // Who is on credit hold, so a dispatcher sees it in the list rather than
  // after opening the job. Staff only - a client has no business reading
  // another client's standing, and no business reading a hold column about
  // themselves in a work queue.
  const holds: Map<number, CreditStanding> = staff ? await creditForMany(orgIds, today) : new Map();
  const names = [...new Set([
    ...(user.name ? [user.name] : []),
    ...sorted.filter((w) => woOpen(w.state)).map((w) => w.assignee.trim()).filter(Boolean),
  ])].sort((a, b) => a.localeCompare(b));
  const openFor = (name: string) =>
    sorted.filter((w) => woOpen(w.state) && w.assignee.trim().toLowerCase() === name.toLowerCase()).length;
  const unassignedOpen = sorted.filter((w) => woOpen(w.state) && !w.assignee.trim()).length;

  // What a new job can be opened on: the clients this person may name, and the
  // systems they can already see. A client's login gets their own org and
  // nothing else - the picker is not a place to discover who else we work for.
  const mayOpen = user.role !== "client_viewer";
  const [clientRows, sysRows, people] = await Promise.all([
    mayOpen ? visibleOrgs(user) : [],
    mayOpen
      ? db.select({
          id: instruments.id, externalId: instruments.externalId, model: instruments.model,
          ownerOrgId: instruments.ownerOrgId, archived: instruments.archived,
        }).from(instruments)
          .where(scoped(instruments.id, sysIds))
          .orderBy(asc(instruments.externalId))
      : [],
    mayOpen && staff ? visibleDirectory(user) : [],
  ]);
  const openable = sysRows.filter((r) => !r.archived);
  const openLabels = await getSystemLabels(openable);
  const clients = clientRows
    .filter((o) => !o.isOperator && (staff || o.id === user.orgId))
    .map((o) => ({ id: o.id, name: o.name }));

  const href = (params: { who?: string; done?: boolean }) => {
    const p = new URLSearchParams();
    const w = "who" in params ? params.who : who;
    if (w) p.set("who", w);
    if (needle) p.set("q", needle);
    if (params.done ?? showDone) p.set("done", "1");
    const s = p.toString();
    return s ? `/work?${s}` : "/work";
  };

  const toRow = (w: typeof rows[number]): DataRow => {
    const tone = WO_TONE[w.state] ?? WO_TONE.open;
    const days = ageDays(w.openedOn, today);
    const c = counts(w.id);
    return {
      key: w.id,
      href: `/work/${w.id}`,
      cells: {
        dot: <Dot tone={tone} />,
        wo: <Id>{w.number}</Id>,
        title: <b style={{ fontWeight: 600 }}>{w.title}</b>,
        place: <span className="mut">{placeOf(w)} · {orgOf(w)}</span>,
        who: <span className="mut">{woOpen(w.state) ? (w.assignee.trim() || "unassigned") : ""}</span>,
        state: (
          <Pill tone={tone}>
            {(WO_LABEL[w.state] ?? w.state) + (woLate(w, today) ? " · late" : "")}
          </Pill>
        ),
        hold: w.orgId !== null && holds.get(w.orgId)?.onHold
          ? <Pill tone="bad">On hold</Pill>
          : w.orgId !== null && holds.get(w.orgId)?.override
            ? <Pill tone="warn">Overridden</Pill>
            : null,
        age: woOpen(w.state)
          ? <span className="mut">{days === 0 ? "today" : `${days} d`}{c.tasks > 0 ? ` · ${c.done}/${c.tasks}` : ""}</span>
          : null,
      },
    };
  };

  return (
    <div className="container wide">
      <PageHead title="Work orders" />
      <Toolbar
        search={
          <form action="/work">
            {who && <input type="hidden" name="who" value={who} />}
            {showDone && <input type="hidden" name="done" value="1" />}
            <input name="q" defaultValue={needle} placeholder="Number, title, system or client"
              aria-label="Search work orders" />
          </form>
        }
        actions={mayOpen ? (
          <NewWorkOrderButton
            clients={clients}
            systems={openable.map((r) => ({
              id: r.id, externalId: r.externalId,
              label: openLabels.get(r.id) ?? r.model, ownerOrgId: r.ownerOrgId,
            }))}
            people={directoryNames(people)}
            canPickHouse={staff}
          />
        ) : undefined}
        facets={
          <>
            {/* Whose queue you're looking at. Staff only - a client's list is
                already just their own jobs. */}
            {staff && (names.length > 0 || unassignedOpen > 0) && (
              <FacetStrip facets={[
                { key: "all", label: "Everyone", on: !who, href: href({ who: undefined }) },
                ...names.map((n) => ({
                  key: n,
                  label: n === user.name ? "Mine" : n,
                  count: openFor(n) || undefined,
                  on: who?.trim().toLowerCase() === n.toLowerCase(),
                  href: href({ who: n }),
                })),
                { key: "unassigned", label: "Unassigned", count: unassignedOpen || undefined, on: who === "-", href: href({ who: "-" }) },
              ]} />
            )}
            <FacetStrip facets={[
              { key: "done", label: "Finished", count: filed.length, on: showDone, href: href({ done: !showDone }) },
            ]} />
          </>
        }
      />
      <DataTable
        cols={[
          { key: "dot", label: "", width: "12px" },
          { key: "wo", label: "WO", width: "84px" },
          { key: "title", label: "Job", width: "minmax(170px, 1.6fr)" },
          { key: "place", label: "System", width: "minmax(160px, 1.3fr)", hideMobile: true },
          { key: "who", label: "Assignee", width: "100px", hideMobile: true },
          { key: "state", label: "State", width: "120px" },
          ...(staff ? [{ key: "hold", label: "Credit", width: "96px", hideMobile: true }] : []),
          { key: "age", label: "Age", width: "84px", hideMobile: true },
        ]}
        rows={[
          ...live.map(toRow),
          ...(showDone ? filed.map((w) => ({ ...toRow(w), group: "Finished" })) : []),
        ]}
        empty={who ? (who === "-" ? "Nothing waiting for an owner" : `Nothing on ${who}'s plate`) : "Nothing outstanding"}
      />
      <Legend items={[
        { tone: "neutral", label: "open" },
        { tone: "info", label: "in progress" },
        { tone: "warn", label: "waiting on someone" },
        { tone: "good", label: "resolved" },
        { tone: "faint", label: "cancelled" },
      ]} />
    </div>
  );
}
