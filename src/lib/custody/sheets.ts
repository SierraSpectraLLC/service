// Paper and screen, filing the same event.
//
// A sheet is minted (rows and layout frozen, token in the QR), printed, worked
// with a pen, photographed, read back as marks, and CONFIRMED by the person
// who wrote on it - who types the readings the reader will not guess at. A run
// is the same rows on a phone. Both end in filePm, which builds the event
// through lib/custody/pmEvent and appends it; the only difference the record
// keeps is `surface`, and it keeps it in private.
//
// The old surfaces keep working: a run files a Done pm task (so visitsOf still
// counts the visit) and advances the matching schedules' stored columns, until
// Phase 8 retires them for the derived plan.

import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  attachments, custodyAckRequests, custodyEpochs, eventDrafts, instruments, pmSchedules, procedures,
  sheetInstances, signoffs, systemEvents, tasks,
} from "@/db/schema";
import { appendEvent } from "@/lib/custody/append";
import { placeOf } from "@/lib/custody/emit";
import { whoGradeFor } from "@/lib/custody/grades";
import { buildPmEvent, runProblems, type PmRunInput } from "@/lib/custody/pmEvent";
export type RunInput = PmRunInput;
import { planRowsFor } from "@/lib/custody/plan";
import { buildLayout, isSheetLayout, type SheetLayout, type SheetRowSpec } from "@/lib/custody/sheetLayout";
import type { Mark } from "@/lib/custody/marks";
import type { Actor } from "@/lib/custody/transfer";
import { advance as advancePm } from "@/lib/pm";

export type SheetRow = SheetRowSpec & { checklist: string; procedureId: number | null };

/** The steps a machine's sheet or run is made of: its keyed schedules, in schedule order. */
export async function sheetRowsFor(instrumentId: number): Promise<SheetRow[]> {
  const plan = await planRowsFor(instrumentId);
  if (!plan.length) return [];
  const procs = await db.select({ id: procedures.id, key: procedures.key, checklist: procedures.checklist, resultType: procedures.resultType, kind: procedures.kind, parts: procedures.parts, acceptance: procedures.acceptance })
    .from(procedures).where(inArray(procedures.key, plan.map((p) => p.key)));
  const byKey = new Map(procs.map((p) => [p.key, p]));
  return plan.map((p) => {
    const proc = byKey.get(p.key);
    let partNumber = "";
    try { partNumber = proc?.parts ? (JSON.parse(proc.parts) as { number?: string }[])[0]?.number ?? "" : ""; } catch { partNumber = ""; }
    // The READING's unit lives in the acceptance spec (lib/testResult); the
    // usage unit is the cadence's ("injections") and is not it. Both surfaces
    // take the unit from here, never from what somebody typed, so a reading
    // keyed on paper and one keyed on screen carry the same unit or none.
    let unit: string | undefined;
    try { const a = proc?.acceptance ? (JSON.parse(proc.acceptance) as { unit?: string }) : {}; unit = a.unit?.trim() || undefined; } catch { unit = undefined; }
    return {
      key: p.key, title: p.title, intervalDays: p.intervalDays, unit,
      // A TEST asks for a number; a task is a tick.
      reading: proc?.kind === "test" && proc.resultType !== "pass_fail",
      partNumber: partNumber || undefined,
      checklist: proc?.checklist ?? "", procedureId: proc?.id ?? null,
    };
  });
}

const mintToken = () => randomBytes(18).toString("base64url");
export const looksLikeSheetToken = (t: string) => /^[A-Za-z0-9_-]{20,32}$/.test(t);

export async function mintSheet(instrumentId: number, actor: Actor): Promise<{ error?: string; token?: string }> {
  const rows = await sheetRowsFor(instrumentId);
  if (!rows.length) return { error: "Nothing on this machine's plan has a procedure key yet - nothing to print." };
  const layout = buildLayout(rows);
  const [row] = await db.insert(sheetInstances).values({
    token: mintToken(), instrumentId, rows, layout, printedBy: actor.email,
  }).returning({ token: sheetInstances.token });
  return { token: row.token };
}

