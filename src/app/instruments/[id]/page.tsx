import { notFound, redirect } from "next/navigation";
import { asc, desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import {
  instruments, instrumentGases, tasks, checklistItems, itemNotes, taskNotes, parts, attachments, auditLog,
} from "@/db/schema";
import { requireUser } from "@/lib/authz";
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

  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instId));
  if (!inst) notFound();

  const gasRows = await db.select().from(instrumentGases).where(eq(instrumentGases.instrumentId, instId)).orderBy(asc(instrumentGases.id));
  const taskRows = await db.select().from(tasks).where(eq(tasks.instrumentId, instId)).orderBy(asc(tasks.sortOrder), asc(tasks.id));
  const taskIds = taskRows.map((t) => t.id);
  const items = taskIds.length ? await db.select().from(checklistItems).where(inArray(checklistItems.taskId, taskIds)).orderBy(asc(checklistItems.sortOrder), asc(checklistItems.id)) : [];
  const itemIds = items.map((i) => i.id);
  const iNotes = itemIds.length ? await db.select().from(itemNotes).where(inArray(itemNotes.itemId, itemIds)).orderBy(asc(itemNotes.createdAt)) : [];
  const tNotes = taskIds.length ? await db.select().from(taskNotes).where(inArray(taskNotes.taskId, taskIds)).orderBy(asc(taskNotes.createdAt)) : [];
  const partRows = await db.select().from(parts).where(eq(parts.instrumentId, instId)).orderBy(asc(parts.id));
  const attachRows = await db.select().from(attachments).where(eq(attachments.instrumentId, instId)).orderBy(desc(attachments.createdAt));
  const activity = await db.select().from(auditLog).where(eq(auditLog.instrumentId, instId)).orderBy(desc(auditLog.createdAt)).limit(100);

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
      <Link href="/" className="mut" style={{ fontSize: 13, textDecoration: "none", display: "inline-block", marginBottom: 10 }}>
        ← All instruments
      </Link>

      <SystemPanel
        instrument={{ id: inst.id, externalId: inst.externalId, client: inst.client, model: inst.model, priority: inst.priority, notes: inst.notes }}
        stages={inst.stages} gases={gasRows.map((g) => ({ id: g.id, gas: g.gas, status: g.status, note: g.note }))}
        canEdit={canEdit} isStaff={isStaff}
      />

      <PartsPanel instrumentId={inst.id} parts={partRows.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() }))} canEdit={canEdit} isStaff={isStaff} />

      <AttachmentsPanel instrumentId={inst.id} attachments={attachRows.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() }))} canEdit={canEdit} isStaff={isStaff} />

      <TasksPanel instrumentId={inst.id} tasks={fullTasks} canEdit={canEdit} isStaff={isStaff} />

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
              <div className="mut" style={{ fontSize: 11 }}>{a.createdAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
            </div>
          ))}
          {activity.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No activity yet.</div>}
        </div>
      </div>
    </div>
  );
}
