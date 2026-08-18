import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  assets, attachments, auditLog, checklistItems, instruments, itemNotes, orgs, parts, poLines,
  purchaseOrders, taskNotes, tasks, timeEntries, workOrders,
} from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { assetAccess, assertSystemVisible, canEditSystem, isHouse, readTenant } from "@/lib/tenancy";
import { getBrand } from "@/lib/brand";
import { directoryNames, visibleDirectory } from "@/lib/directory";
import { formatHours } from "@/lib/hours";
import { formatCents } from "@/lib/money";
import { PO_COLOR, PO_LABEL, poTotals } from "@/lib/po";
import { canSeeCosts } from "@/lib/redact";
import { shopTime, shopToday } from "@/lib/shopday";
import { storeQuota } from "@/lib/storeUsage";
import { systemLabel } from "@/lib/systemLabel";
import {
  moverOf, severityOf, targetDay, woAcceptsWork, woLate, WO_COLOR, WO_LABEL,
} from "@/lib/workOrders";
import ActivityFeed from "@/components/ActivityFeed";
import AttachmentsPanel from "@/components/AttachmentsPanel";
import HoursPanel from "@/components/HoursPanel";
import TasksPanel from "@/components/TasksPanel";
import WorkOrderControls from "@/components/WorkOrderControls";
import { loadTaskTests, testFieldsFor } from "@/lib/taskTests";

export const dynamic = "force-dynamic";

/**
 * One job's own page: what was asked for, what is being done about it, and what
 * it cost.
 *
 * The tasks, hours and files panels are the same components the system page uses,
 * pointed at this order - so work filed here carries the order's id and appears
 * on both, and nobody has to learn a second way to log an hour. What is NOT here
 * is a second conversation: the discussion belongs to the system, which is where
 * the client is already looking, and splitting it would mean two places to check
 * for the same answer.
 */