export async function sheetByToken(token: string) {
  if (!looksLikeSheetToken(token)) return null;
  const [s] = await db.select().from(sheetInstances).where(eq(sheetInstances.token, token)).limit(1);
  if (!s || !isSheetLayout(s.layout)) return null;
  return { ...s, rows: s.rows as SheetRow[], layout: s.layout as SheetLayout };
}

/**
 * The marks the browser read off the photo become a draft. Nothing is history
 * yet. The photo itself is attached to the machine, privately, so the sheet
 * survives as evidence whether or not anybody confirms.
 */
export async function draftFromScan(token: string, marks: Mark[], scan: { fileName: string; url: string; size: number } | null, actor: Actor): Promise<{ error?: string; draftId?: number }> {
  const sheet = await sheetByToken(token);
  if (!sheet) return { error: "Not found" };
  if (sheet.status === "confirmed") return { error: "This sheet has already been filed." };
  if (sheet.status === "void") return { error: "This sheet was voided." };
  const known = new Set(sheet.rows.map((r) => r.key));
  const kept = marks.filter((m) => known.has(m.key));
  let scanAttachmentId: number | null = sheet.scanAttachmentId;
  if (scan) {
    const [inst] = await db.select({ tenantOrgId: instruments.tenantOrgId }).from(instruments).where(eq(instruments.id, sheet.instrumentId));
    const [att] = await db.insert(attachments).values({
      tenantOrgId: inst?.tenantOrgId ?? null, instrumentId: sheet.instrumentId,
      fileName: scan.fileName.slice(0, 200), kind: "Other", url: scan.url, size: scan.size,
      uploadedBy: actor.name || actor.email, description: `PM sheet ${sheet.token.slice(0, 6)} - the filled page`,
    }).returning({ id: attachments.id });
    scanAttachmentId = att.id;
  }
  const [draft] = await db.insert(eventDrafts).values({
    sheetInstanceId: sheet.id, instrumentId: sheet.instrumentId, marks: kept, createdBy: actor.email,
  }).returning({ id: eventDrafts.id });
  await db.update(sheetInstances).set({ status: "uploaded", scanAttachmentId }).where(eq(sheetInstances.id, sheet.id));
  return { draftId: draft.id };
}

/**
 * THE ONE FILING PATH. Both surfaces end here.
 */
async function filePm(instrumentId: number, input: PmRunInput, source: { kind: "scan" | "task"; id: string }, actor: Actor, occurredAt = new Date()) {
  const problems = runProblems(input);
  if (problems.length) return { error: problems.join(" ") };
  const built = buildPmEvent(input);
  const { custodianOrgId, epochId } = await placeOf(instrumentId, occurredAt);
  const authorOrgId = actor.orgId ?? actor.operatorOrgId;
  const appended = await appendEvent({
    instrumentId, kind: built.kind, occurredAt, authorOrgId, custodianOrgId,
    whoGrade: whoGradeFor({ authorOrgId, custodianOrgId, backfilled: false }),
    howGrade: built.howGrade, procedureKeys: built.procedureKeys,
    provenance: built.provenance, private: built.private,
    sourceKind: source.kind, sourceId: source.id, epochId,
  });
  // The technician's signature: their own account, in-app, so `platform` is
  // true. Whether third-party can be claimed is the grade above, which reads
  // the author org against the custodian - the signature does not decide it.
  await db.insert(signoffs).values({
    instrumentId, signedBy: actor.email, signerName: input.technician.trim(),
    meaning: "Performed the maintenance recorded", role: "technician", platform: true, eventId: appended.id,
    data: { eventId: appended.id, steps: built.procedureKeys.length, surface: input.surface },
  });
  // Compatibility: the stored plan columns follow the run until Phase 8 -
  // and only the ACTOR'S OWN schedules. Two service companies can each keep a
  // schedule for the same key on a shared machine, and a run by one of them
  // is a fact about the machine (the chain has it) but not a write into the
  // other's calendar. Same rule the old completion paths lived by: they
  // advanced the caller's row, never somebody else's.
  const done = new Set(built.procedureKeys.filter((k) => k.state === "done").map((k) => k.key));
  const myTenantOrgId = actor.operatorOrgId;
  if (done.size && myTenantOrgId !== null) {
    const today = occurredAt.toISOString().slice(0, 10);
    const scheds = await db.select({ id: pmSchedules.id, everyDays: pmSchedules.everyDays, key: procedures.key })
      .from(pmSchedules).innerJoin(procedures, eq(procedures.id, pmSchedules.procedureId))
      .where(and(eq(pmSchedules.instrumentId, instrumentId), eq(pmSchedules.tenantOrgId, myTenantOrgId)));
    for (const s of scheds) {
      if (!done.has(s.key)) continue;
      await db.update(pmSchedules).set({ lastDone: today, nextDue: advancePm(today, s.everyDays), bookedOn: "", bookedNote: "" }).where(eq(pmSchedules.id, s.id));
    }
  }
  return { eventId: appended.id, created: appended.created };
}

