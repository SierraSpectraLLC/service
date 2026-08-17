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
import {
  appSettings, assets, checklistItems, instruments, orgs, pmSchedules, procedures, queueEvents,
  systemShares, tasks,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { parseChecklist } from "@/lib/checklist";
import { getBrand } from "@/lib/brand";
import { pmHandoff } from "@/lib/pmQueue";
import { notifyTaskAssigned } from "@/lib/notify";
import { addDays } from "@/lib/pm";
import { scopeMatches, summarizeItem } from "@/lib/checkout";
import { coversSystem } from "@/lib/procedureRole";
import { parseProcParts, partLabel, partsForModel, schedulePartsOf, serializeProcParts } from "@/lib/procedures";

/**
 * Put a procedure's checklist onto a task that was just made from it.
 *
 * Lives here rather than in actions.ts because actions.ts is "use server":
 * exporting it there would publish a callable endpoint that writes checklist
 * items onto any task id, with no access check in front of it. Intake imports
 * it from here for the same reason.
 *
 * Silent on an empty template, which is what most procedures have.
 */
export async function stampChecklist(taskId: number, template: string | null | undefined): Promise<number> {
  const lines = parseChecklist(template ?? "");
  if (!lines.length) return 0;
  await db.insert(checklistItems).values(lines.map((l, idx) => ({
    taskId, text: l.text, heading: l.heading, sortOrder: idx,
  })));
  return lines.length;
}

/**
 * The task a schedule turns into. Shared by the daily generator and by doing a
 * job early on purpose, so the two cannot drift: an engineer starting a PM by
 * hand gets the same title, the same body, the same parts list and the same
 * pmScheduleId link that completion needs in order to advance the cadence.
 */
export async function createPmTask(
  s: typeof pmSchedules.$inferSelect, onSystem: number | null, dueDate: string, actor: string, action: string,
) {
  // The parts travel on the task, so whoever picks it up has the numbers in
  // front of them instead of in a binder.
  const parts = schedulePartsOf(s);
  const partLine = parts.length ? `Part${parts.length === 1 ? "" : "s"}: ${parts.map(partLabel).join(", ")}` : "";
  const [t] = await db.insert(tasks).values({
    // The schedule's workspace, not the cron's: this runs with nobody signed in.
    tenantOrgId: s.tenantOrgId,
    instrumentId: onSystem, assetId: s.assetId,
    title: s.title, body: [s.body, partLine].filter(Boolean).join("\n"),
    assignee: s.assignee,
    dueDate, origin: "pm", pmScheduleId: s.id,
    // The catalog procedure behind the schedule, when there is one. This is
    // how everything procedure-driven reaches RECURRING work the way it
    // already reached intake work: the inspect/replace outcome gate, the
    // IQ/OQ/PQ grouping, the sign-off's mandatory-test check. Without it a
    // recurring task was an orphan that looked identical but enforced nothing.
    procedureId: s.procedureId,
  }).returning();
  // The steps, as boxes rather than as a paragraph in the body. Read off the
  // SCHEDULE, so a unit whose teardown gained a step keeps it every cycle.
  await stampChecklist(t.id, s.checklist);
  await audit({
    actor, instrumentId: onSystem, assetId: s.assetId, entityType: "task", entityId: t.id, action,
  });
  return t;
}

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
    ? await db.select({
        id: instruments.id, externalId: instruments.externalId,
        queueOrgId: instruments.queueOrgId, archived: instruments.archived,
        tenantOrgId: instruments.tenantOrgId,
      }).from(instruments).where(inArray(instruments.id, instIds))
    : [];
  // Who could take the next move on each of these systems. Read once for the
  // whole run rather than per schedule - a fleet of due filters is one query.
  const shareRows = instIds.length
    ? await db.select({ instrumentId: systemShares.instrumentId, orgId: orgs.id, kind: orgs.kind })
        .from(systemShares).innerJoin(orgs, eq(orgs.id, systemShares.orgId))
        .where(inArray(systemShares.instrumentId, instIds))
    : [];
  const handedOff = new Set<number>();
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
    const t = await createPmTask(s, onSystem, s.nextDue, actor,
      `scheduled maintenance came due: '${s.title}'${s.assignee ? ` (assigned ${s.assignee})` : ""} - due ${s.nextDue}`);
    created++;
    if (s.assignee) {
      await notifyTaskAssigned({
        actorEmail: actor, actorName: "Maintenance schedule", assignee: s.assignee,
        taskTitle: s.title, instrumentId: onSystem ?? undefined,
        assetId: s.assetId ?? undefined, externalId: labelFor(s),
      });
    }
    // Due maintenance makes the next move ours, so the queue says so. Once per
    // system per run: three due filters are one handoff, not three.
    if (onSystem !== null && !handedOff.has(onSystem)) {
      handedOff.add(onSystem);
      await handOffForMaintenance(onSystem, s.title, actor, instRows, shareRows);
    }
  }
  return { created };
}

