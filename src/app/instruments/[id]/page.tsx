import { notFound, redirect } from "next/navigation";
import { asc, desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import {
  instruments, instrumentGases, tasks, checklistItems, itemNotes, taskNotes, parts, attachments, auditLog,
  taskTemplates,
} from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { shopTime } from "@/lib/shopday";
import { getStageDefs } from "@/lib/stageDefs";
import { getStageSince, ageDays } from "@/lib/stageAges";
import SystemPanel from "@/components/SystemPanel";
import ActivityNoteForm from "@/components/ActivityNoteForm";
import PartsPanel from "@/components/PartsPanel";
import AttachmentsPanel from "@/components/AttachmentsPanel";
import TasksPanel from "@/components/TasksPanel";

export const dynamic = "force-dynamic";

export default async function InstrumentPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { id } = await params;
  const instId = parseInt(id);
  if (isNaN(instId)) notFound();

  // neon-http makes each query its own round-trip, so batch the independent
  // ones: wave 1 needs only the id, wave 2 needs taskIds, wave 3 itemIds.
  const [[inst], gasRows, taskRows, partRows, attachRows, activity, stageDefList, templateList, stageSince] = await Promise.all([
    db.select().from(instruments).where(eq(instruments.id, instId)),
    db.select().from(instrumentGases).where(eq(instrumentGases.instrumentId, instId)).orderBy(asc(instrumentGases.id)),
    db.select().from(tasks).where(eq(tasks.instrumentId, instId)).orderBy(asc(tasks.sortOrder), asc(tasks.id)),
    db.select().from(parts).where(eq(parts.instrumentId, instId)).orderBy(asc(parts.id)),
    db.select().from(attachments).where(eq(attachments.instrumentId, instId)).orderBy(desc(attachments.createdAt)),
    db.select().from(auditLog).where(eq(auditLog.instrumentId, instId)).orderBy(desc(auditLog.createdAt)).limit(100),
    getStageDefs(),
    db.select({ id: taskTemplates.id, name: taskTemplates.name }).from(taskTemplates).orderBy(asc(taskTemplates.name)),
    getStageSince([instId]),
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
          <Link href={`/instruments/${inst.id}/signoff`} className="btn sm" style={{ marginLeft: "auto", textDecoration: "none" }}>
            Sign-off packet
          </Link>
        )}
      </div>

      <SystemPanel
        instrument={{ id: inst.id, externalId: inst.externalId, client: inst.client, model: inst.model, priority: inst.priority, notes: inst.notes }}
        stages={inst.stages} stageDefs={stageDefList.map((d) => ({ name: d.name, bg: d.bg, fg: d.fg }))}
        stageAges={Object.fromEntries(inst.stages.flatMap((s) => {
          const since = stageSince.get(instId)?.get(s) ?? inst.createdAt;
          const d = ageDays(since);
          return d >= 1 ? [[s, `${d}d`]] : [];
        }))}
        gases={gasRows.map((g) => ({ id: g.id, gas: g.gas, status: g.status, note: g.note }))}
        canEdit={canEdit} isStaff={isStaff} isOwner={user.role === "owner"}
      />

      <PartsPanel instrumentId={inst.id} parts={partRows.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() }))} canEdit={canEdit} isStaff={isStaff} />

      <AttachmentsPanel instrumentId={inst.id} attachments={attachRows.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() }))} canEdit={canEdit} isStaff={isStaff} />

      <TasksPanel instrumentId={inst.id} tasks={fullTasks} templates={templateList} canEdit={canEdit} isStaff={isStaff} />

      <div className="card">
        <div className="card-title">Activity</div>
        <div className="mut" style={{ fontSize: 11, marginBottom: 10 }}>Append-only. Nothing here can be edited or erased.</div>
        {canEdit && <ActivityNoteForm instrumentId={inst.id} />}
        <div style={{ borderLeft: "2px solid var(--line)", paddingLeft: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {activity.map((a) => (
            <div key={a.id}>
              <div style={{ fontSize: 13 }}>
                <b>{a.actor === "sheet-sync" ? "Sheet sync" : a.actor.split("@")[0]}</b>{" "}
                <span className="mut">{a.action}</span>
              </div>
              {a.field === "note" && a.newValue && <div style={{ fontSize: 13, marginTop: 2 }}>{a.newValue}</div>}
              <div className="mut" style={{ fontSize: 11 }}>{shopTime(a.createdAt)}</div>
            </div>
          ))}
          {activity.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No activity yet.</div>}
        </div>
      </div>
    </div>
  );
}