/** Whatever the confirm screen collected, keyed by step. */
export type ConfirmFields = {
  steps: Record<string, { state?: "done" | "skip" | "na"; reading?: string; condition?: string; reason?: string; lot?: string }>;
  findings: string;
  privateNotes: string;
  technician: string;
};

export async function confirmDraft(draftId: number, fields: ConfirmFields, actor: Actor): Promise<{ error?: string; eventId?: number }> {
  const [draft] = await db.select().from(eventDrafts).where(eq(eventDrafts.id, draftId)).limit(1);
  if (!draft) return { error: "Not found" };
  if (draft.confirmedEventId !== null) return { error: "Already filed." };
  const [sheetRow] = await db.select().from(sheetInstances).where(eq(sheetInstances.id, draft.sheetInstanceId)).limit(1);
  if (!sheetRow) return { error: "Not found" };
  const rows = sheetRow.rows as SheetRow[];
  const marks = draft.marks as Mark[];
  const markOf = new Map(marks.map((m) => [m.key, m]));
  // The person's word beats the reader's on every row - they are looking at
  // the sheet. A row the reader could not call and the person did not answer
  // is left out rather than filed as anything.
  const steps: PmRunInput["steps"] = [];
  for (const r of rows) {
    const f = fields.steps[r.key] ?? {};
    const state = f.state ?? markOf.get(r.key)?.state ?? null;
    if (!state) continue;
    steps.push({ key: r.key, state, reading: f.reading, unit: r.unit, condition: f.condition, reason: f.reason, partNumber: r.partNumber, lot: f.lot });
  }
  const input: PmRunInput = {
    steps, findings: fields.findings, privateNotes: fields.privateNotes, setVersion: sheetRow.setVersion,
    surface: "sheet", technician: fields.technician,
  };
  const filed = await filePm(draft.instrumentId, input, { kind: "scan", id: String(draft.id) }, actor);
  if ("error" in filed) return { error: filed.error };
  await db.update(eventDrafts).set({ fields, confirmedEventId: filed.eventId, confirmedAt: new Date() }).where(eq(eventDrafts.id, draft.id));
  await db.update(sheetInstances).set({ status: "confirmed", eventId: filed.eventId }).where(eq(sheetInstances.id, sheetRow.id));
  return { eventId: filed.eventId };
}

