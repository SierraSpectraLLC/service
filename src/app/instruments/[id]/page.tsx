import { notFound, redirect } from "next/navigation";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import {
  instruments, instrumentGases, tasks, checklistItems, itemNotes, taskNotes, parts, attachments, auditLog,
  taskTemplates, discussionPosts, people, instrumentModules, timeEntries, discussionReads,
} from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { shopTime, shopToday } from "@/lib/shopday";
import { getStageDefs } from "@/lib/stageDefs";
import { getStageSince, ageDays } from "@/lib/stageAges";
import SystemPanel from "@/components/SystemPanel";
import ActivityNoteForm from "@/components/ActivityNoteForm";
import ActivityFeed from "@/components/ActivityFeed";
import PartsPanel from "@/components/PartsPanel";
import AttachmentsPanel from "@/components/AttachmentsPanel";
import TasksPanel from "@/components/TasksPanel";
import DiscussionPanel from "@/components/DiscussionPanel";
import PushToSheetButton from "@/components/PushToSheetButton";
import ModulesPanel from "@/components/ModulesPanel";
import TimePanel from "@/components/TimePanel";

export const dynamic = "force-dynamic";

export default async function InstrumentPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { id } = await params;
  const instId = parseInt(id);
  if (isNaN(instId)) notFound();

  // neon-http makes each query its own round-trip, so batch the independent
  // ones: wave 1 needs only the id, wave 2 needs taskIds, wave 3 itemIds.
  const [[inst], gasRows, taskRows, partRows, attachRows, activity, stageDefList, templateList, stageSince, discussion, peopleRows, moduleRows, timeRows, readRows] = await Promise.all([
    db.select().from(instruments).where(eq(instruments.id, instId)),
    db.select().from(instrumentGases).where(eq(instrumentGases.instrumentId, instId)).orderBy(asc(instrumentGases.id)),
    db.select().from(tasks).where(eq(tasks.instrumentId, instId)).orderBy(asc(tasks.sortOrder), asc(tasks.id)),
    db.select().from(parts).where(eq(parts.instrumentId, instId)).orderBy(asc(parts.id)),
    db.select().from(attachments).where(eq(attachments.instrumentId, instId)).orderBy(desc(attachments.createdAt)),
    db.select().from(auditLog).where(eq(auditLog.instrumentId, instId)).orderBy(desc(auditLog.createdAt)).limit(100),
    getStageDefs(),
    db.select({ id: taskTemplates.id, name: taskTemplates.name }).from(taskTemplates).orderBy(asc(taskTemplates.name)),
    getStageSince([instId]),
    db.select().from(discussionPosts).where(eq(discussionPosts.instrumentId, instId)).orderBy(asc(discussionPosts.createdAt)),
    db.select({ name: people.name }).from(people).orderBy(asc(people.org), asc(people.name)),
    db.select().from(instrumentModules).where(eq(instrumentModules.instrumentId, instId)).orderBy(asc(instrumentModules.sortOrder), asc(instrumentModules.id)),
    db.select().from(timeEntries).where(eq(timeEntries.instrumentId, instId)).orderBy(desc(timeEntries.date), desc(timeEntries.id)),
    db.select().from(discussionReads).where(and(eq(discussionReads.userEmail, user.email), eq(discussionReads.threadId, instId))),
  ]);
  if (!inst) notFound();

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
        instrument={{ id: inst.id, externalId: inst.externalId, client: inst.client, model: inst.model, priority: inst.priority, lead: inst.lead, notes: inst.notes, archived: inst.archived, archivedBy: inst.archivedBy,
          manufacturer: inst.manufacturer, serial: inst.serial, location: inst.location }}
        stages={inst.stages} stageDefs={stageDefList.map((d) => ({ name: d.name, bg: d.bg, fg: d.fg }))}
        stageAges={Object.fromEntries(inst.stages.flatMap((s) => {
          const since = stageSince.get(instId)?.get(s) ?? inst.createdAt;
          const d = ageDays(since);
          return d >= 1 ? [[s, `${d}d`]] : [];
        }))}
        gases={gasRows.map((g) => ({ id: g.id, gas: g.gas, status: g.status, note: g.note }))}
        people={peopleRows.map((p) => p.name)}
        canEdit={canEdit} isStaff={isStaff} isOwner={user.role === "owner"}
      />

      <ModulesPanel instrumentId={inst.id} modules={moduleRows.map((m) => ({ id: m.id, kind: m.kind, model: m.model, serial: m.serial, note: m.note }))} canEdit={canEdit} isStaff={isStaff} />

      <PartsPanel instrumentId={inst.id} parts={partRows.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() }))} canEdit={canEdit} isStaff={isStaff} />

      <AttachmentsPanel instrumentId={inst.id} attachments={attachRows.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() }))} canEdit={canEdit} isStaff={isStaff} />

      <TasksPanel instrumentId={inst.id} tasks={fullTasks} templates={templateList} people={peopleRows.map((p) => p.name)} today={shopToday()} canEdit={canEdit} isStaff={isStaff} />

      <TimePanel instrumentId={inst.id} entries={timeRows.map((t) => ({ id: t.id, person: t.person, date: t.date, minutes: t.minutes, note: t.note }))}
        today={shopToday()} people={peopleRows.map((p) => p.name)} canEdit={canEdit} isStaff={isStaff} />

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
        {canEdit && <ActivityNoteForm instrumentId={inst.id} />}
        <ActivityFeed items={activity.map((a) => ({
          id: a.id, actor: a.actor, action: a.action, field: a.field, newValue: a.newValue,
          when: shopTime(a.createdAt),
        }))} />
      </div>
    </div>
  );
}
