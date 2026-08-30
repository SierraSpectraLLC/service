// Reads for the restoration module: the gate snapshot, the computed
// provenance, and the queue. The PURE halves live in lib/restoration and
// lib/restorationProvenance; this file only gathers their inputs, so the
// project page, the queue, and the advance action all agree by construction.
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  acceptances, assets, attachments, checklistRunItems, checklistRuns, checkoutVerdicts,
  componentConditions, crateContents, crates, instruments, orgs, outsideWork, parts,
  provenanceAnswers, restorationConfirms, restorationProjects, shipments, tasks,
} from "@/db/schema";
import type { SessionUser } from "@/lib/authz";
import { forTenant, readTenant } from "@/lib/tenancy";
import { interviewComplete, stageGate, type GateItem, type GateSnapshot } from "@/lib/restoration";
import { provenanceOf, type Provenance } from "@/lib/restorationProvenance";
import { getSystemLabels } from "@/lib/systemLabel";

export type RestorationProjectRow = typeof restorationProjects.$inferSelect;

/**
 * Everything the current stage's gate asks about, gathered fresh. The client
 * never hands us gate state - the advance action re-computes this at the
 * moment of advancing, the way a money balance is summed rather than stored.
 */
export async function restorationGateSnapshot(p: RestorationProjectRow): Promise<GateSnapshot> {
  const components = await db.select({ id: assets.id, serial: assets.serial })
    .from(assets).where(eq(assets.instrumentId, p.instrumentId));
  const serialed = components.filter((c) => c.serial.trim() !== "");
  const graded = await db.select({ id: componentConditions.id })
    .from(componentConditions)
    .where(and(eq(componentConditions.projectId, p.id), ne(componentConditions.grade, "")));
  const photos = await db.select({ id: attachments.id }).from(attachments)
    .where(and(eq(attachments.restorationProjectId, p.id), eq(attachments.kind, "Photo")));
  const answers = await db.select().from(provenanceAnswers).where(eq(provenanceAnswers.projectId, p.id));
  const openTasks = await db.select({ id: tasks.id }).from(tasks)
    .where(and(eq(tasks.restorationProjectId, p.id), ne(tasks.state, "Done")));
  const blankParts = await db.select({ id: parts.id }).from(parts)
    .where(and(eq(parts.restorationProjectId, p.id), eq(parts.partNumber, "")));
  const undocumented = await db.select({ id: outsideWork.id }).from(outsideWork)
    .where(and(eq(outsideWork.projectId, p.id), isNull(outsideWork.reportAttachmentId)));
  const verdicts = await db.select().from(checkoutVerdicts)
    .where(eq(checkoutVerdicts.projectId, p.id)).orderBy(desc(checkoutVerdicts.recordedAt));
  const latest = (phase: string) => verdicts.find((v) => v.phase === phase);
  // Unticked non-heading items on this project's checklist runs, by stage.
  const runItems = await db.select({
    stage: checklistRuns.stage, heading: checklistRunItems.heading, checkedAt: checklistRunItems.checkedAt,
  }).from(checklistRunItems)
    .innerJoin(checklistRuns, eq(checklistRunItems.runId, checklistRuns.id))
    .where(eq(checklistRuns.projectId, p.id));
  const openItems = (stage: string) =>
    runItems.filter((i) => i.stage === stage && !i.heading && i.checkedAt === null).length;
  // The crate map: every SERIALIZED component in exactly one crate.
  const crated = await db.select({ assetId: crateContents.assetId }).from(crateContents)
    .innerJoin(crates, eq(crateContents.crateId, crates.id))
    .innerJoin(shipments, eq(crates.shipmentId, shipments.id))
    .where(eq(shipments.projectId, p.id));
  const timesCrated = new Map<number, number>();
  for (const c of crated) timesCrated.set(c.assetId, (timesCrated.get(c.assetId) ?? 0) + 1);
  const mapped = serialed.filter((c) => timesCrated.get(c.id) === 1).length;
  const [shipment] = await db.select().from(shipments).where(eq(shipments.projectId, p.id));
  const [acceptance] = await db.select().from(acceptances).where(eq(acceptances.projectId, p.id));

  return {
    components: { total: components.length, serialed: serialed.length, graded: graded.length },
    arrivalPhotos: photos.length,
    interviewComplete: interviewComplete(new Map(answers.map((a) => [a.questionKey, a.answer]))),
    openTasks: openTasks.length,
    partsLogged: blankParts.length === 0,
    outsideDocumented: undocumented.length === 0,
    verifyVerdictPass: latest("verify")?.verdict === "pass",
    benchOpenItems: openItems("verify_setup"),
    wipeDone: p.wipeCertAttachmentId !== null,
    prepOpenItems: openItems("ship_prep"),
    crateMap: { total: serialed.length, mapped },
    trackingOnFile: !!shipment && shipment.trackingNumber.trim() !== "" && shipment.declaredValueCents > 0,
    buyerSet: p.buyerOrgId !== null,
    onsitePass: latest("commission")?.verdict === "pass",
    acceptanceSigned: !!acceptance?.signedAt,
  };
}

/** The current stage's gate, freshly evaluated - for the advance action and
 * the project page's "Ready to advance?" card. */