export default async function WorkOrderPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { id } = await params;
  const woId = parseInt(id);
  if (isNaN(woId)) notFound();

  const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, woId));
  if (!wo) notFound();

  // An order on a record you cannot see does not exist for you - the same
  // posture the system and asset pages take, checked against the record rather
  // than against the order, because the record is where access is decided.
  let inst: typeof instruments.$inferSelect | null = null;
  let asset: typeof assets.$inferSelect | null = null;
  let canEdit = false;
  if (wo.instrumentId !== null) {
    try { await assertSystemVisible(user, wo.instrumentId); } catch { notFound(); }
    [inst] = await db.select().from(instruments).where(eq(instruments.id, wo.instrumentId));
    canEdit = await canEditSystem(user, wo.instrumentId);
  } else if (wo.assetId) {
    const acc = await assetAccess(user, wo.assetId);
    if (!acc.see) notFound();
    [asset] = await db.select().from(assets).where(eq(assets.id, wo.assetId));
    canEdit = acc.edit;
  } else {
    notFound();
  }

  const staff = isHouse(user.role);
  const mover = moverOf(
    { isHouse: staff, orgId: user.orgId, houseOrgId: staff ? readTenant(user) : null },
    wo, inst?.ownerOrgId ?? asset?.ownerOrgId ?? null,
  );

  const [taskRows, timeRows, fileRows, people, askedByRows, brand, unitRows] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.workOrderId, woId))
      .orderBy(asc(tasks.sortOrder), asc(tasks.id)),
    db.select().from(timeEntries).where(eq(timeEntries.workOrderId, woId))
      .orderBy(desc(timeEntries.date), desc(timeEntries.id)),
    db.select().from(attachments).where(eq(attachments.workOrderId, woId))
      .orderBy(desc(attachments.createdAt)),
    visibleDirectory(user),
    wo.orgId === null ? Promise.resolve([]) : db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, wo.orgId)),
    getBrand(),
    wo.instrumentId === null ? Promise.resolve([]) : db.select().from(assets)
      .where(eq(assets.instrumentId, wo.instrumentId)).orderBy(asc(assets.sortOrder), asc(assets.id)),
  ]);

  const taskIds = taskRows.map((t) => t.id);
  const [items, tNotes, activity] = await Promise.all([
    taskIds.length ? db.select().from(checklistItems).where(inArray(checklistItems.taskId, taskIds))
      .orderBy(asc(checklistItems.sortOrder), asc(checklistItems.id)) : [],
    taskIds.length ? db.select().from(taskNotes).where(inArray(taskNotes.taskId, taskIds))
      .orderBy(asc(taskNotes.createdAt)) : [],
    db.select().from(auditLog)
      .where(and(eq(auditLog.entityType, "work_order"), eq(auditLog.entityId, String(woId))))
      .orderBy(desc(auditLog.createdAt)).limit(50),
  ]);
  const itemIds = items.map((i) => i.id);
  const iNotes = itemIds.length
    ? await db.select().from(itemNotes).where(inArray(itemNotes.itemId, itemIds)).orderBy(asc(itemNotes.createdAt))
    : [];

  // Which of these are tests, and what each one read - see lib/taskTests.
  const taskTests = await loadTaskTests(taskRows);
  const fullTasks = taskRows.map((t) => ({
    ...t,
    ...testFieldsFor(taskTests, t.id),
    createdAt: t.createdAt.toISOString(),
    completedAt: t.completedAt?.toISOString() ?? null,
    checklist: items.filter((c) => c.taskId === t.id).map((c) => ({
      ...c,
      thread: iNotes.filter((n) => n.itemId === c.id).map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
    })),
    notes: tNotes.filter((n) => n.taskId === t.id).map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
  }));

  // What was bought for this job, and what it cost. Purchasing could never
  // answer "why did we buy this" before; this is the other end of that link,
  // and it is what makes a client's parts allowance defensible with a receipt.
  const poRows = await db.select().from(purchaseOrders)
    .where(eq(purchaseOrders.workOrderId, woId)).orderBy(desc(purchaseOrders.createdAt));
  const poLineRows = poRows.length
    ? await db.select().from(poLines).where(inArray(poLines.poId, poRows.map((p) => p.id)))
    : [];
  // Parts fitted on this job's system that came off one of those orders.
  const partRows = poRows.length && wo.instrumentId !== null
    ? await db.select().from(parts).where(and(
        eq(parts.instrumentId, wo.instrumentId),
        inArray(parts.poId, poRows.map((p) => p.id)),
      ))
    : [];
  // Prices follow the same rule as everywhere else: a partner from another
  // workspace works the job without seeing what the house paid for the parts.
  const showCosts = canSeeCosts(user, inst?.ownerOrgId ?? asset?.ownerOrgId ?? null, wo.tenantOrgId);

  const today = shopToday();
  const sev = severityOf(wo.severity);
  const color = WO_COLOR[wo.state] ?? WO_COLOR.open;
  const askedBy = wo.orgId === null ? brand.operatorName : askedByRows[0]?.name ?? "an organization";
  const minutes = timeRows.reduce((n, t) => n + t.minutes, 0);
  const place = inst
    ? { href: `/instruments/${inst.id}`, label: `${inst.externalId}${systemLabel(inst, unitRows) ? ` - ${systemLabel(inst, unitRows)}` : ""}` }
    : { href: `/assets/${asset!.id}`, label: `${asset!.kind}${asset!.model ? ` — ${asset!.model}` : ""}${asset!.serial ? ` (SN ${asset!.serial})` : ""}` };

  // Work is filed against the ORDER, which resolveTarget then checks belongs to
  // this record - so the panels below write rows that show up in both places.
  // A settled order takes no new work, so they go read-only rather than
  // offering a form that will refuse.
  const target = {
    instrumentId: wo.instrumentId, assetId: wo.instrumentId === null ? wo.assetId : null,
    workOrderId: wo.id,
  };
  const canAdd = canEdit && woAcceptsWork(wo.state);
  // Files alone stay writable on a settled order, house staff only: the
  // signed report arrives weeks after the job is filed, and reopening a
  // closed job to carry one PDF pollutes its state history. The server
  // enforces the same rule (resolveTarget's lateFiles), so this widening is
  // display, not authority.
  const canAttach = canAdd || (canEdit && staff);
  const fileQuota = await storeQuota(inst?.ownerOrgId ?? asset?.ownerOrgId ?? null);

  return (
    <div className="container page">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Link href="/work" className="mut" style={{ fontSize: 13, textDecoration: "none" }}>← All work orders</Link>
        <Link href={place.href} className="mut" style={{ fontSize: 13, textDecoration: "none", marginLeft: "auto" }}>
          {place.label} →
        </Link>
      </div>

      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span className="mono" style={{ fontWeight: 700, fontSize: 13, color: "var(--navy)" }}>{wo.number}</span>
          <span style={{ fontSize: 16, fontWeight: 700 }}>{wo.title}</span>
          <span className="pill" style={{ background: color.bg, color: color.fg }}>{WO_LABEL[wo.state] ?? wo.state}</span>
          <span className="pill" style={{ background: "#EDEBFA", color: "#4F45A3" }}>{sev.label}</span>
          {woLate(wo, today) && (
            <span className="pill" style={{ background: "#FBE9E9", color: "#A32D2D" }}>
              wanted by {targetDay(wo.severity, wo.openedOn)}
            </span>
          )}
        </div>
        <div className="mut" style={{ fontSize: 12, marginTop: 4 }}>
          Asked by {askedBy}
          {wo.requestedBy ? ` · ${wo.requestedBy}` : ""} · opened {wo.openedOn}
          {wo.assignee ? ` · with ${wo.assignee}` : " · nobody assigned"}
          {minutes ? ` · ${formatHours(minutes)} logged` : ""}
        </div>

        {wo.body && (
          <div style={{ fontSize: 13, whiteSpace: "pre-wrap", borderLeft: "3px solid var(--line)", padding: "4px 10px", margin: "10px 0" }}>
            {wo.body}
          </div>
        )}

        {wo.closeSummary && (
          <div style={{ marginTop: 10, background: "#F6FAF6", borderLeft: "3px solid #2E6B2E", padding: "8px 10px" }}>
            <div className="eyebrow" style={{ marginBottom: 2 }}>What was done</div>
            <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{wo.closeSummary}</div>
            {wo.closedBy && <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>Closed by {wo.closedBy}</div>}
          </div>
        )}

        <WorkOrderControls
          id={wo.id} number={wo.number} state={wo.state} mover={mover}
          title={wo.title} body={wo.body} severity={wo.severity} assignee={wo.assignee}
          people={directoryNames(people)}
        />
      </div>

      <TasksPanel target={target} tasks={fullTasks} people={directoryNames(people)}
        systemAssets={unitRows.map((a) => ({ id: a.id, label: `${a.kind} — ${a.model || a.serial || "?"}` }))}
        today={today} canEdit={canAdd} isStaff={staff} copyTargets={[]} />

      <HoursPanel target={target}
        entries={timeRows.map((t) => ({ id: t.id, person: t.person, date: t.date, minutes: t.minutes, note: t.note }))}
        people={directoryNames(people)} defaultPerson={user.name}
        today={today} canEdit={canAdd} isStaff={staff} />

      <AttachmentsPanel target={target} today={shopToday()}
        attachments={fileRows.map(({ url: _url, ...a }) => ({ ...a, createdAt: a.createdAt.toISOString() }))}
        evidenceTasks={taskRows.map((t) => ({ id: t.id, title: t.title, required: false }))}
        canEdit={canAttach} isStaff={staff} listingCuration={false} storage={fileQuota}
        combineTitle={`${wo.number} packet`}
        combineLines={[wo.title, place.label, `Prepared by ${user.name}`].filter(Boolean)} />

      {poRows.length > 0 && (
        <div className="card">
          <div className="card-title">Bought for this job</div>
          {poRows.map((p) => {
            const mine = poLineRows.filter((l) => l.poId === p.id);
            const t = poTotals(mine);
            const receipts = fileRows.filter((f) => f.poId === p.id);
            return (
              <div key={p.id} style={{
                display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap",
                padding: "8px 4px", borderTop: "1px solid var(--line)",
              }}>
                <Link href={`/purchasing/${p.id}`} className="mono"
                  style={{ fontWeight: 700, fontSize: 12, color: "var(--navy)", textDecoration: "none" }}>
                  {p.number}
                </Link>
                <span style={{ fontSize: 13 }}>{p.vendor}</span>
                <span className="pill" style={{ background: PO_COLOR[p.status]?.bg, color: PO_COLOR[p.status]?.fg }}>
                  {PO_LABEL[p.status] ?? p.status}
                </span>
                <span className="mut" style={{ fontSize: 11 }}>
                  {t.received}/{t.ordered} received
                  {receipts.length ? ` · ${receipts.length} receipt${receipts.length === 1 ? "" : "s"} on file` : ""}
                </span>
                {showCosts && t.cents > 0 && (
                  <span className="mono" style={{ fontSize: 11, marginLeft: "auto", color: "var(--slate)" }}>
                    {formatCents(t.cents)}{t.unpriced ? ` +${t.unpriced} unpriced` : ""}
                  </span>
                )}
              </div>
            );
          })}
          {partRows.length > 0 && (
            <div className="mut" style={{ fontSize: 11.5, marginTop: 8 }}>
              {partRows.length} part{partRows.length === 1 ? "" : "s"} from these orders {partRows.length === 1 ? "is" : "are"} on
              the system&apos;s parts list, where the client&apos;s allowance reads them.
            </div>
          )}
        </div>
      )}

      {activity.length > 0 && (
        <div className="card">
          <div className="card-title">History</div>
          <ActivityFeed items={activity.map((a) => ({
            id: a.id, actor: a.actor, action: a.action, field: a.field, newValue: a.newValue,
            when: shopTime(a.createdAt),
          }))} />
        </div>
      )}
    </div>
  );
}
