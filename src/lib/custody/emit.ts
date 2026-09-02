// Turning the app's own writes into events on the machine's chain.
//
// Each emitter reads its SOURCE ROW and derives everything, so a call site is
// one line and the classification lives in one place. Each is idempotent on
// (sourceKind, sourceId), which is what makes them safe to call twice and what
// lets scripts/backfill-system-events repair one that failed.
//
// NOTHING READS THESE YET. Writing is deployed ahead of reading on purpose: the
// chain has to have a history before the history can be shown, and a stream
// that starts on the day somebody flips a flag is a stream with a hole in it.
//
// THE SPLIT IS MADE HERE, not filtered later. What travels is what a stranger
// who owns this machine in 2031 needs: what was done, what was found, which
// parts by number. What stays is what belongs to whoever paid: prices, POs, the
// site, the contact, the lot number, the internal note.

import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  assets, checkoutVerdicts, checklistItems, custodyEvents, instruments, parts,
  procedures, pmSchedules, tasks, taskResults, workOrders,
} from "@/db/schema";
import { appendEvent, type AppendResult } from "@/lib/custody/append";
import { howGradeFor, whoGradeFor } from "@/lib/custody/grades";
import { custodianAt, spansOf, type CustodyRow } from "@/lib/custody/spans";
import type { EventKind, OrgId, ProcedureKeyEntry } from "@/lib/custody/types";

/**
 * Who held the machine at a moment, from the handoffs on file.
 *
 * Read fresh per emit rather than cached: an emitter fires once, and a stale
 * custodian is the one field on an event that can never be corrected afterwards
 * (the trigger sees to that).
 */
export async function custodianOfAt(instrumentId: number, at: Date): Promise<OrgId | null> {
  const [inst] = await db.select({ ownerOrgId: instruments.ownerOrgId })
    .from(instruments).where(eq(instruments.id, instrumentId)).limit(1);
  if (!inst) return null;
  const rows = await db.select({
    id: custodyEvents.id, kind: custodyEvents.kind,
    fromOrgId: custodyEvents.fromOrgId, toOrgId: custodyEvents.toOrgId,
    fromName: custodyEvents.fromName, toName: custodyEvents.toName, at: custodyEvents.at,
  }).from(custodyEvents).where(eq(custodyEvents.instrumentId, instrumentId));
  const spans = spansOf(rows as CustodyRow[], { custodianOrgId: inst.ownerOrgId, custodianName: "" });
  if (!spans.length) return inst.ownerOrgId;
  return custodianAt(spans, at).orgId;
}

/**
 * Never let the chain break a customer's day.
 *
 * Nothing reads system_events yet, so a failed append costs nothing that the
 * backfill cannot repair - while a throw here would refuse to close a work
 * order over bookkeeping the user did not ask for and cannot see. Loud in the
 * log, silent to the caller. Revisit when a read path depends on it.
 */
export async function emitSafely(what: string, run: () => Promise<AppendResult | null>): Promise<void> {
  try {
    await run();
  } catch (e) {
    console.error(`[custody] could not record ${what}:`, e instanceof Error ? e.message : e);
  }
}

/** Which flavour of work a job was, from the words the request form offers. */
function kindOfWorkOrder(origin: string, severity: string): EventKind {
  if (origin === "pm_request" || severity === "Planned") return "pm";
  if (severity === "Question") return "inspection";
  return "repair";
}

/**
 * A job that was closed out.
 *
 * The close-out sentence travels; it is the one thing a reader of the record
 * comes back for, and workOrders.closeSummary is already written for somebody
 * other than its author. The ask in the requester's own words does NOT: it
 * names their site, their instrument nickname and often their staff.
 */