export async function evaluateRestorationGate(p: RestorationProjectRow): Promise<GateItem[]> {
  const confirmed = await db.select({ key: restorationConfirms.key }).from(restorationConfirms)
    .where(and(eq(restorationConfirms.projectId, p.id), eq(restorationConfirms.stage, p.stage)));
  const snap = await restorationGateSnapshot(p);
  return stageGate(p.stage, snap, new Set(confirmed.map((c) => c.key)));
}

/**
 * The computed provenance for a batch of projects - bulk queries so the queue
 * costs a handful of round trips, not a handful per row. A single project
 * page passes a list of one.
 */
export async function provenanceForProjects(projects: RestorationProjectRow[]): Promise<Map<number, Provenance>> {
  if (!projects.length) return new Map();
  const ids = projects.map((p) => p.id);
  const instIds = [...new Set(projects.map((p) => p.instrumentId))];

  const [componentRows, answerRows, taskRows, verdictRows, itemRows, outsideRows] = await Promise.all([
    db.select({ instrumentId: assets.instrumentId, serial: assets.serial })
      .from(assets).where(inArray(assets.instrumentId, instIds)),
    db.select().from(provenanceAnswers).where(inArray(provenanceAnswers.projectId, ids)),
    db.select({ projectId: tasks.restorationProjectId, state: tasks.state })
      .from(tasks).where(inArray(tasks.restorationProjectId, ids)),
    db.select().from(checkoutVerdicts)
      .where(inArray(checkoutVerdicts.projectId, ids))
      .orderBy(desc(checkoutVerdicts.recordedAt)),
    db.select({
      projectId: checklistRuns.projectId, heading: checklistRunItems.heading, checkedAt: checklistRunItems.checkedAt,
    }).from(checklistRunItems)
      .innerJoin(checklistRuns, eq(checklistRunItems.runId, checklistRuns.id))
      .where(inArray(checklistRuns.projectId, ids)),
    db.select().from(outsideWork).where(inArray(outsideWork.projectId, ids)),
  ]);

  const out = new Map<number, Provenance>();
  for (const p of projects) {
    const comps = componentRows.filter((c) => c.instrumentId === p.instrumentId);
    const myTasks = taskRows.filter((t) => t.projectId === p.id);
    const items = itemRows.filter((i) => i.projectId === p.id && !i.heading);
    const outside = outsideRows.filter((o) => o.projectId === p.id);
    // Verdict rows come back newest first, so find() is "the latest".
    const latest = (phase: string) => verdictRows.find((v) => v.projectId === p.id && v.phase === phase);
    out.set(p.id, provenanceOf({
      components: { total: comps.length, serialed: comps.filter((c) => c.serial.trim() !== "").length },
      answers: new Map(answerRows.filter((a) => a.projectId === p.id).map((a) => [a.questionKey, a.answer])),
      tasks: myTasks.length ? { total: myTasks.length, done: myTasks.filter((t) => t.state === "Done").length } : null,
      verifyVerdict: latest("verify")?.verdict ?? null,
      onsiteVerdict: latest("commission")?.verdict ?? null,
      pcBackup: p.pcBackupAt !== null,
      wipeCert: p.wipeCertAttachmentId !== null,
      checklists: items.length
        ? { total: items.length, checked: items.filter((i) => i.checkedAt !== null).length }
        : null,
      outsideWork: outside.length
        ? { total: outside.length, documented: outside.filter((o) => o.reportAttachmentId !== null).length }
        : null,
    }));
  }
  return out;
}

export type RestorationQueueRow = {
  project: RestorationProjectRow;
  externalId: string;
  label: string;
  buyerName: string;
  pct: number;
};

/** The queue: every project in the viewer's workspace, most recently worked
 * first, with the computed provenance already on each row. */
export async function restorationQueue(user: SessionUser): Promise<RestorationQueueRow[]> {
  const projects = await db.select().from(restorationProjects)
    .where(forTenant(restorationProjects.tenantOrgId, readTenant(user)))
    .orderBy(desc(restorationProjects.updatedAt)).limit(500);
  if (!projects.length) return [];

  const instIds = [...new Set(projects.map((p) => p.instrumentId))];
  const buyerIds = [...new Set(projects.flatMap((p) => (p.buyerOrgId !== null ? [p.buyerOrgId] : [])))];
  const [instRows, buyerRows, provenance] = await Promise.all([
    db.select({ id: instruments.id, externalId: instruments.externalId, name: instruments.name, model: instruments.model })
      .from(instruments).where(inArray(instruments.id, instIds)),
    buyerIds.length
      ? db.select({ id: orgs.id, name: orgs.name }).from(orgs).where(inArray(orgs.id, buyerIds))
      : [],
    provenanceForProjects(projects),
  ]);
  const labels = await getSystemLabels(instRows);
  const buyerName = new Map(buyerRows.map((o) => [o.id, o.name]));

  return projects.map((p) => {
    const inst = instRows.find((i) => i.id === p.instrumentId);
    return {
      project: p,
      externalId: inst?.externalId ?? "?",
      label: inst ? labels.get(inst.id) ?? inst.model : "",
      buyerName: p.buyerOrgId !== null ? buyerName.get(p.buyerOrgId) ?? "" : "",
      pct: provenance.get(p.id)?.pct ?? 0,
    };
  });
}
