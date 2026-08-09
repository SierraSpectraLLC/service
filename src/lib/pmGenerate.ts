// Turns due maintenance schedules into ordinary tasks. Called by the daily
// cron and again right after a schedule is created or rescheduled, so "due
// today" never waits for tomorrow's run.
//
// One open task per schedule, ever: if the last generated task is still open,
// a due schedule generates nothing. That's the difference between a reminder
// and a nag - being three cycles behind on a neglected filter means one task,
// not three copies of it.
import { and, eq, inArray, isNotNull, lte, ne } from "drizzle-orm";
import { db } from "@/db";
import { assets, instruments, pmSchedules, tasks } from "@/db/schema";
import { audit } from "@/lib/audit";
import { notifyTaskAssigned } from "@/lib/notify";

export async function generateDuePmTasks(today: string, actor: string): Promise<{ created: number }> {
  const due = await db.select().from(pmSchedules)
    .where(and(eq(pmSchedules.paused, false), lte(pmSchedules.nextDue, today)));
  if (!due.length) return { created: 0 };

  const openPm = await db.select({ pmScheduleId: tasks.pmScheduleId }).from(tasks)
    .where(and(isNotNull(tasks.pmScheduleId), ne(tasks.state, "Done")));
  const alreadyOpen = new Set(openPm.map((t) => t.pmScheduleId));

  // Labels for the audit line and the assignment email.
  const instIds = [...new Set(due.flatMap((s) => (s.instrumentId !== null ? [s.instrumentId] : [])))];
  const assetIds = [...new Set(due.flatMap((s) => (s.assetId !== null ? [s.assetId] : [])))];
  const [instRows, assetRows] = await Promise.all([
    instIds.length ? db.select({ id: instruments.id, externalId: instruments.externalId }).from(instruments).where(inArray(instruments.id, instIds)) : [],
    assetIds.length ? db.select({ id: assets.id, kind: assets.kind, model: assets.model, serial: assets.serial }).from(assets).where(inArray(assets.id, assetIds)) : [],
  ]);
  const labelFor = (s: typeof due[number]) => {
    if (s.instrumentId !== null) return instRows.find((i) => i.id === s.instrumentId)?.externalId ?? "";
    const a = assetRows.find((r) => r.id === s.assetId);
    return a ? `${a.kind}${a.model ? ` ${a.model}` : ""}${a.serial ? ` (SN ${a.serial})` : ""}` : "";
  };

  let created = 0;
  for (const s of due) {
    if (alreadyOpen.has(s.id)) continue;
    const [t] = await db.insert(tasks).values({
      instrumentId: s.instrumentId, assetId: s.assetId,
      title: s.title, body: s.body, assignee: s.assignee,
      // The task is due the day the schedule fell due, so a late generation
      // (paused cron, created-overdue schedule) shows up already overdue.
      dueDate: s.nextDue, origin: "pm", pmScheduleId: s.id,
    }).returning();
    created++;
    await audit({
      actor, instrumentId: s.instrumentId, assetId: s.assetId, entityType: "task", entityId: t.id,
      action: `scheduled maintenance came due: '${s.title}'${s.assignee ? ` (assigned ${s.assignee})` : ""} - due ${s.nextDue}`,
    });
    if (s.assignee) {
      await notifyTaskAssigned({
        actorEmail: actor, actorName: "Maintenance schedule", assignee: s.assignee,
        taskTitle: s.title, instrumentId: s.instrumentId ?? undefined,
        assetId: s.assetId ?? undefined, externalId: labelFor(s),
      });
    }
  }
  return { created };
}