/**
 * Move one system into a provider's queue because maintenance came due.
 *
 * Written here rather than through the queue action because there is no user
 * pressing anything: the rules live in lib/pmQueue, and the same event row and
 * audit line get written so the move reads like any other in the system's
 * history rather than like something that happened to it.
 */
async function handOffForMaintenance(
  instrumentId: number, title: string, actor: string,
  instRows: { id: number; externalId: string; queueOrgId: number | null; archived: boolean; tenantOrgId: number | null }[],
  shareRows: { instrumentId: number; orgId: number; kind: string }[],
): Promise<void> {
  const inst = instRows.find((i) => i.id === instrumentId);
  if (!inst) return;
  const decision = pmHandoff({
    queueOrgId: inst.queueOrgId,
    // The workspace this system belongs to IS the service company for it. The
    // instance-wide "operator org" setting was the single-operator answer to the
    // same question, and it is the thing a second operator gets wrong.
    operatorOrgId: inst.tenantOrgId,
    shares: shareRows.filter((s) => s.instrumentId === instrumentId).map((s) => ({ orgId: s.orgId, kind: s.kind })),
    archived: inst.archived,
  });
  if (!decision.move) return;

  const brand = await getBrand();
  const named = async (orgId: number | null) => {
    if (orgId === null) return brand.operatorName;
    const [o] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId));
    return o?.name ?? "another organization";
  };
  const fromName = await named(inst.queueOrgId);
  const toName = await named(decision.toOrgId);
  const why = `maintenance due: ${title}`;

  await db.update(instruments)
    .set({ queueOrgId: decision.toOrgId, queueReason: why, queueSince: new Date() })
    .where(eq(instruments.id, instrumentId));
  await db.insert(queueEvents).values({
    instrumentId, fromOrgId: inst.queueOrgId, toOrgId: decision.toOrgId,
    fromName, toName, reason: why, actor,
  });
  await audit({
    actor, instrumentId, entityType: "queue", entityId: inst.externalId,
    action: `moved ${inst.externalId} from ${fromName}'s queue to ${toName}'s - ${why}`,
    field: "queue", oldValue: fromName, newValue: toName,
  });
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
    .where(and(eq(procedures.assetType, a.kind), isNotNull(procedures.intervalDays),
      a.tenantOrgId === null ? undefined : eq(procedures.tenantOrgId, a.tenantOrgId)));
  // Category scope: which SYSTEM TYPE the unit serves decides which upkeep it
  // gets - a TOC autosampler must not inherit the LC-MS sampler's procedures.
  // A shelf spare (no system) gets only the unscoped ones; the scoped ones
  // arrive when it is installed, because attach re-runs this.
  const category = a.instrumentId !== null
    ? (await db.select({ category: instruments.category }).from(instruments)
        .where(eq(instruments.id, a.instrumentId)))[0]?.category ?? ""
    : "";
  const matching = rows.filter((p) =>
    (p.modelScope.length === 0 || scopeMatches(p.modelScope, a.model))
    && (p.categoryScope.length === 0 || (category !== "" && scopeMatches(p.categoryScope, category))));
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
      tenantOrgId: a.tenantOrgId,
      instrumentId: null, assetId,
      title: p.name, body, everyDays: p.intervalDays!,
      nextDue: addDays(today, p.intervalDays!),
      // Only the parts that fit THIS unit's model: the catalog row may map a
      // different kit per model, and the LC-30's schedule must not carry the
      // LC-20's part number.
      parts: serializeProcParts(partsForModel(parseProcParts(p.parts), a.model)),
      checklist: p.checklist,
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

