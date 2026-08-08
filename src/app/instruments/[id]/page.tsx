import { notFound, redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import {
  instruments, instrumentGases, tasks, checklistItems, itemNotes, taskNotes, parts, attachments, auditLog,
  discussionPosts, people, assets, discussionReads,
} from "@/db/schema";
import { requireUser } from "@/lib/authz";
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

  // neon-http makes each query its own round-trip, so batch the independent
  // ones: wave 1 needs only the id, wave 2 needs taskIds, wave 3 itemIds.
  const [[inst], gasRows, taskRows, partRows, attachRows, activity, stageDefList, gasNames, systemRows, discussion, peopleRows, assetRows, unassignedRows, kindRows, readRows] = await Promise.all([
    db.select().from(instruments).where(eq(instruments.id, instId)),
    db.select().from(instrumentGases).where(eq(instrumentGases.instrumentId, instId)).orderBy(asc(instrumentGases.id)),
    db.select().from(tasks).where(eq(tasks.instrumentId, instId)).orderBy(asc(tasks.sortOrder), asc(tasks.id)),
    db.select().from(parts).where(eq(parts.instrumentId, instId)).orderBy(asc(parts.id)),
    db.select().from(attachments).where(eq(attachments.instrumentId, instId)).orderBy(desc(attachments.createdAt)),
    db.select().from(auditLog).where(eq(auditLog.instrumentId, instId)).orderBy(desc(auditLog.createdAt)).limit(100),
    getStageDefs(),
    db.selectDistinct({ gas: instrumentGases.gas }).from(instrumentGases),
    db.select({ client: instruments.client, category: instruments.category }).from(instruments),
    db.select().from(discussionPosts).where(eq(discussionPosts.instrumentId, instId)).orderBy(asc(discussionPosts.createdAt)),
    db.select({ name: people.name }).from(people).orderBy(asc(people.org), asc(people.name)),
    db.select().from(assets).where(eq(assets.instrumentId, instId)).orderBy(asc(assets.sortOrder), asc(assets.id)),
    db.select().from(assets).where(isNull(assets.instrumentId)).orderBy(asc(assets.kind), asc(assets.model)),
    db.selectDistinct({ kind: assets.kind }).from(assets),
    db.select().from(discussionReads).where(and(eq(discussionReads.userEmail, user.email), eq(discussionReads.threadId, instId))),
  ]);
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

  const canEdit = user.role !== "client_viewer";
  const isStaff = user.role === "owner" || user.role === "staff";

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
            <PushToSheetButton instrumentId={inst.id} externalId={inst.externalId} />
            <Link href={`/instruments/${inst.id}/signoff`} className="btn sm" style={{ textDecoration: "none", flexShrink: 0 }}>
              Sign-off packet
            </Link>
          </>
        )}
      </div>

      <SystemPanel
        instrument={{ id: inst.id, externalId: inst.externalId, client: inst.client, category: inst.category, priority: inst.priority, lead: inst.lead, notes: inst.notes, archived: inst.archived, archivedBy: inst.archivedBy,
          location: inst.location }}
        label={composeSystemLabel(assetRows, inst.model)}
        clients={systemRows.map((c) => c.client)}
        categories={systemRows.map((c) => c.category)}
        stages={inst.stages} stageDefs={stageDefList.map((d) => ({ name: d.name, bg: d.bg, fg: d.fg }))}
        gases={gasRows.map((g) => ({ id: g.id, gas: g.gas, status: g.status, note: g.note }))}
        knownGases={[...new Set([...GASES, ...gasNames.map((g) => g.gas)])]}
        people={peopleRows.map((p) => p.name)}
        canEdit={canEdit} isStaff={isStaff} isOwner={user.role === "owner"}
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

      <PartsPanel target={{ instrumentId: inst.id, assetId: null }} parts={partRows.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() }))} systemAssets={assetRows.map((a) => ({ id: a.id, label: `${a.kind} — ${a.model || a.serial || "?"}` }))} canEdit={canEdit} isStaff={isStaff} />

      <AttachmentsPanel target={{ instrumentId: inst.id, assetId: null }} attachments={attachRows.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() }))} canEdit={canEdit} isStaff={isStaff} />

      <TasksPanel target={{ instrumentId: inst.id, assetId: null }} tasks={fullTasks} people={peopleRows.map((p) => p.name)} systemAssets={assetRows.map((a) => ({ id: a.id, label: `${a.kind} — ${a.model || a.serial || "?"}` }))} today={shopToday()} canEdit={canEdit} isStaff={isStaff} />

      <DiscussionPanel
        instrumentId={inst.id}
        posts={discussion.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() }))}
        canEdit={canEdit}
        newCount={(() => {
          const seen = readRows[0]?.lastSeenAt;
          return discussion.filter((p) => p.authorEmail !== user.email && (!seen || p.createdAt > seen)).length;
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