export async function emitWorkOrderClosed(woId: number): Promise<AppendResult | null> {
  const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, woId)).limit(1);
  if (!wo || wo.instrumentId === null) return null;
  // CLOSED, not resolved. A resolved job is finished work but the record is
  // still open for correction, and closedAt is what every existing surface
  // treats as the day it happened - see lib/serviceHistory.
  if (wo.state !== "closed") return null;
  const at = wo.closedAt ?? wo.resolvedAt ?? wo.createdAt;

  const [doneTasks, fitted] = await Promise.all([
    db.select({ id: tasks.id }).from(tasks)
      .where(and(eq(tasks.workOrderId, woId), eq(tasks.state, "Done"))),
    // Same rule resolveWorkOrder uses to count them: parts fitted while the job
    // was open. A part is a part whoever asked for it.
    db.select({ name: parts.name, partNumber: parts.partNumber, cost: parts.cost, po: parts.po })
      .from(parts).where(and(
        eq(parts.instrumentId, wo.instrumentId), eq(parts.status, "Installed"),
        wo.openedOn ? gte(sql`${parts.installedAt}`, sql`${wo.openedOn}`) : sql`true`,
      )),
  ]);

  const custodianOrgId = await custodianOfAt(wo.instrumentId, at);
  const planned = wo.severity === "Planned";

  return appendEvent({
    instrumentId: wo.instrumentId,
    assetId: wo.assetId,
    kind: kindOfWorkOrder(wo.origin, wo.severity),
    occurredAt: at,
    authorOrgId: wo.tenantOrgId,
    // Who asked for it. Null is our own staff raising a job themselves.
    commissionerOrgId: wo.orgId,
    custodianOrgId,
    whoGrade: whoGradeFor({ authorOrgId: wo.tenantOrgId, custodianOrgId, backfilled: false }),
    howGrade: howGradeFor({
      results: 0, checklistDone: doneTasks.length, written: wo.closeSummary.length,
    }),
    provenance: {
      summary: wo.closeSummary,
      // Scheduled upkeep or something that broke. The single most useful bit a
      // buyer can have about a line, and it travels.
      planned,
      parts: fitted.filter((p) => p.partNumber).map((p) => ({ partNumber: p.partNumber, name: p.name })),
    },
    private: {
      number: wo.number, title: wo.title, ask: wo.body, severity: wo.severity,
      requestedBy: wo.requestedBy, requestedByEmail: wo.requestedByEmail,
      closedBy: wo.closedBy, assignee: wo.assignee,
      parts: fitted.map((p) => ({ partNumber: p.partNumber, name: p.name, cost: p.cost, po: p.po })),
    },
    sourceKind: "work_order",
    sourceId: String(wo.id),
  });
}

/**
 * A piece of scheduled maintenance somebody completed.
 *
 * Only pm and pm_request tasks. The rest of the task list is the shop's own
 * working notes - "chase the quote", "ring the client back" - and putting it in
 * a machine's permanent record would be filing somebody's to-do list under a
 * serial number forever.
 */
export async function emitPmTask(taskId: number): Promise<AppendResult | null> {
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t || t.instrumentId === null) return null;
  if (t.state !== "Done" || t.completedAt === null) return null;
  if (t.origin !== "pm" && t.origin !== "pm_request") return null;

  const [results, ticked, proc, sched] = await Promise.all([
    db.select({ value: taskResults.value, passed: taskResults.passed, target: taskResults.target, note: taskResults.note })
      .from(taskResults).where(eq(taskResults.taskId, t.id)),
    db.select({ id: checklistItems.id }).from(checklistItems)
      .where(and(eq(checklistItems.taskId, t.id), eq(checklistItems.done, true), eq(checklistItems.heading, false))),
    t.procedureId === null ? Promise.resolve([]) : db.select({ key: procedures.key, name: procedures.name })
      .from(procedures).where(eq(procedures.id, t.procedureId)).limit(1),
    t.pmScheduleId === null ? Promise.resolve([]) : db.select({ title: pmSchedules.title, partNumber: pmSchedules.partNumber })
      .from(pmSchedules).where(eq(pmSchedules.id, t.pmScheduleId)).limit(1),
  ]);

  const key = proc[0]?.key ?? "";
  const result = results[0] ?? null;
  const procedureKeys: ProcedureKeyEntry[] = key
    ? [{
        key, state: "done",
        ...(result?.value ? { reading: result.value } : {}),
        ...(sched[0]?.partNumber ? { partNumber: sched[0].partNumber } : {}),
      }]
    : [];

  const custodianOrgId = await custodianOfAt(t.instrumentId, t.completedAt);

  return appendEvent({
    instrumentId: t.instrumentId,
    assetId: t.assetId,
    kind: "pm",
    occurredAt: t.completedAt,
    authorOrgId: t.tenantOrgId,
    custodianOrgId,
    whoGrade: whoGradeFor({ authorOrgId: t.tenantOrgId, custodianOrgId, backfilled: false }),
    // A checkbox is not evidence - lib/signoff.signoffGate's rule, generalized.
    howGrade: howGradeFor({ results: results.length, checklistDone: ticked.length, written: t.body.length }),
    procedureKeys,
    provenance: {
      title: t.title,
      planned: true,
      ...(result ? { result: { value: result.value, passed: result.passed, target: result.target } } : {}),
    },
    private: {
      body: t.body, assignee: t.assignee, dueDate: t.dueDate,
      ...(result?.note ? { resultNote: result.note } : {}),
    },
    sourceKind: "task",
    sourceId: String(t.id),
  });
}