/**
 * Stamp every recurring system-level procedure onto one system.
 *
 * The counterpart to applyProcedures, for upkeep that belongs to the instrument
 * as a whole rather than to a unit inside it - an annual full-system PM, a
 * quarterly calibration check. Called when a system is created, when a lone unit
 * is promoted to one, and when a system's category changes - because the
 * category is what decides which of these reach it.
 *
 * Scoped by category (lib/procedureRole). Without that these applied to every
 * system in the workspace, which meant an annual LC-MS PM also landed on every
 * GC, which meant nobody used them and wrote each system's upkeep out by hand
 * instead. An empty scope still covers everything, so procedures defined before
 * the column keep doing exactly what they did.
 *
 * Deduped by procedure and by title, the same way the per-unit version is, so a
 * hand-written schedule blocks the catalog's copy instead of doubling it.
 */
export async function applySystemProcedures(
  instrumentId: number, today: string, actor: string,
): Promise<{ created: number }> {
  const [inst] = await db.select({
    id: instruments.id, externalId: instruments.externalId,
    category: instruments.category, tenantOrgId: instruments.tenantOrgId,
  }).from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { created: 0 };
  const all = await db.select().from(procedures)
    .where(and(eq(procedures.assetType, "system"), isNotNull(procedures.intervalDays),
      inst.tenantOrgId === null ? undefined : eq(procedures.tenantOrgId, inst.tenantOrgId)));
  const rows = all.filter((p) => coversSystem(p.categoryScope, inst.category));
  if (!rows.length) return { created: 0 };

  const existing = await db.select().from(pmSchedules).where(eq(pmSchedules.instrumentId, instrumentId));
  const titles = new Set(existing.map((s) => s.title.toLowerCase()));
  const stamped = new Set(existing.flatMap((s) => (s.procedureId !== null ? [s.procedureId] : [])));

  let created = 0;
  for (const p of rows) {
    if (stamped.has(p.id) || titles.has(p.name.toLowerCase())) continue;
    const body = [p.kind === "test" ? summarizeItem(p) : "", p.notes].filter(Boolean).join("\n");
    await db.insert(pmSchedules).values({
      tenantOrgId: inst.tenantOrgId,
      instrumentId, assetId: null,
      title: p.name, body, everyDays: p.intervalDays!,
      // A cadence out, not day one: a system being set up was just gone over.
      nextDue: addDays(today, p.intervalDays!),
      parts: serializeProcParts(parseProcParts(p.parts)),
      checklist: p.checklist,
      procedureId: p.id, createdBy: actor,
    });
    created++;
  }
  if (created) {
    await audit({
      actor, instrumentId, entityType: "pm", entityId: inst.externalId,
      action: `applied ${created} recurring system procedure${created === 1 ? "" : "s"} to ${inst.externalId}`,
    });
  }
  return { created };
}

/**
 * Backfill one recurring procedure across everything it applies to: every unit
 * of its type, or every system when the procedure is system-level. Without the
 * second half, adding an annual system PM would report that it reached nothing
 * and quietly apply only to systems created afterwards.
 */
export async function backfillProcedure(
  assetType: string, today: string, actor: string,
  // Only across the workspace that defined the procedure. A new operator adding
  // an annual PM must not reach into another operator's fleet.
  tenantOrgId: number | null,
): Promise<number> {
  const sameTenant = (col: typeof instruments.tenantOrgId | typeof assets.tenantOrgId) =>
    tenantOrgId === null ? undefined : eq(col, tenantOrgId);
  let applied = 0;
  if (assetType === "system") {
    const fleet = await db.select({ id: instruments.id }).from(instruments)
      .where(and(eq(instruments.archived, false), sameTenant(instruments.tenantOrgId)));
    for (const i of fleet) applied += (await applySystemProcedures(i.id, today, actor)).created;
    return applied;
  }
  const fleet = await db.select({ id: assets.id }).from(assets)
    .where(and(eq(assets.kind, assetType), sameTenant(assets.tenantOrgId)));
  for (const a of fleet) applied += (await applyProcedures(a.id, today, actor)).created;
  return applied;
}
