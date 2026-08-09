// The recurring half of the procedure catalog, plus the daily task generator.
//
// generateDuePmTasks - turns due schedules into ordinary tasks. Called by the
// daily cron and again right after a schedule is created or rescheduled, so
// "due today" never waits for tomorrow's run.
//
// applyProcedures - stamps every matching recurring procedure onto one asset.
// Called when an asset is created (including CSV import, which goes through
// the same action) and, across the fleet, when a recurring procedure is
// created. A procedure names the MODEL's upkeep; the schedule it stamps out
// is the UNIT's, and from then on it belongs to the unit - editing or
// deleting the procedure leaves existing schedules alone unless the editor
// explicitly opts in (see updateProcedure).
//
// One open task per schedule, ever: if the last generated task is still open,
// a due schedule generates nothing. That's the difference between a reminder
// and a nag - being three cycles behind on a neglected filter means one task,
// not three copies of it.
import { and, eq, inArray, isNotNull, lte, ne } from "drizzle-orm";
import { db } from "@/db";
import { assets, instruments, pmSchedules, procedures, tasks } from "@/db/schema";
import { audit } from "@/lib/audit";
import { notifyTaskAssigned } from "@/lib/notify";
import { addDays } from "@/lib/pm";
import { scopeMatches, summarizeItem } from "@/lib/checkout";
import { parseProcParts, partLabel, schedulePartsOf, serializeProcParts } from "@/lib/procedures";

export async function generateDuePmTasks(today: string, actor: string): Promise<{ created: number }> {
  const due = await db.select().from(pmSchedules)
    .where(and(eq(pmSchedules.paused, false), lte(pmSchedules.nextDue, today)));
  if (!due.length) return { created: 0 };

  const openPm = await db.select({ pmScheduleId: tasks.pmScheduleId }).from(tasks)
    .where(and(isNotNull(tasks.pmScheduleId), ne(tasks.state, "Done")));
  const alreadyOpen = new Set(openPm.map((t) => t.pmScheduleId));

  // An asset-bound schedule follows its unit around: the task lands on
  // whatever system the unit sits on TODAY, so the system page shows it.
  const assetIds = [...new Set(due.flatMap((s) => (s.assetId !== null ? [s.assetId] : [])))];
  const assetRows = assetIds.length
    ? await db.select({ id: assets.id, instrumentId: assets.instrumentId, kind: assets.kind, model: assets.model, serial: assets.serial })
        .from(assets).where(inArray(assets.id, assetIds))
    : [];
  const instIds = [...new Set([
    ...due.flatMap((s) => (s.instrumentId !== null ? [s.instrumentId] : [])),
    ...assetRows.flatMap((a) => (a.instrumentId !== null ? [a.instrumentId] : [])),
  ])];
  const instRows = instIds.length
    ? await db.select({ id: instruments.id, externalId: instruments.externalId }).from(instruments).where(inArray(instruments.id, instIds))
    : [];
  const labelFor = (s: typeof due[number]) => {
    if (s.instrumentId !== null) return instRows.find((i) => i.id === s.instrumentId)?.externalId ?? "";
    const a = assetRows.find((r) => r.id === s.assetId);
    return a ? `${a.kind}${a.model ? ` ${a.model}` : ""}${a.serial ? ` (SN ${a.serial})` : ""}` : "";
  };

  let created = 0;
  for (const s of due) {
    if (alreadyOpen.has(s.id)) continue;
    const onSystem = s.instrumentId ?? assetRows.find((r) => r.id === s.assetId)?.instrumentId ?? null;
    // The parts travel on the task, so whoever picks it up has the numbers in
    // front of them instead of in a binder.
    const parts = schedulePartsOf(s);
    const partLine = parts.length ? `Part${parts.length === 1 ? "" : "s"}: ${parts.map(partLabel).join(", ")}` : "";
    const [t] = await db.insert(tasks).values({
      instrumentId: onSystem, assetId: s.assetId,
      title: s.title, body: [s.body, partLine].filter(Boolean).join("\n"),
      assignee: s.assignee,
      // The task is due the day the schedule fell due, so a late generation
      // (paused cron, created-overdue schedule) shows up already overdue.
      dueDate: s.nextDue, origin: "pm", pmScheduleId: s.id,
    }).returning();
    created++;
    await audit({
      actor, instrumentId: onSystem, assetId: s.assetId, entityType: "task", entityId: t.id,
      action: `scheduled maintenance came due: '${s.title}'${s.assignee ? ` (assigned ${s.assignee})` : ""} - due ${s.nextDue}`,
    });
    if (s.assignee) {
      await notifyTaskAssigned({
        actorEmail: actor, actorName: "Maintenance schedule", assignee: s.assignee,
        taskTitle: s.title, instrumentId: onSystem ?? undefined,
        assetId: s.assetId ?? undefined, externalId: labelFor(s),
      });
    }
  }
  return { created };
}

/**
 * Stamp every matching recurring procedure onto one asset. Dedupe is per
 * unit, by procedure AND by title, so a hand-written "Replace plunger seals"
 * blocks the catalog's copy instead of doubling it. The first cycle lands one
 * cadence out: a unit entering the shop was just looked at, it doesn't need
 * day-one maintenance. (Recurring matching is simple scope-match - the
 * replace-semantics of intake generation stay with intake, where changing
 * them would change what fires on real units.)
 */
export async function applyProcedures(assetId: number, today: string, actor: string): Promise<{ created: number }> {
  const [a] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!a) return { created: 0 };
  const rows = await db.select().from(procedures)
    .where(and(eq(procedures.assetType, a.kind), isNotNull(procedures.intervalDays)));
  const matching = rows.filter((p) => p.modelScope.length === 0 || scopeMatches(p.modelScope, a.model));
  if (!matching.length) return { created: 0 };

  const existing = await db.select().from(pmSchedules).where(eq(pmSchedules.assetId, assetId));
  const titles = new Set(existing.map((s) => s.title.toLowerCase()));
  const stamped = new Set(existing.flatMap((s) => (s.procedureId !== null ? [s.procedureId] : [])));
  const fresh = matching.filter((p) => !stamped.has(p.id) && !titles.has(p.name.toLowerCase()));

  let created = 0;
  for (const p of fresh) {
    // A recurring TEST becomes a schedule whose tasks carry the criteria in
    // the body - the schedule engine only makes tasks, so the pass/target
    // line rides along as text.
    const body = [p.kind === "test" ? summarizeItem(p) : "", p.notes].filter(Boolean).join("\n");
    await db.insert(pmSchedules).values({
      instrumentId: null, assetId,
      title: p.name, body, everyDays: p.intervalDays!,
      nextDue: addDays(today, p.intervalDays!),
      parts: serializeProcParts(parseProcParts(p.parts)),
      procedureId: p.id, createdBy: actor,
    });
    created++;
  }
  if (created) {
    await audit({
      actor, instrumentId: a.instrumentId, assetId, entityType: "pm", entityId: assetId,
      action: `applied ${created} recurring procedure${created === 1 ? "" : "s"} to ${a.kind}${a.model ? ` ${a.model}` : ""}${a.serial ? ` (SN ${a.serial})` : ""}`,
    });
  }
  return { created };
}

/** Backfill one recurring procedure across every unit of its type. */
export async function backfillProcedure(assetType: string, today: string, actor: string): Promise<number> {
  const fleet = await db.select({ id: assets.id }).from(assets).where(eq(assets.kind, assetType));
  let applied = 0;
  for (const a of fleet) applied += (await applyProcedures(a.id, today, actor)).created;
  return applied;
}