/**
 * A checkout verdict: the machine measured against a spec, which is the
 * strongest kind of line this app produces.
 *
 * The metrics travel - a grid of numbers is exactly what a buyer's own engineer
 * wants and it names nobody. The report FILE stays: attachments never enter
 * provenance (they carry letterheads, addresses and whatever else was in the
 * PDF), and Phase 7's parser is what promotes their contents.
 */
export async function emitCheckoutVerdict(verdictId: number): Promise<AppendResult | null> {
  const [v] = await db.select().from(checkoutVerdicts).where(eq(checkoutVerdicts.id, verdictId)).limit(1);
  if (!v || v.instrumentId === null) return null;
  const custodianOrgId = await custodianOfAt(v.instrumentId, v.recordedAt);
  let metrics: unknown = [];
  try { metrics = v.metrics ? JSON.parse(v.metrics) : []; } catch { metrics = []; }

  return appendEvent({
    instrumentId: v.instrumentId,
    kind: "qualification",
    occurredAt: v.recordedAt,
    authorOrgId: v.tenantOrgId,
    custodianOrgId,
    whoGrade: whoGradeFor({ authorOrgId: v.tenantOrgId, custodianOrgId, backfilled: false }),
    // A parsed tune report IS the instrument's own output; a typed verdict is
    // somebody's reading of one. Both are real; they are not the same evidence.
    howGrade: v.source === "parsed" ? "procedure_run" : howGradeFor({
      results: Array.isArray(metrics) && metrics.length ? 1 : 0,
      checklistDone: 0, written: v.summary.length, documents: v.reportAttachmentId ? 1 : 0,
    }),
    provenance: { phase: v.phase, verdict: v.verdict, summary: v.summary, metrics },
    private: { reportAttachmentId: v.reportAttachmentId, recordedBy: v.recordedBy, projectId: v.projectId },
    sourceKind: "checkout_verdict",
    sourceId: String(v.id),
  });
}

const CUSTODY_KIND: Record<string, EventKind> = {
  intake: "intake", transfer: "transfer", claim: "claim", release: "release",
};

/**
 * A handoff. Mapped one to one - custody_events already has the right kinds and
 * the right comment about why they matter.
 *
 * The NOTE stays private: it is the outgoing holder's aside about the deal
 * ("shipped without the N2 line, per Ray"), and it is theirs.
 */
export async function emitCustodyEvent(custodyEventId: number): Promise<AppendResult | null> {
  const [c] = await db.select().from(custodyEvents).where(eq(custodyEvents.id, custodyEventId)).limit(1);
  if (!c || c.instrumentId === null) return null;
  const [inst] = await db.select({ tenantOrgId: instruments.tenantOrgId })
    .from(instruments).where(eq(instruments.id, c.instrumentId)).limit(1);

  return appendEvent({
    instrumentId: c.instrumentId,
    kind: CUSTODY_KIND[c.kind] ?? "transfer",
    occurredAt: c.at,
    // The workspace that recorded the handoff, which is who is asserting it.
    authorOrgId: inst?.tenantOrgId ?? null,
    // Who held it going IN, which is the custodian this event ends.
    custodianOrgId: c.fromOrgId,
    whoGrade: "attested",
    howGrade: "document_only",
    provenance: {
      handoff: c.kind,
      // Names, not ids: a custody record has to stay readable after an org row
      // is deleted, which is why custody_events keeps them as text too. The
      // projection anonymizes them by rule (lib/custody/view), not by omission.
      fromName: c.fromName, toName: c.toName,
    },
    private: { note: c.note, actor: c.actor, fromOrgId: c.fromOrgId, toOrgId: c.toOrgId },
    sourceKind: "custody_event",
    sourceId: String(c.id),
  });
}

/** Every asset on a system, for the config events the backfill projects. */
export const assetsOf = (instrumentId: number) =>
  db.select({ id: assets.id }).from(assets).where(eq(assets.instrumentId, instrumentId));
