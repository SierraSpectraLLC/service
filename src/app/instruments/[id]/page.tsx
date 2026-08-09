import { notFound, redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import {
  instruments, instrumentGases, tasks, checklistItems, itemNotes, taskNotes, parts, attachments, auditLog,
  discussionPosts, people, assets, discussionReads, vocabTerms, systemShares, orgs, accessRequests, eodUpdates,
  pmSchedules,
} from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { assertSystemVisible, canEditSystem, visibleSystemIds } from "@/lib/tenancy";
import { canSeeCosts, redactParts } from "@/lib/redact";
import { canSeePost, type Audience } from "@/lib/discussionScope";
import { getBrand } from "@/lib/brand";
import { getModules } from "@/lib/flags";
import { shopTime, shopToday } from "@/lib/shopday";
import { getStageDefs } from "@/lib/stageDefs";
import { partOpen, GASES, MODULE_KINDS } from "@/lib/stages";
import { composeSystemLabel } from "@/lib/systemLabel";
import SystemPanel from "@/components/SystemPanel";
import ActivityNoteForm from "@/components/ActivityNoteForm";
import ActivityFeed from "@/components/ActivityFeed";
import PartsPanel from "@/components/PartsPanel";
import AttachmentsPanel from "@/components/AttachmentsPanel";
import TasksPanel from "@/components/TasksPanel";
import MaintenancePanel from "@/components/MaintenancePanel";
import DiscussionPanel from "@/components/DiscussionPanel";
import PushToSheetButton from "@/components/PushToSheetButton";
import AssetsPanel from "@/components/AssetsPanel";

export const dynamic = "force-dynamic";

export default async function InstrumentPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { id } = await params;
  const instId = parseInt(id);
  if (isNaN(instId)) notFound();
  // A system nobody shared with you doesn't exist as far as you're concerned.
  try { await assertSystemVisible(user, instId); } catch { notFound(); }
  const visible = await visibleSystemIds(user);
  const mine = (col: AnyColumn): SQL | undefined =>
    visible === null ? undefined : visible.length ? inArray(col, visible) : sql`false`;

  // neon-http makes each query its own round-trip, so batch the independent
  // ones: wave 1 needs only the id, wave 2 needs taskIds, wave 3 itemIds.
  const [[inst], gasRows, taskRows, partRows, attachRows, activity, stageDefList, gasNames, systemRows, vocabCats, discussion, peopleRows, assetRows, unassignedRows, kindRows, readRows, shareRows, orgRows] = await Promise.all([
    db.select().from(instruments).where(eq(instruments.id, instId)),
    db.select().from(instrumentGases).where(eq(instrumentGases.instrumentId, instId)).orderBy(asc(instrumentGases.id)),
    db.select().from(tasks).where(eq(tasks.instrumentId, instId)).orderBy(asc(tasks.sortOrder), asc(tasks.id)),
    db.select().from(parts).where(eq(parts.instrumentId, instId)).orderBy(asc(parts.id)),
    db.select().from(attachments).where(eq(attachments.instrumentId, instId)).orderBy(desc(attachments.createdAt)),
    db.select().from(auditLog).where(eq(auditLog.instrumentId, instId)).orderBy(desc(auditLog.createdAt)).limit(100),
    getStageDefs(),
    db.selectDistinct({ gas: instrumentGases.gas }).from(instrumentGases),
    db.select({ client: instruments.client, category: instruments.category }).from(instruments).where(mine(instruments.id)),
    db.select({ name: vocabTerms.name }).from(vocabTerms).where(eq(vocabTerms.kind, "category")),
    db.select().from(discussionPosts).where(eq(discussionPosts.instrumentId, instId)).orderBy(asc(discussionPosts.createdAt)),
    db.select({ name: people.name }).from(people).orderBy(asc(people.org), asc(people.name)),
    db.select().from(assets).where(eq(assets.instrumentId, instId)).orderBy(asc(assets.sortOrder), asc(assets.id)),
    // Shelf stock offered for attaching: the house sees all of it; an org sees
    // only units it owns, never another client's spares.
    db.select().from(assets).where(and(isNull(assets.instrumentId),
      user.orgId === null ? undefined : eq(assets.ownerOrgId, user.orgId))).orderBy(asc(assets.kind), asc(assets.model)),
    db.selectDistinct({ kind: assets.kind }).from(assets),
    db.select().from(discussionReads).where(and(eq(discussionReads.userEmail, user.email), eq(discussionReads.threadId, instId))),
    // Who this system is shared with, and who it could be shared with.
    db.select({ orgId: systemShares.orgId, access: systemShares.access, name: orgs.name, kind: orgs.kind })
      .from(systemShares).innerJoin(orgs, eq(orgs.id, systemShares.orgId))
      .where(eq(systemShares.instrumentId, instId)).orderBy(asc(orgs.name)),
    db.select({ id: orgs.id, name: orgs.name, kind: orgs.kind }).from(orgs).orderBy(asc(orgs.name)),
  ]);
  const pmRows = await db.select().from(pmSchedules).where(eq(pmSchedules.instrumentId, instId)).orderBy(asc(pmSchedules.nextDue));
  if (!inst) notFound();

  // An asset can carry work of its own (recorded on its page, with no system).
  // Count it in the per-asset "open" badge so nothing hides on a subpage.
  const assetIds = assetRows.map((a) => a.id);
  const [ownTasks, ownParts] = await Promise.all([
    assetIds.length
      ? db.select({ assetId: tasks.assetId, state: tasks.state }).from(tasks)
          .where(and(isNull(tasks.instrumentId), inArray(tasks.assetId, assetIds)))
      : [],
    assetIds.length
      ? db.select({ assetId: parts.assetId, status: parts.status }).from(parts)
          .where(and(isNull(parts.instrumentId), inArray(parts.assetId, assetIds)))
      : [],
  ]);

  const taskIds = taskRows.map((t) => t.id);
  const [items, tNotes] = await Promise.all([
    taskIds.length ? db.select().from(checklistItems).where(inArray(checklistItems.taskId, taskIds)).orderBy(asc(checklistItems.sortOrder), asc(checklistItems.id)) : [],
    taskIds.length ? db.select().from(taskNotes).where(inArray(taskNotes.taskId, taskIds)).orderBy(asc(taskNotes.createdAt)) : [],
  ]);
  const itemIds = items.map((i) => i.id);
  const iNotes = itemIds.length ? await db.select().from(itemNotes).where(inArray(itemNotes.itemId, itemIds)).orderBy(asc(itemNotes.createdAt)) : [];

  // A view-level share is read-only even for an org whose role can edit.
  const canEdit = await canEditSystem(user, instId);
  const isStaff = user.role === "owner" || user.role === "staff";
  const modules = await getModules();
  // Today's client-facing update, written here and picked up by the EOD page.
  const ownerIsViewer = inst.ownerOrgId !== null && inst.ownerOrgId === user.orgId;
  const [todayUpdate] = modules.eod && (isStaff || ownerIsViewer)
    ? await db.select().from(eodUpdates)
        .where(and(eq(eodUpdates.instrumentId, instId), eq(eodUpdates.date, shopToday())))
    : [];

  // Discussion. The thread is scoped by the system (checked above), but each
  // post carries its own audience: an internal note belongs to the party that
  // wrote it and is invisible to everyone else, this instance's operator
  // included. Names come from the orgs table so a multi-party thread reads as a
  // conversation between companies rather than a wall of first names.
  const brand = await getBrand();
  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));
  const partyName = (orgId: number | null) => (orgId === null ? brand.operatorName : orgName.get(orgId) ?? "a former organization");
  const viewer = { isHouse: isStaff, orgId: user.orgId };
  const visiblePosts = discussion.filter((p) => canSeePost(viewer, { ...p, audience: p.audience as Audience }));
  const sharedWith = [brand.operatorName, ...shareRows.map((s) => s.name)].join(", ");

  // Pending serial-lookup access requests, for the people who decide them:
  // staff, or the owning organization's editors.
  const isDecider = isStaff || (inst.ownerOrgId !== null && inst.ownerOrgId === user.orgId && user.role === "client_editor");
  const requestRows = isDecider
    ? await db.select({ id: accessRequests.id, kind: accessRequests.kind, requestedBy: accessRequests.requestedBy, message: accessRequests.message, createdAt: accessRequests.createdAt, orgName: orgs.name, orgKind: orgs.kind })
        .from(accessRequests).innerJoin(orgs, eq(orgs.id, accessRequests.orgId))
        .where(and(eq(accessRequests.instrumentId, instId), eq(accessRequests.status, "pending")))
        .orderBy(asc(accessRequests.createdAt))
    : [];

  const fullTasks = taskRows.map((t) => ({
    ...t,
    createdAt: t.createdAt.toISOString(),
    completedAt: t.completedAt?.toISOString() ?? null,
    checklist: items.filter((c) => c.taskId === t.id).map((c) => ({
      ...c,
      thread: iNotes.filter((n) => n.itemId === c.id).map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
    })),
    notes: tNotes.filter((n) => n.taskId === t.id).map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
  }));

  return (
    <div className="container">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Link href="/" className="mut" style={{ fontSize: 13, textDecoration: "none" }}>
          ← All instruments
        </Link>
        {isStaff && (
          <>
            <span style={{ marginLeft: "auto" }} />
            {modules.sheetSync && <PushToSheetButton instrumentId={inst.id} externalId={inst.externalId} />}
            <Link href={`/instruments/${inst.id}/label`} className="btn sm" style={{ textDecoration: "none", flexShrink: 0 }}>
              Label
            </Link>
            <Link href={`/instruments/${inst.id}/signoff`} className="btn sm" style={{ textDecoration: "none", flexShrink: 0 }}>
              Sign-off packet
            </Link>
          </>
        )}
      </div>

      <SystemPanel
        instrument={{ id: inst.id, externalId: inst.externalId, client: inst.client, category: inst.category, priority: inst.priority, lead: inst.lead, notes: inst.notes, archived: inst.archived, archivedBy: inst.archivedBy,
          location: inst.location, forSale: inst.forSale, saleNote: inst.saleNote, listingToken: inst.listingToken }}
        label={composeSystemLabel(assetRows, inst.model)}
        clients={systemRows.map((c) => c.client)}
        categories={[...systemRows.map((c) => c.category), ...vocabCats.map((v) => v.name)]}
        stages={inst.stages} stageDefs={stageDefList.map((d) => ({ name: d.name, bg: d.bg, fg: d.fg }))}
        gases={gasRows.map((g) => ({ id: g.id, gas: g.gas, status: g.status, note: g.note }))}
        knownGases={[...new Set([...GASES, ...gasNames.map((g) => g.gas)])]}
        people={peopleRows.map((p) => p.name)}
        shares={shareRows.map((r) => ({ orgId: r.orgId, name: r.name, kind: r.kind, access: r.access }))}
        orgOptions={orgRows}
        accessRequests={requestRows.map((r) => ({
          id: r.id, orgName: r.orgName, orgKind: r.orgKind, kind: r.kind, requestedBy: r.requestedBy,
          message: r.message, when: shopTime(r.createdAt),
        }))}
        ownerOrgId={inst.ownerOrgId}
        canEdit={canEdit} isStaff={isStaff} isOwner={user.role === "owner"}
        canSell={isStaff || (inst.ownerOrgId !== null && inst.ownerOrgId === user.orgId && user.role === "client_editor")}
        dailyUpdate={modules.eod && (isStaff || ownerIsViewer) ? {
          systemUpdate: todayUpdate?.systemUpdate ?? "", actionItem: todayUpdate?.actionItem ?? "",
          updatedBy: todayUpdate?.updatedBy ?? "", canEdit: isStaff,
        } : null}
      />

      <AssetsPanel
        instrumentId={inst.id}
        assets={assetRows.map((a) => ({
          id: a.id, kind: a.kind, model: a.model, serial: a.serial, status: a.status, note: a.note,
          openItems:
            taskRows.filter((t) => t.assetId === a.id && t.state !== "Done").length +
            partRows.filter((pt) => pt.assetId === a.id && partOpen(pt.status)).length +
            ownTasks.filter((t) => t.assetId === a.id && t.state !== "Done").length +
            ownParts.filter((pt) => pt.assetId === a.id && partOpen(pt.status)).length,
        }))}
        unassigned={unassignedRows.map((a) => ({
          id: a.id,
          label: `${a.kind} — ${a.model || "(no model)"}${a.serial ? ` SN ${a.serial}` : ""}${a.owner ? ` · ${a.owner}` : ""}${a.status !== "Spare" ? ` · ${a.status}` : ""}${a.location ? ` · ${a.location}` : ""}`,
        }))}
        kinds={[...new Set([...MODULE_KINDS, ...kindRows.map((k) => k.kind)].filter(Boolean))]}
        canEdit={canEdit}
      />

      <PartsPanel target={{ instrumentId: inst.id, assetId: null }}
        parts={redactParts(partRows, canSeeCosts(user, inst.ownerOrgId)).map((p) => ({ ...p, createdAt: p.createdAt.toISOString() }))}
        systemAssets={assetRows.map((a) => ({ id: a.id, label: `${a.kind} — ${a.model || a.serial || "?"}` }))}
        canEdit={canEdit} isStaff={isStaff} showCosts={canSeeCosts(user, inst.ownerOrgId)} />

      <AttachmentsPanel target={{ instrumentId: inst.id, assetId: null }} attachments={attachRows.map(({ url: _url, ...a }) => ({ ...a, createdAt: a.createdAt.toISOString() }))} canEdit={canEdit} isStaff={isStaff}
        listingCuration={inst.forSale && (isStaff || (inst.ownerOrgId !== null && inst.ownerOrgId === user.orgId && user.role === "client_editor"))} />

      <TasksPanel target={{ instrumentId: inst.id, assetId: null }} tasks={fullTasks} people={peopleRows.map((p) => p.name)} systemAssets={assetRows.map((a) => ({ id: a.id, label: `${a.kind} — ${a.model || a.serial || "?"}` }))} today={shopToday()} canEdit={canEdit} isStaff={isStaff} />

      <MaintenancePanel target={{ instrumentId: inst.id, assetId: null }} today={shopToday()} canEdit={canEdit}
        people={peopleRows.map((p) => p.name)}
        schedules={pmRows.map((s) => ({
          id: s.id, title: s.title, body: s.body, assignee: s.assignee,
          everyDays: s.everyDays, nextDue: s.nextDue, lastDone: s.lastDone, paused: s.paused,
          openTaskId: taskRows.find((t) => t.pmScheduleId === s.id && t.state !== "Done")?.id ?? null,
        }))} />

      <DiscussionPanel
        instrumentId={inst.id}
        threadId={inst.id}
        posts={visiblePosts.map((p) => ({
          ...p, createdAt: p.createdAt.toISOString(),
          authorParty: partyName(p.authorOrgId), internal: p.audience === "internal",
        }))}
        canEdit={canEdit}
        partyName={partyName(viewer.isHouse ? null : user.orgId)}
        sharedWith={sharedWith}
        newCount={(() => {
          const seen = readRows[0]?.lastSeenAt;
          return visiblePosts.filter((p) => p.authorEmail !== user.email && (!seen || p.createdAt > seen)).length;
        })()}
      />

      <div className="card">
        <div className="card-title">Activity</div>
        <div className="mut" style={{ fontSize: 11, marginBottom: 10 }}>Append-only. Nothing here can be edited or erased.</div>
        {canEdit && <ActivityNoteForm target={{ instrumentId: inst.id, assetId: null }} />}
        <ActivityFeed items={activity.map((a) => ({
          id: a.id, actor: a.actor, action: a.action, field: a.field, newValue: a.newValue,
          when: shopTime(a.createdAt),
        }))} />
      </div>
    </div>
  );
}