/** The screen. One Done pm task is filed too, so the old visit count stays true. */
export async function submitRun(instrumentId: number, input: Omit<PmRunInput, "surface">, actor: Actor): Promise<{ error?: string; eventId?: number; taskId?: number }> {
  const problems = runProblems({ ...input, surface: "screen" });
  if (problems.length) return { error: problems.join(" ") };
  const [inst] = await db.select({ tenantOrgId: instruments.tenantOrgId }).from(instruments).where(eq(instruments.id, instrumentId)).limit(1);
  if (!inst) return { error: "Not found" };
  const now = new Date();
  const [t] = await db.insert(tasks).values({
    tenantOrgId: inst.tenantOrgId, instrumentId, title: `PM run - ${input.steps.length} step${input.steps.length === 1 ? "" : "s"}`,
    body: `Filed from the run screen by ${input.technician.trim()}.`, findings: input.findings.trim(),
    state: "Done", origin: "pm", assignee: input.technician.trim(), dueDate: now.toISOString().slice(0, 10), completedAt: now,
  }).returning({ id: tasks.id });
  const filed = await filePm(instrumentId, { ...input, surface: "screen" }, { kind: "task", id: String(t.id) }, actor, now);
  if ("error" in filed) return { error: filed.error };
  return { eventId: filed.eventId, taskId: t.id };
}

/** Ask the lab to acknowledge. Never gates the event. */
export async function requestAck(eventId: number, actor: Actor): Promise<{ error?: string; requestId?: number; custodianOrgId?: number | null }> {
  const [e] = await db.select().from(systemEvents).where(eq(systemEvents.id, eventId)).limit(1);
  if (!e) return { error: "Not found" };
  const [open] = await db.select({ custodianOrgId: custodyEpochs.custodianOrgId }).from(custodyEpochs)
    .where(and(eq(custodyEpochs.instrumentId, e.instrumentId), eq(custodyEpochs.closeKind, "open"))).limit(1);
  const custodianOrgId = open?.custodianOrgId ?? e.custodianOrgId;
  if (custodianOrgId === null) return { error: "Nobody holds this machine on the platform - there is no one to ask." };
  const [have] = await db.select({ id: custodyAckRequests.id }).from(custodyAckRequests)
    .where(and(eq(custodyAckRequests.eventId, eventId), eq(custodyAckRequests.status, "pending"))).limit(1);
  if (have) return { requestId: have.id, custodianOrgId };
  const [row] = await db.insert(custodyAckRequests).values({ eventId, instrumentId: e.instrumentId, custodianOrgId, requestedBy: actor.email })
    .returning({ id: custodyAckRequests.id });
  return { requestId: row.id, custodianOrgId };
}

/** The lab signs, in their own session. */
export async function signAck(requestId: number, signerName: string, signerTitle: string, actor: Actor): Promise<{ error?: string }> {
  const [r] = await db.select().from(custodyAckRequests).where(eq(custodyAckRequests.id, requestId)).limit(1);
  if (!r || r.status !== "pending") return { error: "Not found" };
  if (r.custodianOrgId === null || (actor.orgId !== r.custodianOrgId && actor.operatorOrgId !== r.custodianOrgId)) {
    return { error: "Only the organization holding the machine acknowledges its maintenance." };
  }
  const name = signerName.trim();
  if (name.length < 2) return { error: "Type your full name to sign" };
  const [s] = await db.insert(signoffs).values({
    instrumentId: r.instrumentId, signedBy: actor.email, signerName: name, signerTitle: signerTitle.trim(),
    meaning: "Acknowledged the maintenance recorded", role: "custodian_ack", platform: true, eventId: r.eventId,
    data: { eventId: r.eventId, requestId: r.id },
  }).returning({ id: signoffs.id });
  await db.update(custodyAckRequests).set({ status: "signed", signoffId: s.id, decidedAt: new Date() }).where(eq(custodyAckRequests.id, r.id));
  return {};
}

/** Pending acknowledgements for one org, for its todo list. */
export const pendingAcksFor = (orgId: number) =>
  db.select({ id: custodyAckRequests.id, eventId: custodyAckRequests.eventId, instrumentId: custodyAckRequests.instrumentId, requestedAt: custodyAckRequests.requestedAt, externalId: instruments.externalId })
    .from(custodyAckRequests).innerJoin(instruments, eq(instruments.id, custodyAckRequests.instrumentId))
    .where(and(eq(custodyAckRequests.custodianOrgId, orgId), eq(custodyAckRequests.status, "pending"), isNull(custodyAckRequests.decidedAt)));
