"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { eq, and, asc, desc, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { redirect } from "next/navigation";
import {
  instruments, instrumentGases, tasks, checklistItems, itemNotes, taskNotes, parts, attachments,
  sheetDiffs, appSettings, eodUpdates, clientAllowlist, users, sessions, stageDefs,
  stageEvents, discussionPosts, assets, serviceVisits, assetEvents, discussionReads, vocabTerms, systemShares, orgs, timeEntries,
  engagementRecords, accessRequests, assetShares, pmSchedules, procedures, signoffs, partPrices,
  notifications, notificationPrefs, stockrooms, stockroomShares, stockItems, stockMoves,
  purchaseOrders, poLines, custodyEvents, queueEvents, houseMembers, uiLayouts, remoteDevices,
  workOrders, orgSites, partCatalog, partKitLines, partNumbers, partPhotos, agreements,
  catalogRefs, taskResults, folders, dropLinks, shareLinks, shareLinkFiles,
  validationDocs, validationSignatures, messageThreads, threadMembers, messages,
} from "@/db/schema";
import { siteLabel } from "@/lib/sites";
import {
  allNumbers, catalogEntry, catalogName, cleanAliases, currentNumber, MAX_PART_PHOTOS,
  numberClash, PART_KINDS, PART_KIND_LABEL, type PartAlias,
} from "@/lib/partCatalog";
// Aliased: lib/stock exports a KIND_LABEL too (shelf, van, ...), imported below
// and lexically first, so the bare name here silently meant the wrong map -
// which made every new agreement throw on its own audit line.
import {
  AGREEMENT_KINDS, AGREEMENT_STATES, KIND_LABEL as AGREEMENT_KIND_LABEL,
  serializeKits, type IncludedKit,
} from "@/lib/agreements";
import {
  closeLine, moverOf, nextWoNumber, severityOf, woAcceptsWork, woMove, woOpen, WO_LABEL,
  type Mover,
} from "@/lib/workOrders";
import { addDays, advance as advancePm, cadenceLabel, isIsoDay, parseCadence } from "@/lib/pm";
import {
  applyProcedures, applySystemProcedures, backfillProcedure, createPmTask, generateDuePmTasks,
  stampChecklist,
} from "@/lib/pmGenerate";
import { parseProcParts, partQty, partsForModel, procedureTaskBody, schedulePartsOf, serializeProcParts, type ProcPart } from "@/lib/procedures";
import { cleanItem, parseChecklist, serializeChecklist } from "@/lib/checklist";
import { signoffGate, snapshotOf } from "@/lib/signoff";
import { completionBlocked, evaluateResult, needsResult, resultIsRecorded } from "@/lib/testResult";
import { cleanBody, messageableFrom } from "@/lib/messages";
import { QUALIFICATIONS, DOC_TYPES, SIG_ROLES, canApprove, canDelete, canExecute, canRevokeApproval, isProtocol } from "@/lib/gxp";
import { consentModeFor, mayEnroll, remoteAbility } from "@/lib/remoteAccess";
import { cleanNickname, deviceLabel } from "@/lib/deviceName";
import {
  agentInstallerLink, applyDeviceConsent, connectUrl, deviceWithOrg, ensureOrgGroup, NOT_CONFIGURED,
  remoteConfigured,
} from "@/lib/remote";
import { matchesEntry, roleForEmail, emailInClientAllowlist, signOut } from "@/auth";
import { parseList } from "@/lib/allowMatch";
import { getStageDefs } from "@/lib/stageDefs";
import { notifyMessage, notifyModelProposed, notifyPartsRequested, notifyTaskAssigned, notifyGasEmpty, notifyDiscussion, notifySystemAssigned, notifyAccessRequest, notifyInvite, notifyHandoff, notifyQueueKick, notifyMention, notifyIssueRaised, notifyPmRequested } from "@/lib/notify";
import { normalizeSerial, MIN_SERIAL_LOOKUP } from "@/lib/serial";
import { isValidHex } from "@/lib/theme";
import { canSeeCosts } from "@/lib/redact";
import { fits, fmtBytes, overQuotaMessage, MB } from "@/lib/storage";
import { storeFiles, storeQuota, storeUsedBytes } from "@/lib/storeUsage";
import { audit } from "@/lib/audit";
import {
  canMoveFolder, cleanFolderName, depthOf, descendantIds, MAX_DEPTH, nameTaken,
} from "@/lib/folders";
import { cleanExpiry, cleanLabel } from "@/lib/dropShare";
import { mayReadAttachment } from "@/lib/fileAccess";
import { checkServes, cleanRole, moveFallout } from "@/lib/assetServes";
import {
  houseOf, myTenantOrgId, requireUser, requireEditor, requireStaff, requireOwner, requirePlatformOwner,
  requireRealOwner, tenantViewer, viewContext, VIEW_AS_COOKIE, type SessionUser,
} from "@/lib/authz";
import { getModules } from "@/lib/flags";
import { pushValueToSheet, fetchTrackerRows, appendInstrumentToSheet } from "@/lib/sheetSync";
import { GASES, GAS_STATES, ATTACH_KINDS, MODULE_KINDS, ASSET_STATES, autoFg, partOpen, stageChange } from "@/lib/stages";
import { gasesForSystemWithUnits, gasesForUnit, missingGases } from "@/lib/catalogGas";
import { shopToday, shopTodayMDY } from "@/lib/shopday";
import { composeEodEmail } from "@/lib/eodEmail";
import { getBrand } from "@/lib/brand";
import { parseSpecs, serializeSpecs } from "@/lib/partSpecs";
import { parseMoney, centsToInput, formatCents } from "@/lib/money";
import { bestPrice } from "@/lib/priceBook";
import { NOTIFY_KINDS, isNotifyKind } from "@/lib/inbox";
import { KIND_LABEL, STOCK_KINDS, canIssue, stockAccess } from "@/lib/stock";
import { PO_LABEL, nextPoNumber, poEditable, poReceivable, poTotals, statusAfterReceipt } from "@/lib/po";
import { canKick } from "@/lib/queue";
import { assetDupeKey, duplicateIds, importPlanner } from "@/lib/assetDupe";
import { houseEmails, houseMemberRows } from "@/lib/house";
import { pmHandoff } from "@/lib/pmQueue";
import { clearPasswordFor, setPasswordFor } from "@/lib/passwordAuth";
import { normalizePhone } from "@/lib/sms";
import { isStaffRole, mayAdminOrg, mayCreateOrgs } from "@/lib/tenants";
import { connectionView, removeConnection, withGraph } from "@/lib/cloudStore";
import { copyable, copyPlan, copySummary } from "@/lib/taskCopy";
import { alreadyHas, procedureCopy, refilePlan, refileSummary } from "@/lib/procedureMove";
import { createUploadSession, graphSetupProblem, listFolder, listPlaces, searchFiles } from "@/lib/msgraph";
import { vaultConfigured, VAULT_UNCONFIGURED } from "@/lib/secretBox";
import { PLACES_DRIVE, type CloudItem } from "@/lib/cloudItems";
import { parseFrame, serializeFrame } from "@/lib/photoFrame";
import { isPhotoFile, photoRemovalNote, sharedCover } from "@/lib/photos";
import { coverOf, photoRecord, photoTwin, type PhotoRecord } from "@/lib/photoPair";
import { pmRequestDue, pmRequestTitle, pmWindow, scheduleLine } from "@/lib/pmRequest";
import { memberGuard, ownerEmails, rootOwner, validHouseEmail } from "@/lib/houseRole";
import { parseHours, formatHours } from "@/lib/hours";
import { matchItems, scopeMatches, summarizeItem, CHECKOUT_KINDS, RESULT_TYPES } from "@/lib/checkout";
import { systemLabel } from "@/lib/systemLabel";
import { clientAfterHandoff, ownerFields } from "@/lib/owner";
import { isoDay, partDates } from "@/lib/partGroups";
import { assignableNames, visibleDirectory } from "@/lib/directory";
import { composeSystemDossier } from "@/lib/dossier";
import { cleanMakerName } from "@/lib/makers";
import { cleanProvenance, isPublishable, PROVENANCE_LABEL } from "@/lib/provenance";
import { partsFlag, visitFlag } from "@/lib/entitlementFlags";
import { parseModelSpecs, serializeModelSpecs } from "@/lib/modelSpecs";
import { MAX_SUMMARY, modelSlug, publishBlockers, uniqueSlug } from "@/lib/publicCatalog";
import { tenantCatalogIds } from "@/lib/makersData";
import {
  assertSystemEditable, assertSystemVisible, assertWorkEditable, assetAccess, canEditSystem, forTenant, isHouse, readTenant, tenantOfOrg, tenantOfSystem, viewTenant, visibleOrgs, visibleSystemIds,
} from "@/lib/tenancy";
import { canSeePost, resolveRoom, type Audience, type Viewer } from "@/lib/discussionScope";
import { sendEmail } from "@/lib/email";

/** A system is named by its assets; the stored description is the fallback. */
async function systemLabelFor(inst: { id: number; model: string }) {
  const rows = await db.select().from(assets).where(eq(assets.instrumentId, inst.id));
  return systemLabel(inst, rows);
}

const rev = (id?: number | null) => {
  revalidatePath("/");
  if (id) revalidatePath(`/instruments/${id}`);
};

/**
 * Work (a task, part, file, gas) belongs to a system, to a standalone asset, or
 * to both. One target type covers all three so the same panels serve a system
 * page and an asset page.
 */
export type WorkTarget = {
  instrumentId: number | null;
  assetId: number | null;
  /**
   * The job this row is part of, when it is filed from a work order's own page.
   * Optional and normally absent - most work is just the shop's list. Validated
   * in resolveTarget against the record it claims to belong to, so a hand-edited
   * id cannot file today's hours onto another client's job.
   */
  workOrderId?: number | null;
};

const revWork = (t: { instrumentId: number | null; assetId?: number | null }) => {
  rev(t.instrumentId);
  if (t.assetId) {
    revalidatePath("/assets");
    revalidatePath(`/assets/${t.assetId}`);
  }
};

/**
 * Resolve a caller-supplied target: the system must exist, the asset must
 * exist, and if both are given the asset must actually be on that system.
 */
/**
 * "had been closed 21 days" - the core of the late-filing note. Each audit
 * line places the order's number itself, because one already names it in its
 * sentence and the other does not, and "onto SVC-118 (SVC-118 had been...)"
 * is a stutter no one should have to read.
 */
function lateNote(wo: { state: string; closedAt: Date | null } | null): string {
  if (!wo) return "";
  const days = wo.closedAt ? Math.max(1, Math.round((Date.now() - wo.closedAt.getTime()) / 86_400_000)) : 0;
  const label = WO_LABEL[wo.state]?.toLowerCase() ?? "settled";
  return days ? `had been ${label} ${days} day${days === 1 ? "" : "s"}` : `was already ${label}`;
}

async function resolveTarget(
  t: WorkTarget,
  opts: {
    /**
     * Allow the target work order to be SETTLED, for house staff only. The
     * one legitimate late write: the signed report that comes back three
     * weeks after the job was filed. Attachments pass this; hours, parts and
     * tasks never do - those rewrite what a closed record says happened,
     * while a file arriving late is archival.
     */
    lateFiles?: boolean;
  } = {},
): Promise<
  { error: string } | {
    instrumentId: number | null; assetId: number | null; externalId: string;
    asset: typeof assets.$inferSelect | null;
    /** The job this row joins, already checked to be on this record and open. */
    workOrderId: number | null;
    /** Set when lateFiles let a settled order through - for the audit line. */
    settledWo: { number: string; state: string; closedAt: Date | null } | null;
    /**
     * Whose workspace the work belongs to - the RECORD's, not the writer's. An
     * engineer from another operator, invited onto a system, files work that
     * belongs to the company whose system it is. Getting this backwards would
     * scatter one job's records across two workspaces, each seeing half.
     */
    tenantOrgId: number | null;
  }
> {
  // Every created task/part/gas/file/note comes through here, so this is where
  // "may this caller write to this system or asset?" is answered once.
  const u = await requireEditor();
  let externalId = "";
  let tenantOrgId: number | null = myTenantOrgId(u);
  if (t.instrumentId !== null) {
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, t.instrumentId));
    if (!inst) return { error: "Not found" };
    tenantOrgId = inst.tenantOrgId;
    if (!(await canEditSystem(u, t.instrumentId))) {
      return { error: (await canSeeSystemSafe(u, t.instrumentId)) ? "Read-only access to this system" : "Not found" };
    }
    externalId = inst.externalId;
  }
  let asset: typeof assets.$inferSelect | null = null;
  if (t.assetId) {
    const [a] = await db.select().from(assets).where(eq(assets.id, t.assetId));
    if (!a) return { error: "Not found" };
    // On a system page the tag has to be an asset that's actually installed.
    if (t.instrumentId !== null && a.instrumentId !== t.instrumentId) return { error: "That asset is not on this system" };
    if (t.instrumentId === null) {
      const acc = await assetAccess(u, t.assetId);
      if (!acc.see) return { error: "Not found" };
      if (!acc.edit) return { error: "Read-only access to this asset" };
    }
    asset = a;
    if (t.instrumentId === null) tenantOrgId = a.tenantOrgId;
  }
  if (t.instrumentId === null && !asset) return { error: "Not found" };

  // A work order tag is only valid if the order is on THIS record and still
  // taking work. Both halves matter: the first stops an id from another client's
  // job being posted from a hand-edited form, the second stops today's hours
  // landing on a job that closed in March.
  let workOrderId: number | null = null;
  let settledWo: { number: string; state: string; closedAt: Date | null } | null = null;
  if (t.workOrderId) {
    const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, t.workOrderId));
    if (!wo) return { error: "Not found" };
    const onThis = t.instrumentId !== null
      ? wo.instrumentId === t.instrumentId
      : wo.assetId === (asset?.id ?? null);
    if (!onThis) return { error: "That work order is not on this record" };
    if (!woAcceptsWork(wo.state)) {
      // House staff of the order's own workspace may still FILE onto it, when
      // the caller said that is what this write is. Everybody else, and every
      // other kind of work row, gets the refusal that keeps closed closed.
      const houseLate = opts.lateFiles === true
        && isStaffRole(u.role) && (readTenant(u) === null || wo.tenantOrgId === readTenant(u));
      if (!houseLate) return { error: `${wo.number || "That work order"} is ${WO_LABEL[wo.state]?.toLowerCase() ?? "finished"}.` };
      settledWo = { number: wo.number, state: wo.state, closedAt: wo.closedAt };
    }
    workOrderId = wo.id;
  }
  return { instrumentId: t.instrumentId, assetId: asset?.id ?? null, externalId, asset, tenantOrgId, workOrderId, settledWo };
}

/**
 * 21 CFR Part 11 discipline: destroying a record requires a stated reason,
 * captured in the append-only audit trail alongside who and when. Server-side
 * so no client can skip it.
 */
function requireReason(reason: string | undefined): string | { error: string } {
  const r = (reason ?? "").trim();
  if (r.length < 3) return { error: "A reason is required for this action (21 CFR 11)" };
  return r;
}

/** Distinguish "you can't touch it" from "it isn't yours to know about". */
async function canSeeSystemSafe(u: Awaited<ReturnType<typeof requireUser>>, instrumentId: number) {
  try { await assertSystemVisible(u, instrumentId); return true; } catch { return false; }
}

/** Where work is recorded, for audit lines: "T-003" or "pump LC-40D". */
const targetLabel = (externalId: string, asset: { kind: string; model: string; serial: string } | null) =>
  externalId || (asset ? assetLabel(asset) : "");

// ---------------- Instruments ----------------

export async function toggleStage(instrumentId: number, stage: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  await assertSystemEditable(u, instrumentId);
  // Scoped to the system's own workspace, not to whoever is looking: another
  // operator working a shared bench must not be offered their own stage names.
  const defs = await getStageDefs(inst.tenantOrgId);
  // The rule, and the asymmetry in it, are in lib/stages. Returned rather than
  // thrown: a throw here reaches the browser as a digest crash page, which is
  // what a refusal to remove "Maintenance due" looked like.
  const move = stageChange(inst.stages, stage, defs.map((d) => d.name));
  if (!move.ok) return { error: move.error };
  const has = inst.stages.includes(stage);
  const next = move.next;
  await db.update(instruments).set({ stages: next, updatedAt: new Date() }).where(eq(instruments.id, instrumentId));
  await db.insert(stageEvents).values({ instrumentId, stage, kind: has ? "removed" : "added" });
  await audit({
    actor: u.email, instrumentId, entityType: "instrument", entityId: inst.externalId,
    action: `${has ? "removed" : "added"} stage: ${stage}`, field: "stages",
    oldValue: inst.stages.join(", "), newValue: next.join(", "),
  });
  rev(instrumentId);
  return {};
}

export async function updateInstrumentNotes(instrumentId: number, notes: string) {
  const u = await requireEditor();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) throw new Error("Not found");
  await assertSystemEditable(u, instrumentId);
  await db.update(instruments).set({ notes, updatedAt: new Date() }).where(eq(instruments.id, instrumentId));
  await audit({
    actor: u.email, instrumentId, entityType: "instrument", entityId: inst.externalId,
    action: "updated notes", field: "notes", oldValue: inst.notes, newValue: notes,
  });
  rev(instrumentId);
}

export async function updateInstrument(
  instrumentId: number,
  data: { externalId?: string; client: string; category?: string; priority: number; location?: string; name?: string; gxp?: boolean },
): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  await assertSystemEditable(u, instrumentId);
  const client = data.client.trim();
  const externalId = (data.externalId ?? inst.externalId).trim();
  if (!externalId) return { error: "System ID required" };
  if (externalId.length > 40) return { error: "System ID must be 40 characters or fewer" };
  if (externalId !== inst.externalId) {
    // The column is unique; check first so the user gets a real message.
    const clash = await db.select().from(instruments).where(eq(instruments.externalId, externalId));
    if (clash.length) return { error: `${externalId} is already used by another system` };
  }
  const priority = data.priority || inst.priority;
  const location = (data.location ?? inst.location).trim();
  const category = (data.category ?? inst.category).trim();
  // A chosen name wins over the composed one; clearing it hands naming back to
  // the assets rather than freezing whatever they last spelled out.
  const name = (data.name ?? inst.name).trim().slice(0, 120);
  const changed: [string, string, string][] = [];
  if (name !== inst.name) changed.push(["name", inst.name || "(from assets)", name || "(from assets)"]);
  if (externalId !== inst.externalId) changed.push(["externalId", inst.externalId, externalId]);
  if (location !== inst.location) changed.push(["location", inst.location, location]);
  if (client !== inst.client) changed.push(["client", inst.client, client]);
  if (category !== inst.category) changed.push(["category", inst.category, category]);
  if (priority !== inst.priority) changed.push(["priority", String(inst.priority), String(priority)]);
  // Turning regulation ON or OFF is a statement about the record, so it audits
  // like one - "marked regulated (GxP)" is a line an auditor will look for.
  const gxp = data.gxp ?? inst.gxp;
  if (gxp !== inst.gxp) changed.push(["gxp", inst.gxp ? "regulated" : "not regulated", gxp ? "regulated" : "not regulated"]);
  if (!changed.length) return {};
  await db.update(instruments).set({ externalId, client, category, priority, location, name, gxp, updatedAt: new Date() }).where(eq(instruments.id, instrumentId));
  for (const [field, oldValue, newValue] of changed) {
    await audit({
      // Log under the new ID so the entry is findable, but the old value is in the row.
      actor: u.email, instrumentId, entityType: "instrument", entityId: externalId,
      action: field === "externalId" ? `renamed ${oldValue} to ${newValue}` : `updated ${field}`,
      field, oldValue, newValue,
    });
  }
  // The category decides which system-level procedures reach this system, so
  // changing it is the same event as creating it as far as the catalog is
  // concerned: a GC re-typed as a GC-MS should pick up the GC-MS upkeep without
  // anybody remembering to go and ask for it. Additive only - schedules the old
  // category brought stay, because they may have been done since, and taking
  // work off a system is a decision rather than a side effect.
  if (category !== inst.category) {
    await applySystemProcedures(instrumentId, shopToday(), u.email);
    // A system re-typed as an LC-MS needs what an LC-MS needs.
    await applyCatalogGases({ instrumentId, assetId: null }, inst.tenantOrgId);
  }
  rev(instrumentId);
  return {};
}

/**
 * Freeform note straight into the activity log - for things that aren't a task
 * or a part order. On an asset it also lands in the asset's service history.
 */
export async function addInstrumentNote(target: WorkTarget, text: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  const t = text.trim();
  if (!t) return { error: "Note text required" };
  const t0 = await resolveTarget(target);
  if ("error" in t0) return t0;
  await audit({
    actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId,
    entityType: t0.instrumentId !== null ? "instrument" : "asset",
    entityId: t0.instrumentId !== null ? t0.externalId : String(t0.assetId),
    action: "posted note", field: "note", newValue: t,
  });
  // Asset notes belong in its history feed, not just the audit trail.
  if (t0.instrumentId === null && t0.assetId) {
    await logAssetEvent(t0.assetId, "note", null, t, u.name);
  }
  revWork({ instrumentId: t0.instrumentId, assetId: t0.assetId });
  return {};
}

/** Retire a system from the active fleet (or bring it back). The editor-safe alternative to deleting. */
export async function setInstrumentArchived(instrumentId: number, archived: boolean) {
  const u = await requireEditor();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst || inst.archived === archived) return;
  await assertSystemEditable(u, instrumentId);
  await db.update(instruments)
    .set({ archived, archivedAt: archived ? new Date() : null, archivedBy: archived ? u.name : "", updatedAt: new Date() })
    .where(eq(instruments.id, instrumentId));
  await audit({
    actor: u.email, instrumentId, entityType: "instrument", entityId: inst.externalId,
    action: archived ? `archived ${inst.externalId}` : `restored ${inst.externalId} to the active fleet`,
    field: "archived", oldValue: String(inst.archived), newValue: String(archived),
  });
  revalidatePath("/archive");
  rev(instrumentId);
}

/**
 * Add one of our systems to the client's sheet as a new row, so a system born
 * in the portal shows up on their tracker. Closes any open "missing from
 * sheet" parity diff for it.
 */
export async function pushInstrumentToSheet(instrumentId: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  // The tracker belongs to one organization: pushing a system they can't see
  // would hand them a row for someone else's work.
  const [cfg] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  if (cfg?.sheetOrgId) {
    const [onSheetOrg] = await db.select().from(systemShares)
      .where(and(eq(systemShares.instrumentId, instrumentId), eq(systemShares.orgId, cfg.sheetOrgId)));
    if (!onSheetOrg) return { error: "Share this system with the tracker's organization first (Settings shows which one that is)" };
  }
  try {
    await appendInstrumentToSheet({
      externalId: inst.externalId, client: inst.client, model: await systemLabelFor(inst),
      priority: inst.priority, stages: inst.stages, notes: inst.notes,
    });
  } catch (e) {
    return { error: (e as Error).message || "Sheet update failed" };
  }
  const open = await db.select().from(sheetDiffs)
    .where(and(eq(sheetDiffs.resolved, false), eq(sheetDiffs.externalId, inst.externalId), eq(sheetDiffs.field, "Row")));
  for (const d of open) {
    await db.update(sheetDiffs)
      .set({ resolved: true, resolvedBy: u.email, resolution: "kept_ours_pushed" })
      .where(eq(sheetDiffs.id, d.id));
  }
  await audit({
    actor: u.email, instrumentId, entityType: "instrument", entityId: inst.externalId,
    action: `added ${inst.externalId} to the client's sheet`,
  });
  revalidatePath("/parity");
  rev(instrumentId);
  return {};
}

/** Either side may assign a lead - LabZen hands Sierra a system or claims one themselves. */
export async function setInstrumentLead(instrumentId: number, lead: string) {
  const u = await requireEditor();
  const name = lead.trim();
  // Somebody with a login this person can see, not free text: a lead nobody can
  // be notified at is a system that looks assigned and is not.
  if (name && !(await assignableNames(u)).has(name)) throw new Error("Unknown person");
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst || inst.lead === name) return;
  await assertSystemEditable(u, instrumentId);
  await db.update(instruments).set({ lead: name, updatedAt: new Date() }).where(eq(instruments.id, instrumentId));
  await audit({
    actor: u.email, instrumentId, entityType: "instrument", entityId: inst.externalId,
    action: name ? `assigned ${inst.externalId} to ${name}` : `cleared lead on ${inst.externalId}`,
    field: "lead", oldValue: inst.lead, newValue: name,
  });
  if (name) {
    await notifySystemAssigned({
      actorEmail: u.email, actorName: u.name, lead: name,
      instrumentId, externalId: inst.externalId, label: await systemLabelFor(inst),
    });
  }
  rev(instrumentId);
}

export async function createInstrument(
  data: { externalId: string; client: string; category?: string; priority: number; lead?: string },
) {
  // Editors, not just staff: LabZen adds their internal systems themselves.
  const u = await requireEditor();
  let lead = (data.lead ?? "").trim();
  if (lead && !(await assignableNames(u)).has(lead)) lead = "";
  const [row] = await db.insert(instruments).values({
    tenantOrgId: myTenantOrgId(u),
    // model stays blank: the system is named by the assets added to it
    // (lib/systemLabel). The column lives on only as the pre-asset fallback
    // for older records and sheet imports.
    externalId: data.externalId.trim(), client: data.client.trim(),
    category: (data.category ?? "").trim(), model: "",
    priority: data.priority || 99, lead, stages: ["Intake"],
  }).returning();
  await db.insert(stageEvents).values({ instrumentId: row.id, stage: "Intake", kind: "added" });
  await audit({
    actor: u.email, instrumentId: row.id, entityType: "instrument", entityId: row.externalId,
    action: `created instrument ${row.externalId} (${row.client || "no client"})${lead ? ` - lead ${lead}` : ""}`,
  });
  // A system created by an organization belongs to that organization, or they
  // would immediately lose the thing they just made.
  if (u.orgId !== null) {
    await db.insert(systemShares).values({
      instrumentId: row.id, orgId: u.orgId, access: "edit", addedBy: u.email,
    }).onConflictDoNothing();
    await audit({
      actor: u.email, instrumentId: row.id, entityType: "share", entityId: row.externalId,
      action: `shared ${row.externalId} with ${u.orgName} (edit) - created by them`,
    });
    // A client creating its own system owns it outright. A provider doesn't:
    // their creation stays house-stewarded ("unclaimed") until the instrument's
    // real owner joins the platform and staff hand it over.
    const owner = await creatorOwns(u.orgId);
    if (owner !== null) {
      await db.update(instruments).set({ ownerOrgId: owner }).where(eq(instruments.id, row.id));
    }
  } else {
    // Created by the operator: share it with the service organization running
    // this instance, so its engineers - who sign in as that org, not as
    // platform staff - can work the system.
    const [s] = await db.select({ operatorOrgId: appSettings.operatorOrgId }).from(appSettings).where(eq(appSettings.id, 1));
    if (s?.operatorOrgId != null) {
      await db.insert(systemShares)
        .values({ instrumentId: row.id, orgId: s.operatorOrgId, access: "edit", addedBy: u.email })
        .onConflictDoNothing();
    }
  }
  if (lead) {
    await notifySystemAssigned({
      actorEmail: u.email, actorName: u.name, lead,
      instrumentId: row.id, externalId: row.externalId, label: "",
    });
  }
  await generateCheckout(row.id, { id: null, kind: "system", model: "", serial: "" }, u.email, row.tenantOrgId);
  // Whatever this kind of system needs on the bench, per the catalog.
  await applyCatalogGases({ instrumentId: row.id, assetId: null }, row.tenantOrgId);
  // Recurring upkeep that belongs to the instrument rather than to a unit in it.
  await applySystemProcedures(row.id, shopToday(), u.email);
  rev(row.id);
  return row.id;
}

export async function deleteInstrument(instrumentId: number, reason: string): Promise<{ error?: string }> {
  const u = await requireOwner(); // owner is always the house, so no share check needed
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return {};
  const files = await db.select({ url: attachments.url }).from(attachments).where(eq(attachments.instrumentId, instrumentId));
  await db.delete(instruments).where(eq(instruments.id, instrumentId)); // tasks, parts, gases, attachments cascade
  await deleteBlobs(files.map((f) => f.url)); // cascade covers rows; blobs need explicit removal
  await audit({
    actor: u.email, instrumentId, entityType: "instrument", entityId: inst.externalId,
    action: `deleted instrument ${inst.externalId} (${inst.client}) - reason: ${why}`,
    field: "reason", newValue: why,
  });
  rev(instrumentId);
  redirect("/");
}

/**
 * Does this organization own the things it creates? Clients do - their stock
 * and their systems stay theirs. Service providers don't: a provider typing in
 * a client's pump is recording it, not acquiring it, and stamping ownership
 * would survive revocation and hand them back what the unshare took away.
 *
 * A provider CAN own equipment - a service company's own warehouse stock is
 * exactly that - but only where staff assigned it deliberately
 * (setSystemOwner / setAssetOwnerOrg). Never as a side effect of data entry.
 */
async function creatorOwns(orgId: number | null): Promise<number | null> {
  if (orgId === null) return null;
  const [org] = await db.select({ kind: orgs.kind }).from(orgs).where(eq(orgs.id, orgId));
  return org?.kind === "client" ? orgId : null;
}

// ---------------- Assets ----------------
// First-class units systems are built from. Work is recorded on the system
// and tagged with the asset; lifecycle rows here give the dossier its spine.

export type AssetInput = { kind: string; model: string; serial: string; manufacturer: string; owner: string; asFound?: string; location: string; note: string };

const cleanAsset = (d: AssetInput) => ({
  // Open vocabulary: MODULE_KINDS is just the starter list, so the shop can
  // add its own types ("N2 generator") and give them checkout categories.
  kind: d.kind.trim().slice(0, 40) || "Other",
  model: d.model.trim(),
  serial: d.serial.trim(),
  manufacturer: d.manufacturer.trim(),
  owner: d.owner.trim(),
  asFound: (d.asFound ?? "").trim(),
  location: d.location.trim(),
  note: d.note.trim(),
});

const assetLabel = (a: { kind: string; model: string; serial: string }) =>
  `${a.kind.toLowerCase()} ${a.model || "(no model)"}${a.serial ? ` SN ${a.serial}` : ""}`;

async function logAssetEvent(assetId: number, kind: string, instrumentId: number | null, detail: string, actor: string) {
  await db.insert(assetEvents).values({ assetId, kind, instrumentId, detail, actor });
}

/**
 * Auto-create checkout tasks + tests when an asset lands on a system (or, with
 * an assetType of "system", when a system is created), and on demand for a
 * standalone asset being checked out for sale. Dedupe follows the asset: any
 * open task with the same name tagged to it - here or on a system it later
 * joins - blocks a duplicate, so a bench checkout doesn't repeat on install.
 * Returns how many items it created.
 */
async function generateCheckout(
  instrumentId: number | null,
  target: { id: number | null; kind: string; model: string; serial: string },
  actorEmail: string,
  // Whose workspace this intake belongs to: its procedures fire, its tasks are
  // created. Another operator's checklist must not run on our bench.
  tenantOrgId: number | null,
): Promise<number> {
  const assetType = target.id === null ? "system" : target.kind;
  const items = await db.select().from(procedures)
    .where(and(eq(procedures.assetType, assetType), eq(procedures.runsAtIntake, true),
      forTenant(procedures.tenantOrgId, tenantOrgId)));
  // Category scope: the TOC sampler's intake work must not fire on the LC-MS
  // sampler. A bench checkout (no system) gets only the unscoped procedures.
  const category = instrumentId !== null
    ? (await db.select({ category: instruments.category }).from(instruments)
        .where(eq(instruments.id, instrumentId)))[0]?.category ?? ""
    : "";
  const inCategory = items.filter((i) =>
    i.categoryScope.length === 0 || (category !== "" && scopeMatches(i.categoryScope, category)));
  const picked = matchItems(inCategory, assetType, target.model);
  if (!picked.length) return 0;
  const existing = target.id !== null
    ? await db.select().from(tasks).where(eq(tasks.assetId, target.id))
    : instrumentId !== null
      ? await db.select().from(tasks).where(and(eq(tasks.instrumentId, instrumentId), isNull(tasks.assetId)))
      : [];
  const openTitles = new Set(existing.filter((t) => t.state !== "Done").map((t) => t.title.toLowerCase()));
  const fresh = picked.filter((i) => !openTitles.has(i.name.toLowerCase()));
  if (!fresh.length) return 0;
  for (const i of fresh) {
    const [t] = await db.insert(tasks).values({
      tenantOrgId,
      // Parts narrowed to this unit's model - a per-model mapping on the
      // procedure must not put the LC-20's kit on an LC-30's task.
      instrumentId, title: i.name, body: procedureTaskBody(i, partsForModel(parseProcParts(i.parts), target.model)), origin: "checkout",
      assetId: target.id, sortOrder: i.position, procedureId: i.id ?? null,
    }).returning();
    await stampChecklist(t.id, i.checklist);
  }
  const label = target.id !== null ? assetLabel(target as { kind: string; model: string; serial: string }) : "the system";
  await audit({
    actor: actorEmail, instrumentId, assetId: target.id, entityType: "task", entityId: target.id ?? instrumentId ?? "",
    action: `generated ${fresh.length} checkout item${fresh.length === 1 ? "" : "s"} for ${label}`,
  });
  return fresh.length;
}

/**
 * Is this model in the catalog for this module type? The pickers offer the
 * catalog but never require it (the unit in front of somebody always gets
 * recorded); this is how the ones that arrived freehand get noticed. Matched
 * by name across the type, case-insensitive, tenant-scoped.
 */
async function modelInCatalog(kind: string, model: string, tenantOrgId: number | null): Promise<boolean> {
  const m = model.trim().toLowerCase();
  if (!m) return true; // nothing typed = nothing to review
  const rows = await db.select({ name: vocabTerms.name, assetType: vocabTerms.assetType }).from(vocabTerms)
    .where(and(eq(vocabTerms.kind, "model"), forTenant(vocabTerms.tenantOrgId, tenantOrgId)));
  return rows.some((r) => r.name.trim().toLowerCase() === m
    && r.assetType.trim().toLowerCase() === kind.trim().toLowerCase());
}

export async function createAsset(instrumentId: number | null, data: AssetInput): Promise<{ error?: string; id?: number }> {
  const u = await requireEditor();
  const a = cleanAsset(data);
  if (!a.model && !a.serial) return { error: "Give the asset a model or a serial number" };
  let externalId = "";
  // A unit installed in a system joins that system's workspace, whoever is
  // fitting it; a shelf spare joins the workspace of whoever put it there.
  let instTenantOrgId: number | null = null;
  if (instrumentId !== null) {
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
    if (!inst) return { error: "Not found" };
    if (!(await canEditSystem(u, instrumentId))) {
      return { error: (await canSeeSystemSafe(u, instrumentId)) ? "Read-only access to this system" : "Not found" };
    }
    externalId = inst.externalId;
    instTenantOrgId = inst.tenantOrgId;
  }
  const siblings = instrumentId !== null
    ? await db.select().from(assets).where(eq(assets.instrumentId, instrumentId)) : [];
  const sortOrder = Math.max(0, ...siblings.map((x) => x.sortOrder)) + 1;
  const [row] = await db.insert(assets).values({
    ...a, instrumentId, sortOrder, status: instrumentId !== null ? "In service" : "Spare",
    tenantOrgId: instTenantOrgId ?? myTenantOrgId(u),
    // Stock added by a client organization stays theirs, so they keep seeing it
    // while it sits on no system. A provider's entries are records, not
    // property - see creatorOwns.
    ownerOrgId: await creatorOwns(u.orgId),
  }).returning();
  if (instrumentId !== null) {
    await logAssetEvent(row.id, "installed", instrumentId, `into ${externalId}`, u.name);
    await audit({
      actor: u.email, instrumentId, entityType: "asset", entityId: row.id,
      action: `added ${assetLabel(row)}`,
    });
    await generateCheckout(instrumentId, row, u.email, row.tenantOrgId);
    rev(instrumentId);
  } else {
    // Stock: bought, on the shelf, not part of a system yet.
    await logAssetEvent(row.id, "note", null, `added to stock${a.location ? ` at ${a.location}` : ""}`, u.name);
    await audit({
      actor: u.email, entityType: "asset", entityId: row.id,
      action: `added ${assetLabel(row)} to stock${a.owner ? ` for ${a.owner}` : ""}${a.location ? ` (${a.location})` : ""}`,
    });
  }
  // The model's recurring procedures arrive with the unit - CSV imports come
  // through here too, so a migrated fleet lands already scheduled.
  await applyProcedures(row.id, shopToday(), u.email);
  // And the gases its model calls for, onto the system it joined or onto the
  // unit itself while it is still a spare.
  await applyCatalogGases(
    instrumentId !== null ? { instrumentId, assetId: null } : { instrumentId: null, assetId: row.id },
    row.tenantOrgId,
  );
  // A model the catalog doesn't know: recorded anyway (never blocked), and
  // flagged to the house so the review queue on the catalog page picks it up.
  if (row.model && !(await modelInCatalog(row.kind, row.model, row.tenantOrgId))) {
    await notifyModelProposed({
      actorEmail: u.email, actorName: u.name || u.email,
      kind: row.kind, model: row.model, where: externalId,
    });
  }
  revalidatePath("/assets");
  revalidatePath(`/assets/${row.id}`);
  return { id: row.id };
}

/**
 * Several assets in one go - the spreadsheet path. Each row goes through
 * createAsset, so imported-by-grid units get exactly what hand-entered ones do:
 * ownership, intake procedures, recurring schedules, audit. Rows that fail are
 * reported by index rather than aborting the batch, because losing nine good
 * rows to one typo is the thing that makes people go back to Excel.
 */
export async function createAssets(
  instrumentId: number | null,
  rows: AssetInput[],
): Promise<{ error?: string; created?: number; failures?: { row: number; error: string }[] }> {
  await requireEditor();
  const usable = rows.filter((r) => r.kind.trim() && (r.model.trim() || r.serial.trim()));
  if (!usable.length) return { error: "Nothing to save - each row needs a type and either a model or a serial" };
  if (usable.length > 200) return { error: "Save 200 rows at a time" };
  // A serial is one physical unit, so a serial already on file is a mistake -
  // reported per row rather than silently skipped, because this is deliberate
  // entry and the person needs to know their paste overlapped. Serial-LESS rows
  // are left alone: three identical seal-less pumps are three real pumps.
  const taken = new Map((await db.select({ serial: assets.serial, kind: assets.kind, model: assets.model })
    .from(assets)).filter((a) => a.serial.trim())
    .map((a) => [normalizeSerial(a.serial), `${a.kind}${a.model ? ` ${a.model}` : ""}`]));
  const failures: { row: number; error: string }[] = [];
  let created = 0;
  for (let i = 0; i < usable.length; i++) {
    const sn = normalizeSerial(usable[i].serial ?? "");
    if (sn && taken.has(sn)) {
      failures.push({ row: i + 1, error: `Serial ${usable[i].serial.trim()} is already on file as ${taken.get(sn)}` });
      continue;
    }
    const res = await createAsset(instrumentId, usable[i]);
    if (res.error) { failures.push({ row: i + 1, error: res.error }); continue; }
    if (sn) taken.set(sn, `${usable[i].kind}${usable[i].model ? ` ${usable[i].model}` : ""}`);
    created++;
  }
  return { created, failures };
}

export async function updateAsset(assetId: number, data: AssetInput): Promise<{ error?: string }> {
  const u = await requireEditor();
  const a = cleanAsset(data);
  if (!a.model && !a.serial) return { error: "Give the asset a model or a serial number" };
  const [before] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!before) return { error: "Not found" };
  const acc = await assetAccess(u, assetId);
  if (!acc.see) return { error: "Not found" };
  if (!acc.edit) return { error: "Read-only access to this asset" };
  // Ownership is not edited here. It is one control, in the ownership section,
  // because it decides who can SEE this unit - and when it was also a free-text
  // box on this form the two could disagree, which is how a unit came to say
  // "LabZen" on the row while LabZen could not open it. See lib/owner.
  const { owner: _ignored, ...fields } = a;
  await db.update(assets).set(fields).where(eq(assets.id, assetId));
  await audit({
    actor: u.email, instrumentId: before.instrumentId ?? undefined, entityType: "asset", entityId: assetId,
    action: `edited ${assetLabel({ ...before, ...fields })}`,
  });
  if (a.model && a.model.toLowerCase() !== before.model.trim().toLowerCase()
      && !(await modelInCatalog(a.kind, a.model, before.tenantOrgId))) {
    await notifyModelProposed({
      actorEmail: u.email, actorName: u.name || u.email,
      kind: a.kind, model: a.model, where: a.serial ? `SN ${a.serial}` : "",
    });
  }
  if (before.instrumentId !== null) rev(before.instrumentId);
  revalidatePath("/assets");
  revalidatePath(`/assets/${assetId}`);
  return {};
}

/**
 * Say which module this support unit serves - the roughing pump's mass spec,
 * the chiller's detector.
 *
 * The unit stays exactly where it is: on the system, in the asset list, with
 * its own page and history. This adds one fact to it. The rules that keep it a
 * pointer rather than a hierarchy live in lib/assetServes and are checked
 * against the system's OWN rows, so a stale id from a browser tab open since
 * yesterday cannot link two units that no longer sit together.
 */
export async function setAssetServes(
  assetId: number, servesAssetId: number | null, role = "",
): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [a] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!a) return { error: "Not found" };
  const acc = await assetAccess(u, assetId);
  if (!acc.see) return { error: "Not found" };
  if (!acc.edit) return { error: "Read-only access to this asset" };
  const siblings = a.instrumentId === null ? [a] : await db.select().from(assets)
    .where(eq(assets.instrumentId, a.instrumentId));
  const check = checkServes(a, servesAssetId, siblings);
  if (!check.ok) return { error: check.error };
  const servesRole = check.servesAssetId === null ? "" : cleanRole(role);
  if (a.servesAssetId === check.servesAssetId && a.servesRole === servesRole) return {};
  await db.update(assets)
    .set({ servesAssetId: check.servesAssetId, servesRole })
    .where(eq(assets.id, assetId));
  const target = check.servesAssetId === null ? null : siblings.find((s) => s.id === check.servesAssetId);
  const said = target
    ? `serves ${assetLabel(target)}${servesRole ? ` (${servesRole})` : ""}`
    : "no longer serves a particular module";
  await logAssetEvent(assetId, "note", a.instrumentId, said, u.name);
  await audit({
    actor: u.email, instrumentId: a.instrumentId ?? undefined, entityType: "asset", entityId: assetId,
    action: `${assetLabel(a)} ${said}`,
  });
  if (a.instrumentId !== null) rev(a.instrumentId);
  revalidatePath("/assets");
  revalidatePath(`/assets/${assetId}`);
  if (check.servesAssetId !== null) revalidatePath(`/assets/${check.servesAssetId}`);
  if (a.servesAssetId !== null) revalidatePath(`/assets/${a.servesAssetId}`);
  return {};
}

/**
 * Cut the serves links a unit is about to break by leaving its system, keeping
 * only the servers travelling with it. Shared by move, detach and decommission
 * because all three are the same event to a hose: the module is going.
 */
async function cutServeLinks(
  assetId: number, instrumentId: number | null, bringing: number[], keepOwn = false,
): Promise<number[]> {
  const around = instrumentId === null ? [] : await db.select().from(assets)
    .where(eq(assets.instrumentId, instrumentId));
  const { bring, orphan, clearOwn } = moveFallout(assetId, around, bringing);
  if (clearOwn && !keepOwn) {
    await db.update(assets).set({ servesAssetId: null, servesRole: "" }).where(eq(assets.id, assetId));
  }
  if (orphan.length) {
    await db.update(assets).set({ servesAssetId: null, servesRole: "" }).where(inArray(assets.id, orphan));
  }
  return bring;
}

export async function setAssetStatus(assetId: number, status: string) {
  const u = await requireEditor();
  if (!(ASSET_STATES as readonly string[]).includes(status)) throw new Error("Unknown asset status");
  const [a] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!a || a.status === status) return;
  if (!(await assetAccess(u, assetId)).edit) throw new Error("Not found");
  await db.update(assets).set({ status }).where(eq(assets.id, assetId));
  await logAssetEvent(assetId, "status", a.instrumentId, `${a.status} -> ${status}`, u.name);
  await audit({
    actor: u.email, instrumentId: a.instrumentId ?? undefined, entityType: "asset", entityId: assetId,
    action: `${assetLabel(a)}: ${a.status} -> ${status}`, field: "status", oldValue: a.status, newValue: status,
  });
  if (a.instrumentId !== null) rev(a.instrumentId);
  revalidatePath("/assets");
  revalidatePath(`/assets/${assetId}`);
}

/**
 * Put the gases the catalog says this equipment needs onto the record.
 *
 * "Not connected" rather than "Connected": the catalog knows the system NEEDS
 * nitrogen, it cannot know somebody has hooked it up. That status is the one
 * the dashboard already flags, so a new arrival shows the real to-do instead of
 * a green tick nobody earned. Never touches a gas already on the record - a
 * status somebody set by hand is worth more than a default.
 */
async function applyCatalogGases(
  target: { instrumentId: number | null; assetId: number | null },
  tenantOrgId: number | null,
): Promise<number> {
  const terms = await db.select({
    kind: vocabTerms.kind, assetType: vocabTerms.assetType, name: vocabTerms.name, gases: vocabTerms.gases,
  }).from(vocabTerms).where(forTenant(vocabTerms.tenantOrgId, tenantOrgId)).catch(() => []);
  if (!terms.some((t) => t.gases.length)) return 0;

  let required: string[] = [];
  if (target.instrumentId !== null) {
    const [inst] = await db.select({ category: instruments.category }).from(instruments)
      .where(eq(instruments.id, target.instrumentId));
    const units = await db.select({ kind: assets.kind, model: assets.model }).from(assets)
      .where(eq(assets.instrumentId, target.instrumentId));
    required = gasesForSystemWithUnits(terms, inst?.category ?? "", units);
  } else if (target.assetId !== null) {
    const [a] = await db.select({ kind: assets.kind, model: assets.model }).from(assets)
      .where(eq(assets.id, target.assetId));
    if (a) required = gasesForUnit(terms, a);
  }
  if (!required.length) return 0;

  const have = await db.select({ gas: instrumentGases.gas }).from(instrumentGases)
    .where(target.instrumentId !== null
      ? eq(instrumentGases.instrumentId, target.instrumentId)
      : eq(instrumentGases.assetId, target.assetId!));
  const missing = missingGases(required, have.map((h) => h.gas));
  for (const gas of missing) {
    await db.insert(instrumentGases).values({
      instrumentId: target.instrumentId, assetId: target.assetId,
      gas, status: "Not connected",
    }).onConflictDoNothing();
  }
  return missing.length;
}

/** Shared install step, so one asset and a whole batch behave identically. */
async function attachOne(assetId: number, instrumentId: number, externalId: string, u: SessionUser) {
  const [a] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!a) return { error: "Not found" };
  // You may only install a unit you can see, into a system you can edit.
  if (!(await assetAccess(u, assetId)).see) return { error: "Not found" };
  if (a.instrumentId !== null) return { error: `${assetLabel(a)} is already on a system - use Move instead` };
  if (a.status === "Decommissioned") return { error: `${assetLabel(a)} is decommissioned` };
  await db.update(assets).set({ instrumentId, status: "In service" }).where(eq(assets.id, assetId));
  await logAssetEvent(assetId, "installed", instrumentId, `into ${externalId}`, u.name);
  await audit({
    actor: u.email, instrumentId, entityType: "asset", entityId: assetId,
    action: `installed ${assetLabel(a)}${a.location ? ` (from ${a.location})` : ""}`,
  });
  await generateCheckout(instrumentId, a, u.email, a.tenantOrgId);
  // Recurring upkeep scoped to the system's type arrives when the unit joins
  // it - a spare created on the shelf had no system to scope by. Deduped by
  // procedure and title, so re-installs don't double the schedules.
  await applyProcedures(assetId, shopToday(), u.email);
  // A unit joining a system can bring a gas requirement the system did not have.
  await applyCatalogGases({ instrumentId, assetId: null }, a.tenantOrgId);
  revalidatePath(`/assets/${assetId}`);
  return {};
}

/**
 * Attach several unassigned assets in one go - building a system out of the
 * shelf is normally a list, not one part at a time. Attaches what it can and
 * reports the rest.
 */
/**
 * Give a lone unit a system of its own.
 *
 * Some clients own one instrument, not a rack of them - a UV-Vis on a bench is
 * the whole engagement. Those still need what only a system carries: a place on
 * the dashboard, stages, a queue, custody, a sign-off packet, a linked PC.
 *
 * The alternative was a flag on the asset saying "treat me as a system too",
 * which would have meant every list in the app - dashboard, queue, EOD, records,
 * metrics - reading from two tables and staying in agreement forever. A system
 * with exactly one asset costs one row and no new code paths, and the page
 * already names itself after that asset (lib/systemLabel), so it reads as the
 * instrument rather than as a container holding it.
 */
export async function trackAssetAsSystem(
  assetId: number, externalId: string,
): Promise<{ error?: string; instrumentId?: number }> {
  const u = await requireEditor();
  const [a] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!a) return { error: "Not found" };
  if (a.instrumentId !== null) return { error: "This unit is already on a system." };
  const tag = externalId.trim();
  if (!tag) return { error: "Give the system a tag first." };
  const [clash] = await db.select({ id: instruments.id }).from(instruments)
    .where(eq(instruments.externalId, tag));
  if (clash) return { error: `${tag} is taken by another system.` };

  const instrumentId = await createInstrument({
    externalId: tag,
    client: a.owner,
    // The unit's type is the system's type when the unit is all there is.
    category: a.kind,
    priority: 99,
  });
  const attached = await attachAssets([assetId], instrumentId);
  if (attached.error && !attached.attached) return { error: attached.error };

  // A one-unit system belongs to whoever owns the unit, and they get to see it.
  if (a.ownerOrgId !== null) {
    await db.update(instruments).set({ ownerOrgId: a.ownerOrgId }).where(eq(instruments.id, instrumentId));
    await db.insert(systemShares)
      .values({ instrumentId, orgId: a.ownerOrgId, access: "edit", addedBy: u.email })
      .onConflictDoNothing();
  }
  await audit({
    actor: u.email, instrumentId, entityType: "instrument", entityId: tag,
    action: `tracked ${a.kind}${a.model ? ` ${a.model}` : ""}${a.serial ? ` SN ${a.serial}` : ""} as system ${tag}`,
  });
  rev(instrumentId);
  revalidatePath("/assets");
  revalidatePath(`/assets/${assetId}`);
  return { instrumentId };
}

export async function attachAssets(assetIds: number[], instrumentId: number): Promise<{ error?: string; attached?: number }> {
  const u = await requireEditor();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  try { await assertSystemEditable(u, instrumentId); } catch { return { error: "Not found" }; }
  const ids = [...new Set(assetIds)].filter((id) => Number.isInteger(id));
  if (!ids.length) return { error: "Pick at least one asset" };
  const problems: string[] = [];
  let attached = 0;
  for (const id of ids) {
    const res = await attachOne(id, instrumentId, inst.externalId, u);
    if (res.error) problems.push(res.error);
    else attached++;
  }
  rev(instrumentId);
  revalidatePath("/assets");
  if (attached && problems.length) return { attached, error: `Attached ${attached}. Skipped: ${problems.join("; ")}` };
  if (!attached) return { error: problems.join("; ") || "Nothing to attach" };
  return { attached };
}

/** Take an asset off its system; it becomes a spare. */
export async function detachAsset(assetId: number) {
  const u = await requireEditor();
  const [a] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!a || a.instrumentId === null) return;
  await assertSystemEditable(u, a.instrumentId);
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, a.instrumentId));
  // Nothing travels with a unit becoming a spare: a shelf is not a place one
  // module serves another.
  await cutServeLinks(assetId, a.instrumentId, []);
  await db.update(assets).set({ instrumentId: null, status: "Spare" }).where(eq(assets.id, assetId));
  await logAssetEvent(assetId, "removed", a.instrumentId, `from ${inst?.externalId ?? "?"}`, u.name);
  await audit({
    actor: u.email, instrumentId: a.instrumentId, entityType: "asset", entityId: assetId,
    action: `removed ${assetLabel(a)} (now a spare)`,
  });
  rev(a.instrumentId);
  revalidatePath("/assets");
  revalidatePath(`/assets/${assetId}`);
}

/**
 * Move an asset straight from one system to another; history follows the asset.
 *
 * `bringing` is the support units that come with it - the roughing pump plumbed
 * to this mass spec. Offered rather than cascaded: a pump often stays with the
 * bench while the spec goes back to the shop, so which ones travel is a
 * question for whoever is carrying them. Servers left behind lose their link,
 * because a hose does not reach between two systems.
 */
export async function moveAsset(
  assetId: number, toInstrumentId: number, bringing: number[] = [],
): Promise<{ error?: string }> {
  return moveAssetTo(assetId, toInstrumentId, bringing, false);
}

/**
 * `keepServes` is why this is not the exported action: it is true only when a
 * unit is travelling WITH the module it serves, and a caller who could set it
 * from the browser could strand a link pointing at another system - the one
 * thing the column promises never happens.
 */
async function moveAssetTo(
  assetId: number, toInstrumentId: number, bringing: number[], keepServes: boolean,
): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [a] = await db.select().from(assets).where(eq(assets.id, assetId));
  const [to] = await db.select().from(instruments).where(eq(instruments.id, toInstrumentId));
  if (!a || !to) return { error: "Not found" };
  if (a.instrumentId === toInstrumentId) return {};
  // A move touches two systems; an org must be able to edit both, or it could
  // pull a unit out of a workspace it doesn't own.
  try {
    await assertSystemEditable(u, toInstrumentId);
    if (a.instrumentId !== null) await assertSystemEditable(u, a.instrumentId);
  } catch { return { error: "Not found" }; }
  const from = a.instrumentId !== null
    ? (await db.select().from(instruments).where(eq(instruments.id, a.instrumentId)))[0] : null;
  // Decided before the move, while the old system's rows still say who served
  // whom; the ones coming along are moved after, so their link survives intact.
  const bring = await cutServeLinks(assetId, a.instrumentId, bringing, keepServes);
  await db.update(assets).set({ instrumentId: toInstrumentId, status: "In service" }).where(eq(assets.id, assetId));
  await logAssetEvent(assetId, "moved", toInstrumentId, `${from?.externalId ?? "spare"} -> ${to.externalId}`, u.name);
  if (from) {
    await audit({
      actor: u.email, instrumentId: from.id, entityType: "asset", entityId: assetId,
      action: `moved ${assetLabel(a)} to ${to.externalId}`,
    });
    rev(from.id);
  }
  await audit({
    actor: u.email, instrumentId: toInstrumentId, entityType: "asset", entityId: assetId,
    action: `installed ${assetLabel(a)}${from ? ` (moved from ${from.externalId})` : ""}`,
  });
  await generateCheckout(toInstrumentId, a, u.email, a.tenantOrgId);
  // Same as attach: the destination system's type may owe this unit upkeep
  // the source's didn't.
  await applyProcedures(assetId, shopToday(), u.email);
  await applyCatalogGases({ instrumentId: toInstrumentId, assetId: null }, a.tenantOrgId);
  // The ones plumbed to it follow, keeping their link - both ends land on the
  // same system, so it never dangles. Not recursive in practice: a server
  // cannot itself be served, so each of these brings nothing of its own.
  for (const id of bring) await moveAssetTo(id, toInstrumentId, [], true);
  rev(toInstrumentId);
  revalidatePath("/assets");
  revalidatePath(`/assets/${assetId}`);
  return {};
}

/** End of life: detach + Decommissioned. The dossier and history stay. */
export async function decommissionAsset(assetId: number) {
  const u = await requireStaff();
  const [a] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!a || a.status === "Decommissioned") return;
  const fromId = a.instrumentId;
  // Nothing follows a unit out of service, in either direction.
  await cutServeLinks(assetId, fromId, []);
  await db.update(assets).set({ instrumentId: null, status: "Decommissioned" }).where(eq(assets.id, assetId));
  await logAssetEvent(assetId, "status", fromId, `${a.status} -> Decommissioned`, u.name);
  await audit({
    actor: u.email, instrumentId: fromId ?? undefined, entityType: "asset", entityId: assetId,
    action: `decommissioned ${assetLabel(a)}`,
  });
  if (fromId !== null) rev(fromId);
  revalidatePath("/assets");
  revalidatePath(`/assets/${assetId}`);
}

/** Hard delete, for records created by mistake. History goes with it. */
export async function removeAsset(assetId: number, reason: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [a] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!a) return {};
  await db.delete(assets).where(eq(assets.id, assetId)); // events cascade; tags null out
  await audit({
    actor: u.email, instrumentId: a.instrumentId ?? undefined, entityType: "asset", entityId: assetId,
    action: `deleted asset record ${assetLabel(a)} - reason: ${why}`, field: "reason", newValue: why,
  });
  if (a.instrumentId !== null) rev(a.instrumentId);
  revalidatePath("/assets");
  return {};
}

/**
 * Delete several asset records at once, under one reason. The cleanup half of
 * an import that went wrong: hunting down forty accidental rows one confirm
 * dialog at a time is how people give up and edit the database by hand.
 *
 * Each deletion is audited on its own line - a batch is a convenience for the
 * person, not a single event in the record - and a row that can't be removed
 * reports back instead of aborting the rest.
 */
export async function removeAssets(
  assetIds: number[], reason: string,
): Promise<{ error?: string; deleted?: number; failures?: { id: number; error: string }[] }> {
  const u = await requireStaff();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const ids = [...new Set(assetIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return { error: "Nothing selected" };
  if (ids.length > 200) return { error: "Delete 200 at a time" };
  const rows = await db.select().from(assets).where(inArray(assets.id, ids));
  const failures: { id: number; error: string }[] = [];
  let deleted = 0;
  for (const a of rows) {
    try {
      await db.delete(assets).where(eq(assets.id, a.id)); // events cascade; tags null out
      await audit({
        actor: u.email, instrumentId: a.instrumentId ?? undefined, entityType: "asset", entityId: a.id,
        action: `deleted asset record ${assetLabel(a)} - reason: ${why}`, field: "reason", newValue: why,
      });
      if (a.instrumentId !== null) rev(a.instrumentId);
      deleted++;
    } catch (e) {
      failures.push({ id: a.id, error: (e as Error).message });
    }
  }
  if (deleted > 1) {
    // One summary line so the audit log reads as the single decision it was.
    await audit({
      actor: u.email, entityType: "asset", entityId: "bulk",
      action: `deleted ${deleted} asset records in one action - reason: ${why}`,
      field: "reason", newValue: why,
    });
  }
  revalidatePath("/assets");
  rev();
  return { deleted, failures };
}

// ---------------- Gases ----------------

/**
 * Add a gas requirement. Any name is allowed - GASES in lib/stages.ts is just
 * the starter list, so the shop can add its own (CO2, Zero air, ...) without a
 * settings trip.
 */
export async function addInstrumentGas(target: WorkTarget, gas: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  const name = gas.trim();
  if (!name || name.length > 40) return { error: "Gas name must be 1-40 characters" };
  const t0 = await resolveTarget(target);
  if ("error" in t0) return t0;
  const existing = await db.select().from(instrumentGases).where(
    t0.instrumentId !== null
      ? eq(instrumentGases.instrumentId, t0.instrumentId)
      : eq(instrumentGases.assetId, t0.assetId!)
  );
  if (existing.some((g) => g.gas.toLowerCase() === name.toLowerCase())) return { error: `${name} is already listed` };
  await db.insert(instrumentGases).values({
    instrumentId: t0.instrumentId, assetId: t0.instrumentId === null ? t0.assetId : null, gas: name,
  });
  await audit({
    actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId, entityType: "gas",
    entityId: targetLabel(t0.externalId, t0.asset),
    action: `added gas requirement: ${name}`, field: "gas", newValue: name,
  });
  revWork({ instrumentId: t0.instrumentId, assetId: t0.assetId });
  return {};
}

export async function setGasStatus(gasId: number, status: string) {
  const u = await requireEditor();
  if (!(GAS_STATES as readonly string[]).includes(status)) throw new Error("Unknown gas status");
  const [g] = await db.select().from(instrumentGases).where(eq(instrumentGases.id, gasId));
  if (!g) throw new Error("Not found");
  if (g.status === status) return;
  const [inst] = g.instrumentId !== null
    ? await db.select().from(instruments).where(eq(instruments.id, g.instrumentId)) : [];
  await assertWorkEditable(u, g);
  await db.update(instrumentGases).set({ status, updatedAt: new Date() }).where(eq(instrumentGases.id, gasId));
  await audit({
    actor: u.email, instrumentId: g.instrumentId, assetId: g.assetId, entityType: "gas", entityId: inst?.externalId ?? "",
    action: `${g.gas}: ${g.status} -> ${status}`, field: "status", oldValue: g.status, newValue: status,
  });
  if (status === "Empty") {
    if (g.instrumentId !== null) {
      await notifyGasEmpty({
        actorEmail: u.email, actorName: u.name, gas: g.gas,
        instrumentId: g.instrumentId, externalId: inst?.externalId ?? "",
      });
    }
  }
  revWork(g);
}

export async function updateGasNote(gasId: number, note: string) {
  const u = await requireEditor();
  const [g] = await db.select().from(instrumentGases).where(eq(instrumentGases.id, gasId));
  if (!g) throw new Error("Not found");
  const t = note.trim();
  if (g.note === t) return;
  const [inst] = g.instrumentId !== null
    ? await db.select().from(instruments).where(eq(instruments.id, g.instrumentId)) : [];
  await assertWorkEditable(u, g);
  await db.update(instrumentGases).set({ note: t, updatedAt: new Date() }).where(eq(instrumentGases.id, gasId));
  await audit({
    actor: u.email, instrumentId: g.instrumentId, assetId: g.assetId, entityType: "gas", entityId: inst?.externalId ?? "",
    action: `updated ${g.gas} note`, field: "note", oldValue: g.note, newValue: t,
  });
  revWork(g);
}

export async function removeInstrumentGas(gasId: number) {
  const u = await requireStaff();
  const [g] = await db.select().from(instrumentGases).where(eq(instrumentGases.id, gasId));
  if (!g) throw new Error("Not found");
  const [inst] = g.instrumentId !== null
    ? await db.select().from(instruments).where(eq(instruments.id, g.instrumentId)) : [];
  await assertWorkEditable(u, g);
  await db.delete(instrumentGases).where(eq(instrumentGases.id, gasId));
  await audit({
    actor: u.email, instrumentId: g.instrumentId, assetId: g.assetId, entityType: "gas", entityId: inst?.externalId ?? "",
    action: `removed gas requirement: ${g.gas}`, field: "gas", oldValue: g.gas,
  });
  revWork(g);
}

/**
 * An asset tag is only valid if the asset is currently attached to that system.
 * A null system means the row already belongs to the asset itself.
 */
async function validAssetTag(assetId: number | null | undefined, instrumentId: number | null) {
  if (!assetId || instrumentId === null) return null;
  const [a] = await db.select().from(assets).where(eq(assets.id, assetId));
  return a && a.instrumentId === instrumentId ? a : null;
}

// ---------------- Tasks ----------------

export async function createTask(
  target: WorkTarget,
  data: { title: string; body: string; assignee: string; dueDate?: string },
): Promise<{ error?: string }> {
  const u = await requireEditor();
  if (!data.title.trim()) return { error: "Title required" };
  const t0 = await resolveTarget(target);
  if ("error" in t0) return t0;
  const [t] = await db.insert(tasks).values({
    tenantOrgId: t0.tenantOrgId,
    instrumentId: t0.instrumentId, assetId: t0.assetId,
    title: data.title.trim(), body: data.body.trim(), assignee: data.assignee.trim(),
    dueDate: (data.dueDate ?? "").trim(),
    workOrderId: t0.workOrderId,
  }).returning();
  await audit({
    actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId, entityType: "task", entityId: t.id,
    action: `created task '${t.title}'${t0.asset ? ` [${assetLabel(t0.asset)}]` : ""}${t.assignee ? ` (assigned ${t.assignee})` : ""}${t.dueDate ? ` due ${t.dueDate}` : ""}`,
  });
  if (t.assignee) {
    await notifyTaskAssigned({
      actorEmail: u.email, actorName: u.name, assignee: t.assignee,
      taskTitle: t.title, instrumentId: t0.instrumentId ?? undefined,
      assetId: t0.assetId ?? undefined,
      externalId: targetLabel(t0.externalId, t0.asset),
    });
  }
  revWork(t);
  return {};
}

/**
 * Copy tasks onto another system or unit.
 *
 * Written for the afternoon it saves: fifteen pump tasks exist on one system and
 * an all-in-one pump has just arrived on another that needs the same fifteen.
 *
 * Both ends are checked, separately and for different reasons. The source has to
 * be READABLE - copying is a way of reading a task, and a system somebody cannot
 * open must not become one they can read the checklists of. The target has to be
 * WRITABLE, because this creates work on it. resolveTarget answers the second;
 * assertSystemVisible and assetAccess answer the first.
 *
 * What survives the trip, and what deliberately does not, is lib/taskCopy - the
 * short version being that a copy arrives as open work with no schedule, no
 * sign-off gate and nothing ticked.
 */
export async function copyTasksTo(
  taskIds: number[], target: WorkTarget,
): Promise<{ error?: string; copied?: number }> {
  const u = await requireEditor();
  const ids = [...new Set(taskIds)].filter((id) => Number.isInteger(id));
  if (!ids.length) return { error: "Nothing selected" };
  if (ids.length > 100) return { error: "That is more tasks than one copy should move." };

  const t0 = await resolveTarget(target);
  if ("error" in t0) return t0;

  const rows = await db.select().from(tasks).where(inArray(tasks.id, ids));
  if (!rows.length) return { error: "Not found" };

  // Readable at the source, one system or unit at a time rather than per task -
  // a batch usually comes off a single record, and the check is a round trip.
  for (const instrumentId of [...new Set(rows.map((r) => r.instrumentId))]) {
    if (instrumentId === null) continue;
    try { await assertSystemVisible(u, instrumentId); } catch { return { error: "Not found" }; }
  }
  for (const assetId of [...new Set(rows.map((r) => r.assetId))]) {
    if (assetId === null) continue;
    if (!(await assetAccess(u, assetId)).see) return { error: "Not found" };
  }

  const items = rows.length
    ? await db.select().from(checklistItems).where(inArray(checklistItems.taskId, rows.map((r) => r.id)))
    : [];

  // After whatever is already there, so a copy appends rather than interleaving.
  const existing = await db.select({ sortOrder: tasks.sortOrder }).from(tasks)
    .where(t0.instrumentId !== null ? eq(tasks.instrumentId, t0.instrumentId) : eq(tasks.assetId, t0.assetId!));
  const after = existing.reduce((n, r) => Math.max(n, r.sortOrder), 0);

  const plan = copyPlan(rows.filter(copyable).map((r) => ({
    id: r.id, title: r.title, body: r.body, assignee: r.assignee, dueDate: r.dueDate,
    state: r.state, origin: r.origin, assetId: r.assetId,
    pmScheduleId: r.pmScheduleId, procedureId: r.procedureId, sortOrder: r.sortOrder,
    checklist: items.filter((c) => c.taskId === r.id).map((c) => ({ text: c.text, sortOrder: c.sortOrder })),
  })), after);
  if (!plan.length) return { error: "Nothing to copy" };

  for (const copy of plan) {
    const [made] = await db.insert(tasks).values({
      tenantOrgId: t0.tenantOrgId,
      instrumentId: t0.instrumentId, assetId: t0.instrumentId === null ? t0.assetId : null,
      title: copy.title, body: copy.body, assignee: copy.assignee, dueDate: copy.dueDate,
      state: copy.state, origin: copy.origin, sortOrder: copy.sortOrder,
    }).returning();
    if (copy.checklist.length) {
      await db.insert(checklistItems).values(copy.checklist.map((c) => ({
        taskId: made.id, text: c.text, done: c.done, sortOrder: c.sortOrder,
      })));
    }
  }

  // One line for the batch, on the record that gained the work. Fifteen audit
  // rows saying the same thing would bury the day it happened.
  await audit({
    actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId,
    entityType: "task", entityId: 0,
    action: copySummary(plan.map((p) => p.title), targetLabel(t0.externalId, t0.asset)),
  });
  revWork({ instrumentId: t0.instrumentId, assetId: t0.assetId });
  return { copied: plan.length };
}

export async function setTaskAsset(taskId: number, assetId: number | null) {
  const u = await requireEditor();
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t) return;
  const tagged = await validAssetTag(assetId, t.instrumentId);
  const next = tagged?.id ?? null;
  if (t.assetId === next) return;
  await assertWorkEditable(u, t);
  await db.update(tasks).set({ assetId: next }).where(eq(tasks.id, taskId));
  await audit({
    actor: u.email, instrumentId: t.instrumentId, assetId: t.assetId, entityType: "task", entityId: taskId,
    action: tagged ? `tagged '${t.title}' to ${assetLabel(tagged)}` : `untagged '${t.title}' (whole system)`,
  });
  revWork(t);
}

export async function setTaskDue(taskId: number, dueDate: string) {
  const u = await requireEditor();
  const due = dueDate.trim();
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return;
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t || t.dueDate === due) return;
  await assertWorkEditable(u, t);
  await db.update(tasks).set({ dueDate: due }).where(eq(tasks.id, taskId));
  await audit({
    actor: u.email, instrumentId: t.instrumentId, assetId: t.assetId, entityType: "task", entityId: taskId,
    action: due ? `set '${t.title}' due ${due}` : `cleared the due date on '${t.title}'`,
    field: "dueDate", oldValue: t.dueDate, newValue: due,
  });
  revWork(t);
}

export async function updateTask(taskId: number, data: { title: string; body: string }) {
  const u = await requireEditor();
  const title = data.title.trim();
  if (!title) throw new Error("Title required");
  const body = data.body.trim();
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t || (t.title === title && t.body === body)) return;
  await assertWorkEditable(u, t);
  await db.update(tasks).set({ title, body }).where(eq(tasks.id, taskId));
  if (t.title !== title) {
    await audit({
      actor: u.email, instrumentId: t.instrumentId, assetId: t.assetId, entityType: "task", entityId: taskId,
      action: `renamed task '${t.title}' to '${title}'`, field: "title", oldValue: t.title, newValue: title,
    });
  }
  if (t.body !== body) {
    await audit({
      actor: u.email, instrumentId: t.instrumentId, assetId: t.assetId, entityType: "task", entityId: taskId,
      action: `edited task '${title}' description`, field: "body", oldValue: t.body, newValue: body,
    });
  }
  revWork(t);
}

export async function deleteTask(taskId: number, reason: string): Promise<{ error?: string }> {
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t) { await requireStaff(); return {}; }
  // Checkout tests and PM tasks are auto-generated, so any editor may clear
  // ones that don't apply (a still-due PM schedule just regenerates on the
  // next run); hand-written tasks stay staff-only to delete.
  const u = t.origin === "checkout" || t.origin === "pm" ? await requireEditor() : await requireStaff();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  await assertWorkEditable(u, t);
  await db.delete(tasks).where(eq(tasks.id, taskId)); // checklist + notes cascade
  await audit({
    actor: u.email, instrumentId: t.instrumentId, assetId: t.assetId, entityType: "task", entityId: taskId,
    action: `deleted task '${t.title}'${t.state !== "Done" ? ` (was ${t.state})` : ""} - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revWork(t);
  return {};
}

/**
 * The test spec behind a task, or null when it is ordinary work.
 *
 * Read from the procedure that generated it, so a hand-made task is never a
 * test and never gets gated. Copies of tasks deliberately drop procedureId
 * (see lib/taskCopy), which means a copy is ordinary work - correct, because a
 * copy is a new job, not a second reading of the original.
 */
async function testSpecFor(t: { procedureId: number | null }) {
  if (t.procedureId === null) return null;
  const [p] = await db.select({
    kind: procedures.kind, resultType: procedures.resultType,
    target: procedures.target, tolerancePct: procedures.tolerancePct,
  }).from(procedures).where(eq(procedures.id, t.procedureId));
  return p && needsResult(p.kind, p.resultType) ? p : null;
}

/**
 * Record what a test read.
 *
 * The verdict is computed here rather than taken from the browser: a reading is
 * a claim about an instrument, and whether it passed must not depend on which
 * side of the wire did the arithmetic. The spec is frozen onto the row for the
 * same reason - re-tuning the target next year must not restate what this
 * reading meant.
 */
export async function recordTaskResult(
  taskId: number, data: { value: string; note: string },
): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t) return { error: "Not found" };
  await assertWorkEditable(u, t);
  const spec = await testSpecFor(t);
  if (!spec) return { error: "That task isn't a test" };

  const value = data.value.trim();
  if (!resultIsRecorded(spec.resultType, value)) {
    return {
      error: spec.resultType === "pass_fail" ? "Say whether it passed or failed"
        : spec.resultType === "inspect_replace" ? "Say which happened - inspected, or replaced"
        : spec.resultType === "measured" || spec.resultType === "reading" ? "Enter the number you read"
        : "Write down what you found",
    };
  }
  const verdict = evaluateResult(spec, value);
  const row = {
    resultType: spec.resultType, value, passed: verdict.passed,
    target: spec.target ?? "", tolerancePct: spec.tolerancePct ?? "",
    note: data.note.trim(), recordedBy: u.name || u.email, recordedAt: new Date(),
  };
  await db.insert(taskResults).values({ taskId, ...row })
    .onConflictDoUpdate({ target: taskResults.taskId, set: row });
  await audit({
    actor: u.email, instrumentId: t.instrumentId, assetId: t.assetId, entityType: "task", entityId: taskId,
    action: `recorded '${t.title}': ${verdict.why}`,
    field: "result", newValue: value,
  });
  revWork(t);
  return {};
}

export async function setTaskState(taskId: number, state: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t || t.state === state) return {};
  // Count open checklist items so a premature Done leaves a trace.
  let suffix = "";
  if (state === "Done") {
    const items = await db.select().from(checklistItems).where(and(eq(checklistItems.taskId, taskId), eq(checklistItems.done, false)));
    if (items.length) suffix = ` (closed with ${items.length} checklist item${items.length > 1 ? "s" : ""} incomplete)`;
    // A test closed with no number is a checkbox claiming to be a measurement.
    // Only the having of a result is gated, never the passing of one - a failed
    // test is a finished test, and holding the task open would file the failure
    // somewhere nobody looks.
    const spec = await testSpecFor(t);
    if (spec) {
      const [r] = await db.select().from(taskResults).where(eq(taskResults.taskId, taskId));
      const blocked = completionBlocked({ kind: spec.kind, resultType: spec.resultType }, r);
      if (blocked) return { error: blocked };
    }
  }
  await assertWorkEditable(u, t);
  await db.update(tasks).set({ state, completedAt: state === "Done" ? new Date() : null }).where(eq(tasks.id, taskId));
  await audit({
    actor: u.email, instrumentId: t.instrumentId, assetId: t.assetId, entityType: "task", entityId: taskId,
    action: `set task '${t.title}' to ${state}${suffix}`, field: "state", oldValue: t.state, newValue: state,
  });
  // Completing scheduled maintenance advances its schedule - from the day the
  // work was DONE, so doing it late doesn't owe the next one early. Reopening
  // the task deliberately does not roll the schedule back: the work happened,
  // and the reopen is bookkeeping about that occurrence, not a new cycle.
  if (state === "Done" && t.pmScheduleId !== null) {
    const [s] = await db.select().from(pmSchedules).where(eq(pmSchedules.id, t.pmScheduleId));
    if (s) {
      const today = shopToday();
      const nextDue = advancePm(today, s.everyDays);
      await db.update(pmSchedules).set({ lastDone: today, nextDue }).where(eq(pmSchedules.id, s.id));
      await audit({
        actor: u.email, instrumentId: s.instrumentId, assetId: s.assetId, entityType: "pm", entityId: s.id,
        action: `maintenance '${s.title}' done - next due ${nextDue} (${cadenceLabel(s.everyDays)})`,
        field: "nextDue", oldValue: s.nextDue, newValue: nextDue,
      });
    }
  }
  revWork(t);
  return {};
}

// ---------------- Maintenance schedules ----------------
// The calendar half of PM: schedules live on a system or standalone asset and
// the daily cron (plus every mutation below) turns due ones into ordinary
// tasks via lib/pmGenerate. Same visibility rules as the tasks they produce.

export async function addPmSchedule(
  target: WorkTarget,
  data: {
    title: string; body: string; assignee: string; everyDays: number | string; firstDue: string;
    partName?: string; partNumber?: string;
  },
): Promise<{ error?: string }> {
  const u = await requireEditor();
  if (!data.title.trim()) return { error: "Title required" };
  const cadence = parseCadence(data.everyDays);
  if ("error" in cadence) return cadence;
  const firstDue = data.firstDue.trim();
  if (!isIsoDay(firstDue)) return { error: "Pick a first due date" };
  const t0 = await resolveTarget(target);
  if ("error" in t0) return t0;
  const [s] = await db.insert(pmSchedules).values({
    tenantOrgId: t0.tenantOrgId,
    instrumentId: t0.instrumentId, assetId: t0.assetId,
    title: data.title.trim(), body: data.body.trim(), assignee: data.assignee.trim(),
    everyDays: cadence.days, nextDue: firstDue, createdBy: u.email,
    partName: (data.partName ?? "").trim(), partNumber: (data.partNumber ?? "").trim(),
  }).returning();
  await audit({
    actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId, entityType: "pm", entityId: s.id,
    action: `scheduled maintenance '${s.title}' ${cadenceLabel(s.everyDays)}${t0.asset ? ` [${assetLabel(t0.asset)}]` : ""}, first due ${firstDue}${s.assignee ? `, assigned ${s.assignee}` : ""}`,
  });
  // Due today (or created already overdue): the task exists before the page
  // reloads, not after tomorrow's cron.
  await generateDuePmTasks(shopToday(), u.email);
  revWork(s);
  return {};
}

export async function updatePmSchedule(
  id: number,
  data: { assignee: string; everyDays: number | string; nextDue: string },
): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [s] = await db.select().from(pmSchedules).where(eq(pmSchedules.id, id));
  if (!s) return { error: "Not found" };
  await assertWorkEditable(u, s);
  const cadence = parseCadence(data.everyDays);
  if ("error" in cadence) return cadence;
  const nextDue = data.nextDue.trim();
  if (!isIsoDay(nextDue)) return { error: "Pick a next due date" };
  const assignee = data.assignee.trim();
  if (s.everyDays === cadence.days && s.nextDue === nextDue && s.assignee === assignee) return {};
  await db.update(pmSchedules).set({ everyDays: cadence.days, nextDue, assignee }).where(eq(pmSchedules.id, id));
  await audit({
    actor: u.email, instrumentId: s.instrumentId, assetId: s.assetId, entityType: "pm", entityId: id,
    action: `rescheduled maintenance '${s.title}': ${cadenceLabel(cadence.days)}, next due ${nextDue}${assignee !== s.assignee ? `, assigned ${assignee || "nobody"}` : ""}`,
    field: "nextDue", oldValue: `${s.nextDue} (${cadenceLabel(s.everyDays)})`, newValue: `${nextDue} (${cadenceLabel(cadence.days)})`,
  });
  await generateDuePmTasks(shopToday(), u.email);
  revWork(s);
  return {};
}

/**
 * Anchor every schedule on a record to one real-world date.
 *
 * A new system's schedules anchor to the day the record was created, which is
 * only right if the PM happened that day. Usually it didn't: the vendor did it
 * in March, or the visit is booked for January. Fixing that one row at a time
 * across a dozen schedules is the copy/paste this whole catalog exists to kill.
 *
 * Two anchors, because those are the two facts somebody actually knows:
 *  - "the PM was done on D": lastDone = D and each schedule comes due its OWN
 *    cadence later - the quarterly work in three months, the annual next year.
 *  - "the next visit is D": everything falls due together on D, the way a PM
 *    visit works, and each advances by its own cadence after completion.
 *
 * Open generated tasks from the old anchor are removed - they were scheduled
 * on a premise this action just corrected - but only untouched ones: a task
 * somebody moved to In progress or Blocked is being worked and stays.
 */
export async function alignMaintenance(
  target: WorkTarget, data: { mode: "lastDone" | "visit"; date: string; fileRecord?: boolean },
): Promise<{ error?: string; changed?: number }> {
  const u = await requireEditor();
  const date = data.date.trim();
  if (!isIsoDay(date)) return { error: "Pick a date" };

  let rows: (typeof pmSchedules.$inferSelect)[] = [];
  if (target.instrumentId !== null) {
    await assertSystemEditable(u, target.instrumentId);
    // The system's own schedules and those living on its installed units - one
    // PM visit covers the stack, so the alignment does too.
    const unitIds = (await db.select({ id: assets.id }).from(assets)
      .where(eq(assets.instrumentId, target.instrumentId))).map((a) => a.id);
    rows = await db.select().from(pmSchedules).where(
      unitIds.length
        ? or(eq(pmSchedules.instrumentId, target.instrumentId), inArray(pmSchedules.assetId, unitIds))
        : eq(pmSchedules.instrumentId, target.instrumentId)
    );
  } else if (target.assetId !== null) {
    if (!(await assetAccess(u, target.assetId)).edit) return { error: "Not found" };
    rows = await db.select().from(pmSchedules).where(eq(pmSchedules.assetId, target.assetId));
  }
  if (!rows.length) return { error: "Nothing scheduled here yet" };

  for (const s of rows) {
    const nextDue = data.mode === "lastDone" ? advancePm(date, s.everyDays) : date;
    const set = data.mode === "lastDone" ? { lastDone: date, nextDue } : { nextDue };
    if (s.nextDue === nextDue && (data.mode !== "lastDone" || s.lastDone === date)) continue;
    await db.update(pmSchedules).set(set).where(eq(pmSchedules.id, s.id));
  }
  // "The PM was done that day" can also FILE the done work, so the visit
  // exists as history and not just as arithmetic on the next due date.
  if (data.mode === "lastDone" && data.fileRecord) {
    for (const s of rows) {
      // Asset-hosted schedules file against the system too - the alignment was
      // asked for from the system, and that is where the history reads.
      const onSystem = s.instrumentId ?? target.instrumentId;
      await db.insert(tasks).values({
        tenantOrgId: s.tenantOrgId, instrumentId: onSystem, assetId: s.assetId,
        title: s.title, body: `Backfilled - done ${date} (PM visit).`,
        state: "Done", origin: "pm", pmScheduleId: s.id, procedureId: s.procedureId,
        dueDate: date, completedAt: new Date(`${date}T12:00:00Z`),
      });
    }
  }
  // Tasks generated off the old anchor claim work that this correction says is
  // not owed yet (or was already done). Only untouched Open ones go.
  const stale = await db.select().from(tasks).where(and(
    inArray(tasks.pmScheduleId, rows.map((r) => r.id)),
    eq(tasks.origin, "pm"), eq(tasks.state, "Open"),
  ));
  for (const t of stale) await db.delete(tasks).where(eq(tasks.id, t.id));

  await audit({
    actor: u.email, instrumentId: target.instrumentId, assetId: target.assetId, entityType: "pm", entityId: 0,
    action: data.mode === "lastDone"
      ? `aligned ${rows.length} maintenance schedule${rows.length === 1 ? "" : "s"} to a PM done ${date} - each next due its own cadence later${stale.length ? `; removed ${stale.length} stale generated task${stale.length === 1 ? "" : "s"}` : ""}`
      : `aligned ${rows.length} maintenance schedule${rows.length === 1 ? "" : "s"} to a PM visit on ${date}${stale.length ? `; removed ${stale.length} stale generated task${stale.length === 1 ? "" : "s"}` : ""}`,
    field: "nextDue", newValue: date,
  });
  // A visit date that is already here should produce its work now, not at 3am.
  await generateDuePmTasks(shopToday(), u.email);
  revWork({ instrumentId: target.instrumentId, assetId: target.assetId });
  return { changed: rows.length };
}

/**
 * Do a scheduled job now, before it falls due.
 *
 * Without this a schedule was only ever a promise: procedures stamp the first
 * cycle a full cadence out, the generator only fires on what is due, and so a
 * newly defined yearly PM had nothing to work on for a year and nothing to
 * complete. An engineer standing at the instrument is the reason a PM exists;
 * the calendar is only a reminder.
 *
 * Completing the task it creates advances the cadence from today, exactly as it
 * does for a task the cron made - the schedule does not need touching by hand.
 */
export async function runPmNow(scheduleId: number): Promise<{ error?: string; taskId?: number }> {
  const u = await requireEditor();
  const [s] = await db.select().from(pmSchedules).where(eq(pmSchedules.id, scheduleId));
  if (!s) return { error: "Not found" };

  // Same visibility rule as the work it produces.
  const onSystem = s.instrumentId ?? (s.assetId === null
    ? null
    : (await db.select({ instrumentId: assets.instrumentId }).from(assets).where(eq(assets.id, s.assetId)))[0]?.instrumentId ?? null);
  if (onSystem !== null) {
    try { await assertSystemEditable(u, onSystem); } catch { return { error: "Not found" } as { error: string }; }
  }

  // One open task per schedule, here as much as in the generator: a second copy
  // of the same job is how two people do it once each.
  const [open] = await db.select({ id: tasks.id }).from(tasks)
    .where(and(eq(tasks.pmScheduleId, scheduleId), ne(tasks.state, "Done")))
    .limit(1);
  if (open) return { taskId: open.id };

  const t = await createPmTask(s, onSystem, shopToday(), u.email,
    `started scheduled maintenance early: '${s.title}' (was due ${s.nextDue})`);
  if (s.instrumentId !== null) rev(s.instrumentId);
  else if (s.assetId !== null) revalidatePath(`/assets/${s.assetId}`);
  revalidatePath("/maintenance");
  return { taskId: t.id };
}

/**
 * File a PM that happened before the software was watching.
 *
 * The record is a Done task on the date it was done - exactly what completing
 * the job live would have left - so it prints on packets, counts in history,
 * and reads like every other completed PM. The schedule's calendar moves only
 * when this is the LATEST known completion and only when asked: logging the
 * 2024 visit after the 2026 one is filling in history, not turning the clock
 * back.
 */
export async function logPastPm(
  scheduleId: number,
  data: { date: string; note: string; doneBy?: string; advanceSchedule: boolean },
): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [sched] = await db.select().from(pmSchedules).where(eq(pmSchedules.id, scheduleId));
  if (!sched) return { error: "Not found" };
  await assertWorkEditable(u, sched);
  const date = data.date.trim();
  if (!isIsoDay(date)) return { error: "Pick the date it was done" };
  if (date > shopToday()) return { error: "That's the future - use Do it now for work that's happening" };
  const doneBy = (data.doneBy ?? "").trim() || (u.name || u.email);

  // Same resolution as live generation: a schedule on an installed unit files
  // its work against the SYSTEM too, so the history reads in one place.
  const onSystem = sched.instrumentId ?? (sched.assetId === null
    ? null
    : (await db.select({ instrumentId: assets.instrumentId }).from(assets)
        .where(eq(assets.id, sched.assetId)))[0]?.instrumentId ?? null);

  const [t] = await db.insert(tasks).values({
    tenantOrgId: sched.tenantOrgId,
    instrumentId: onSystem, assetId: sched.assetId,
    title: sched.title,
    body: [data.note.trim(), `Backfilled - done ${date} by ${doneBy}.`].filter(Boolean).join("\n"),
    state: "Done", origin: "pm", pmScheduleId: sched.id, procedureId: sched.procedureId,
    assignee: doneBy, dueDate: date,
    completedAt: new Date(`${date}T12:00:00Z`),
  }).returning();
  // Only the latest known completion may move the calendar, and only when
  // asked - a bulk Align may already have pinned the dates deliberately.
  if (data.advanceSchedule && (sched.lastDone === "" || date > sched.lastDone)) {
    await db.update(pmSchedules)
      .set({ lastDone: date, nextDue: advancePm(date, sched.everyDays) })
      .where(eq(pmSchedules.id, sched.id));
  }
  await audit({
    actor: u.email, instrumentId: sched.instrumentId, assetId: sched.assetId,
    entityType: "pm", entityId: sched.id,
    action: `logged past completion of '${sched.title}' - done ${date} by ${doneBy}`
      + (data.advanceSchedule && (sched.lastDone === "" || date > sched.lastDone)
        ? ` (next due ${advancePm(date, sched.everyDays)})` : ""),
    field: "lastDone", newValue: date,
  });
  revWork(sched);
  void t;
  return {};
}

/**
 * Undo an accidental "Do it now".
 *
 * Starting a job early only creates the task - the schedule's dates are never
 * touched until the work is COMPLETED - so undoing is removing that task, and
 * only while it is genuinely untouched: still Open, nothing recorded against
 * it. Work somebody has picked up is not an accident anymore, and a job that
 * has actually fallen due is owed regardless of how its task came to exist.
 */
export async function undoRunPmNow(scheduleId: number): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [s] = await db.select().from(pmSchedules).where(eq(pmSchedules.id, scheduleId));
  if (!s) return { error: "Not found" };
  await assertWorkEditable(u, s);
  const [t] = await db.select().from(tasks)
    .where(and(eq(tasks.pmScheduleId, scheduleId), ne(tasks.state, "Done"))).limit(1);
  if (!t) return { error: "Nothing to undo - no open task for this schedule" };
  if (s.nextDue <= shopToday()) {
    return { error: "This job is actually due - the work is owed, so finish it or reschedule the date instead" };
  }
  if (t.state !== "Open") {
    return { error: `Somebody moved it to ${t.state} - if it really shouldn't exist, delete it from Tasks with a reason` };
  }
  const [r] = await db.select().from(taskResults).where(eq(taskResults.taskId, t.id));
  if (r) return { error: "A result has been recorded against it - that's work now, not an accident" };
  await db.delete(tasks).where(eq(tasks.id, t.id)); // checklist + notes cascade
  await audit({
    actor: u.email, instrumentId: s.instrumentId, assetId: s.assetId, entityType: "pm", entityId: s.id,
    action: `undid an early start of '${s.title}' - the schedule keeps its ${s.nextDue} due date`,
  });
  revWork(s);
  return {};
}

export async function setPmPaused(id: number, paused: boolean): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [s] = await db.select().from(pmSchedules).where(eq(pmSchedules.id, id));
  if (!s || s.paused === paused) return {};
  await assertWorkEditable(u, s);
  await db.update(pmSchedules).set({ paused }).where(eq(pmSchedules.id, id));
  await audit({
    actor: u.email, instrumentId: s.instrumentId, assetId: s.assetId, entityType: "pm", entityId: id,
    action: `${paused ? "paused" : "resumed"} maintenance '${s.title}'${paused ? "" : ` - next due ${s.nextDue}`}`,
    field: "paused", oldValue: String(s.paused), newValue: String(paused),
  });
  if (!paused) await generateDuePmTasks(shopToday(), u.email);
  revWork(s);
  return {};
}

/**
 * One tap from "this maintenance takes PN 228-35145-91" to a Needed line in
 * the Parts panel - the same lifecycle every other part follows (ordered, in
 * transit, received, installed), so purchasing runs through the platform
 * instead of a sticky note. Dedupes against an open request for the same
 * number on the same equipment.
 */
export async function requestPmPart(scheduleId: number, partNumber?: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [s] = await db.select().from(pmSchedules).where(eq(pmSchedules.id, scheduleId));
  if (!s) return { error: "Not found" };
  // Which of the schedule's parts - a schedule can carry several. The number
  // must be one the schedule actually names, so this can't file arbitrary
  // parts under a maintenance job's flag.
  const options = schedulePartsOf(s);
  const want = partNumber
    ? options.find((o) => o.number.toLowerCase() === partNumber.toLowerCase())
    : options[0];
  if (!want || !want.number) return { error: "Not found" };
  await assertWorkEditable(u, s);
  // An asset-bound schedule files the part on the unit AND its current system,
  // so both pages show it coming.
  const [a] = s.assetId !== null ? await db.select().from(assets).where(eq(assets.id, s.assetId)) : [];
  const instrumentId = s.instrumentId ?? a?.instrumentId ?? null;
  // A procedure written three years ago names the number the maker sold then.
  // Ordering it is ordering something nobody stocks any more, so the catalog's
  // replacement wins - and the note says which number was asked for, because
  // the person reading the PO is holding the old paperwork.
  //
  // Resolved BEFORE the duplicate check, or requesting the old number and then
  // the new one would file the same part twice: the check would look for the
  // number on the sheet while the row carries the number being bought.
  const catalog = await loadAliases(
    await db.select().from(partCatalog).where(forTenant(partCatalog.tenantOrgId, s.tenantOrgId)),
  ).catch(() => []);
  const moved = currentNumber(catalog, want.number);
  const orderPn = moved ? moved.current : want.number;
  const name = want.name || moved?.entry.name || s.title;
  const open = await db.select().from(parts).where(
    s.assetId !== null ? eq(parts.assetId, s.assetId) : eq(parts.instrumentId, instrumentId!)
  );
  // Either spelling counts as already-requested: the open row may predate the
  // supersession, or postdate it.
  const already = open.find((p) => partOpen(p.status)
    && [orderPn, want.number].some((n) => p.partNumber.toLowerCase() === n.toLowerCase()));
  if (already) {
    return { error: `PN ${already.partNumber} is already requested and not yet installed` };
  }
  // Best offer from the house price book, if anyone prices this PN. Filling
  // cost/vendor here doesn't breach the "editors who can't see costs can't
  // write them" rule: the numbers are server-derived staff data, not caller
  // input, and lib/redact still governs who sees them on the way back out.
  //
  // Priced on the number being BOUGHT: the price book is keyed by PN, and a
  // superseded number is exactly the one nobody has a current price under.
  const book = await db.select().from(partPrices);
  const best = bestPrice(book, orderPn);
  const [p] = await db.insert(parts).values({
    instrumentId, assetId: s.assetId, name, partNumber: orderPn,
    // What the procedure says the job takes. Hardcoded to one until the
    // procedure could carry a count, which quietly ordered a single bottle of
    // oil for a change that needs two.
    qty: String(partQty(want)), status: "Needed",
    note: `for maintenance '${s.title}'`
      + (moved ? ` - replaces ${moved.quoted}, which the maintenance sheet still names` : ""),
    // The queryable version of that note: a contract whose PM includes its
    // parts reads this to keep them off the parts allowance.
    pmScheduleId: s.id,
    ownerOrgId: await costOwnerOrg({ instrumentId, assetId: s.assetId }),
    ...(best ? { vendor: best.vendor, cost: centsToInput(best.priceCents), costCents: best.priceCents } : {}),
  }).returning();
  await audit({
    actor: u.email, instrumentId, assetId: s.assetId, entityType: "part", entityId: p.id,
    // No price in the audit line: activity feeds are visible to every org on
    // a shared system, and cost never appears where lib/redact would blank it.
    action: `requested part '${name}' (PN ${orderPn}) for maintenance '${s.title}'`
      + (moved ? ` - ${moved.quoted} is superseded` : "")
      + (best ? ` - from ${best.vendor}${best.isOem ? " (OEM)" : ""} per the price book` : ""),
  });
  revWork(p);
  return {};
}

export async function removePmSchedule(id: number, reason: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [s] = await db.select().from(pmSchedules).where(eq(pmSchedules.id, id));
  if (!s) return {};
  await assertWorkEditable(u, s);
  // Tasks already generated survive (FK sets their schedule null): work that
  // was asked for doesn't vanish because the recurrence ended.
  await db.delete(pmSchedules).where(eq(pmSchedules.id, id));
  await audit({
    actor: u.email, instrumentId: s.instrumentId, assetId: s.assetId, entityType: "pm", entityId: id,
    action: `removed maintenance schedule '${s.title}' (${cadenceLabel(s.everyDays)}) - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revWork(s);
  return {};
}

export async function assignTask(taskId: number, assignee: string) {
  const u = await requireEditor();
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t) return;
  await assertWorkEditable(u, t);
  await db.update(tasks).set({ assignee }).where(eq(tasks.id, taskId));
  await audit({
    actor: u.email, instrumentId: t.instrumentId, assetId: t.assetId, entityType: "task", entityId: taskId,
    action: `assigned '${t.title}' to ${assignee || "nobody"}`, field: "assignee", oldValue: t.assignee, newValue: assignee,
  });
  if (assignee && assignee !== t.assignee) {
    const [inst] = t.instrumentId !== null
      ? await db.select().from(instruments).where(eq(instruments.id, t.instrumentId)) : [];
    const [asset] = t.assetId ? await db.select().from(assets).where(eq(assets.id, t.assetId)) : [];
    await notifyTaskAssigned({
      actorEmail: u.email, actorName: u.name, assignee,
      taskTitle: t.title, instrumentId: t.instrumentId ?? undefined, assetId: t.assetId ?? undefined,
      externalId: inst?.externalId || (asset ? assetLabel(asset) : ""),
    });
  }
  revWork(t);
}

export async function addChecklistItem(taskId: number, text: string) {
  const u = await requireEditor();
  // Same rule a pasted template follows: a line ending in a colon is a section
  // label, not a box. One convention, wherever a line is typed.
  const line = cleanItem(text);
  if (!line) return;
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t) return;
  await assertWorkEditable(u, t);
  const after = await db.select({ sortOrder: checklistItems.sortOrder }).from(checklistItems)
    .where(eq(checklistItems.taskId, taskId));
  await db.insert(checklistItems).values({
    taskId, text: line.text, heading: line.heading,
    sortOrder: Math.max(0, ...after.map((a) => a.sortOrder)) + 1,
  });
  await audit({
    actor: u.email, instrumentId: t.instrumentId, entityType: "checklist_item", entityId: taskId,
    action: `added checklist ${line.heading ? "heading" : "item"} '${line.text}' to '${t.title}'`,
  });
  revWork(t);
}

export async function toggleChecklistItem(itemId: number) {
  const u = await requireEditor();
  const [item] = await db.select().from(checklistItems).where(eq(checklistItems.id, itemId));
  if (!item) return;
  const [t] = await db.select().from(tasks).where(eq(tasks.id, item.taskId));
  await assertWorkEditable(u, t);
  await db.update(checklistItems).set({ done: !item.done }).where(eq(checklistItems.id, itemId));
  await audit({
    actor: u.email, instrumentId: t?.instrumentId, entityType: "checklist_item", entityId: itemId,
    action: `${item.done ? "unchecked" : "checked off"} '${item.text}'${t ? ` on '${t.title}'` : ""}`,
    field: "done", oldValue: String(item.done), newValue: String(!item.done),
  });
  if (t) revWork(t);
}

export async function deleteChecklistItem(itemId: number) {
  const u = await requireStaff();
  const [item] = await db.select().from(checklistItems).where(eq(checklistItems.id, itemId));
  if (!item) return;
  const [t] = await db.select().from(tasks).where(eq(tasks.id, item.taskId));
  await assertWorkEditable(u, t);
  await db.delete(checklistItems).where(eq(checklistItems.id, itemId)); // item notes cascade
  await audit({
    actor: u.email, instrumentId: t?.instrumentId, entityType: "checklist_item", entityId: itemId,
    action: `removed checklist item '${item.text}'${t ? ` from '${t.title}'` : ""}`,
  });
  if (t) revWork(t);
}

/**
 * Who a task-note @mention may reach: everyone who could open the page the
 * note sits on. The notification quotes the note, so the audience is the
 * task's readership and never wider - same discipline as discussion emails.
 */
async function taskMentionAudience(t: { instrumentId: number | null; assetId: number | null }): Promise<string[]> {
  if (t.instrumentId !== null) {
    return postAudience({
      instrumentId: t.instrumentId, audience: "all", authorOrgId: null, roomOrgId: null,
      tenantOrgId: await tenantOfSystem(t.instrumentId),
    });
  }
  const [a] = t.assetId
    ? await db.select({ ownerOrgId: assets.ownerOrgId, tenantOrgId: assets.tenantOrgId }).from(assets).where(eq(assets.id, t.assetId))
    : [];
  const staff = await houseEmails(a?.tenantOrgId);
  if (!t.assetId) return staff;
  const shares = await db.select({ orgId: assetShares.orgId }).from(assetShares).where(eq(assetShares.assetId, t.assetId));
  const orgIds = [...new Set([...(a?.ownerOrgId !== null && a?.ownerOrgId !== undefined ? [a.ownerOrgId] : []), ...shares.map((s) => s.orgId)])];
  if (!orgIds.length) return staff;
  const entries = await db.select().from(clientAllowlist).where(inArray(clientAllowlist.orgId, orgIds));
  return [...new Set([...staff, ...entries.filter((e) => !e.entry.trim().startsWith("@")).map((e) => e.entry.toLowerCase())])];
}

const noteHref = (t: { instrumentId: number | null; assetId: number | null }) =>
  t.instrumentId !== null ? `/instruments/${t.instrumentId}` : t.assetId ? `/assets/${t.assetId}` : "";

export async function addItemNote(itemId: number, text: string) {
  const u = await requireEditor();
  if (!text.trim()) return;
  const [item] = await db.select().from(checklistItems).where(eq(checklistItems.id, itemId));
  if (!item) return;
  const [t] = await db.select().from(tasks).where(eq(tasks.id, item.taskId));
  await assertWorkEditable(u, t);
  await db.insert(itemNotes).values({ itemId, author: u.name, text: text.trim() });
  await audit({
    actor: u.email, instrumentId: t?.instrumentId, entityType: "item_note", entityId: itemId,
    action: `noted on '${item.text}': "${text.trim()}"`,
  });
  if (t) {
    await notifyMention({
      actorEmail: u.email, actorName: u.name, body: text.trim(),
      where: `'${item.text}'`, href: noteHref(t),
      allowedEmails: await taskMentionAudience(t),
    });
    revWork(t);
  }
}

export async function addTaskNote(taskId: number, text: string) {
  const u = await requireEditor();
  if (!text.trim()) return;
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t) return;
  await assertWorkEditable(u, t);
  await db.insert(taskNotes).values({ taskId, author: u.name, text: text.trim() });
  await audit({
    actor: u.email, instrumentId: t.instrumentId, entityType: "task_note", entityId: taskId,
    action: `commented on '${t.title}': "${text.trim()}"`,
  });
  await notifyMention({
    actorEmail: u.email, actorName: u.name, body: text.trim(),
    where: `task '${t.title}'`, href: noteHref(t),
    allowedEmails: await taskMentionAudience(t),
  });
  revWork(t);
}

export async function updateTaskNote(noteId: number, text: string) {
  const u = await requireEditor();
  const t = text.trim();
  if (!t) throw new Error("Note text required");
  const [n] = await db.select().from(taskNotes).where(eq(taskNotes.id, noteId));
  if (!n || n.text === t) return;
  const [task] = await db.select().from(tasks).where(eq(tasks.id, n.taskId));
  await assertWorkEditable(u, task);
  await db.update(taskNotes).set({ text: t }).where(eq(taskNotes.id, noteId));
  await audit({
    actor: u.email, instrumentId: task?.instrumentId, entityType: "task_note", entityId: noteId,
    action: `edited a note on '${task?.title ?? "?"}'`, field: "text", oldValue: n.text, newValue: t,
  });
  if (task) revWork(task);
}

export async function deleteTaskNote(noteId: number) {
  const u = await requireEditor();
  const [n] = await db.select().from(taskNotes).where(eq(taskNotes.id, noteId));
  if (!n) return;
  const [task] = await db.select().from(tasks).where(eq(tasks.id, n.taskId));
  await assertWorkEditable(u, task);
  await db.delete(taskNotes).where(eq(taskNotes.id, noteId));
  await audit({
    actor: u.email, instrumentId: task?.instrumentId, entityType: "task_note", entityId: noteId,
    action: `deleted a note by ${n.author} on '${task?.title ?? "?"}'`, field: "text", oldValue: n.text,
  });
  if (task) revWork(task);
}

export async function updateItemNote(noteId: number, text: string) {
  const u = await requireEditor();
  const t = text.trim();
  if (!t) throw new Error("Note text required");
  const [n] = await db.select().from(itemNotes).where(eq(itemNotes.id, noteId));
  if (!n || n.text === t) return;
  const [item] = await db.select().from(checklistItems).where(eq(checklistItems.id, n.itemId));
  const [task] = item ? await db.select().from(tasks).where(eq(tasks.id, item.taskId)) : [];
  await assertWorkEditable(u, task);
  await db.update(itemNotes).set({ text: t }).where(eq(itemNotes.id, noteId));
  await audit({
    actor: u.email, instrumentId: task?.instrumentId, entityType: "item_note", entityId: noteId,
    action: `edited a note on '${item?.text ?? "?"}'`, field: "text", oldValue: n.text, newValue: t,
  });
  if (task) revWork(task);
}

export async function deleteItemNote(noteId: number) {
  const u = await requireEditor();
  const [n] = await db.select().from(itemNotes).where(eq(itemNotes.id, noteId));
  if (!n) return;
  const [item] = await db.select().from(checklistItems).where(eq(checklistItems.id, n.itemId));
  const [task] = item ? await db.select().from(tasks).where(eq(tasks.id, item.taskId)) : [];
  await assertWorkEditable(u, task);
  await db.delete(itemNotes).where(eq(itemNotes.id, noteId));
  await audit({
    actor: u.email, instrumentId: task?.instrumentId, entityType: "item_note", entityId: noteId,
    action: `deleted a note by ${n.author} on '${item?.text ?? "?"}'`, field: "text", oldValue: n.text,
  });
  if (task) revWork(task);
}

// ---------------- Parts ----------------

type PartInput = {
  kind: string; assetId?: number | null; name: string; partNumber: string; serial: string; qty: string; specs: string;
  vendor: string; po: string; cost: string;
  carrier: string; tracking: string; orderedAt: string; eta: string; status: string; note: string;
  // The day it actually went in or came out, YYYY-MM-DD. Blank leaves whatever
  // is stored alone rather than clearing it: a service date is a fact about the
  // machine, and an unrelated edit to the note must not quietly erase one.
  installedAt?: string; removedAt?: string;
  // "Removed - request new?": also file a Needed twin so the reorder isn't forgotten.
  requestReplacement?: boolean;
};

/**
 * File the Needed twin of a part that was just pulled: same identity (name,
 * PN, specs, vendor, qty, kind, asset), no serial or order paperwork - those
 * belong to the new unit's own life.
 */
async function fileReplacementRequest(
  removed: { instrumentId: number | null; assetId: number | null; kind: string; name: string; partNumber: string; qty: string; specs: string; vendor: string },
  actorEmail: string,
) {
  const [twin] = await db.insert(parts).values({
    instrumentId: removed.instrumentId, assetId: removed.assetId, kind: removed.kind,
    name: removed.name, partNumber: removed.partNumber, qty: removed.qty,
    specs: removed.specs, vendor: removed.vendor, status: "Needed",
    note: "replacement for removed unit",
    ownerOrgId: await costOwnerOrg(removed),
  }).returning();
  await audit({
    actor: actorEmail, instrumentId: removed.instrumentId, assetId: removed.assetId,
    entityType: "part", entityId: twin.id,
    action: `requested replacement for '${removed.name}'${removed.partNumber ? ` (PN ${removed.partNumber})` : ""} - filed as Needed`,
  });
}

/**
 * Cost and PO follow the system's (or shelf asset's) owning organization -
 * see lib/redact. A caller who can't see them gets them stripped from writes
 * too, or a provider's routine edit would silently wipe values it was shown
 * blank.
 */
async function costOwnerOrg(row: { instrumentId: number | null; assetId?: number | null }): Promise<number | null> {
  if (row.instrumentId !== null) {
    const [i] = await db.select({ ownerOrgId: instruments.ownerOrgId }).from(instruments).where(eq(instruments.id, row.instrumentId));
    return i?.ownerOrgId ?? null;
  }
  if (row.assetId) {
    const [a] = await db.select({ ownerOrgId: assets.ownerOrgId }).from(assets).where(eq(assets.id, row.assetId));
    return a?.ownerOrgId ?? null;
  }
  return null;
}

/**
 * Which tenant a piece of work belongs to - the workspace of the service company
 * whose record it is. Read alongside the cost owner, because the two together are
 * what decide whether a viewer sees a price: their own tenant's, or one they paid
 * for. See lib/redact.
 */
async function tenantOfWork(row: { instrumentId: number | null; assetId?: number | null }): Promise<number | null> {
  if (row.instrumentId !== null) {
    const [i] = await db.select({ tenantOrgId: instruments.tenantOrgId }).from(instruments).where(eq(instruments.id, row.instrumentId));
    return i?.tenantOrgId ?? null;
  }
  if (row.assetId) {
    const [a] = await db.select({ tenantOrgId: assets.tenantOrgId }).from(assets).where(eq(assets.id, row.assetId));
    return a?.tenantOrgId ?? null;
  }
  return null;
}

/** Normalize client-supplied kind/specs so only well-formed values are stored. */
function cleanPartInput(data: PartInput): PartInput {
  return {
    ...data,
    kind: data.kind === "consumable" ? "consumable" : "part",
    qty: data.qty.trim(),
    specs: serializeSpecs(parseSpecs(data.specs)),
  };
}

/**
 * Calendar days, and the reason it matters.
 *
 * This used to stamp "Aug 13" - no year. The parts panel groups finished work by
 * the day it happened and can only do that with a sortable date, so every part
 * anybody ever installed collapsed under "No date recorded" while carrying a
 * stamp that looked perfectly fine on the row. Same format as everything else
 * dated in this app now. The precedence rule lives in lib/partGroups.
 */
const today = () => shopToday();

const partStamps = (
  before: { status: string; receivedAt: string; installedAt: string; removedAt: string },
  status: string,
  given: { installedAt?: string; removedAt?: string } = {},
) => partDates(before, status, given, today());

/**
 * Call a day of service what it was.
 *
 * A visit has no row of its own - it is a calendar day that has finished work on
 * it - so this is the only thing about one that gets stored, and only for the
 * days somebody bothered to name. Blank clears the name and the heading goes
 * back to naming itself after the jobs that closed.
 */
export async function nameServiceVisit(
  target: WorkTarget, day: string, title: string,
): Promise<{ error?: string }> {
  const u = await requireEditor();
  if (!isoDay(day)) return { error: "That is not a day." };
  const t0 = await resolveTarget(target);
  if ("error" in t0) return t0;
  await assertWorkEditable(u, { instrumentId: t0.instrumentId, assetId: t0.assetId });
  const name = title.trim().slice(0, 80);

  const where = and(
    eq(serviceVisits.day, day),
    t0.instrumentId !== null
      ? eq(serviceVisits.instrumentId, t0.instrumentId)
      : eq(serviceVisits.assetId, t0.assetId!),
  );
  const [held] = await db.select().from(serviceVisits).where(where);
  if (!name) {
    if (held) await db.delete(serviceVisits).where(eq(serviceVisits.id, held.id));
  } else if (held) {
    await db.update(serviceVisits).set({ title: name, namedBy: u.name })
      .where(eq(serviceVisits.id, held.id));
  } else {
    await db.insert(serviceVisits).values({
      tenantOrgId: t0.tenantOrgId,
      instrumentId: t0.instrumentId, assetId: t0.instrumentId === null ? t0.assetId : null,
      day, title: name, namedBy: u.name,
    });
  }
  await audit({
    actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId,
    entityType: "visit", entityId: day,
    action: name ? `named the work of ${day} "${name}"` : `cleared the name on the work of ${day}`,
  });
  revWork({ instrumentId: t0.instrumentId, assetId: t0.assetId });
  return {};
}

const partStatusVerb = (status: string) =>
  status === "Installed" ? "installed" : status === "Removed" ? "pulled" : null;

export async function createPart(target: WorkTarget, raw: PartInput): Promise<{ error?: string; flag?: string }> {
  const u = await requireEditor();
  const data = cleanPartInput(raw);
  if (!data.name.trim()) return { error: "Name required" };
  const t0 = await resolveTarget({ instrumentId: target.instrumentId, assetId: raw.assetId ?? target.assetId ?? null });
  if ("error" in t0) return t0;
  const [payer, tenant] = await Promise.all([costOwnerOrg(t0), tenantOfWork(t0)]);
  // Staff of the tenant see prices; a partner from another workspace does not,
  // however senior they are at their own company.
  if (!canSeeCosts(u, payer, tenant)) { data.cost = ""; data.po = ""; }
  const stamps = partStamps({ status: "", receivedAt: "", installedAt: "", removedAt: "" }, data.status,
    { installedAt: raw.installedAt, removedAt: raw.removedAt });
  const taggedAsset = t0.asset;
  const [p] = await db.insert(parts).values({
    ...data, ...stamps, assetId: t0.assetId, name: data.name.trim(), note: data.note.trim(), instrumentId: t0.instrumentId,
    // The summable copy, parsed after the redaction strip so it follows cost.
    costCents: parseMoney(data.cost),
    // Whose money this was. Stamped now so a later handoff can't reveal it to
    // the next owner - see lib/redact.
    ownerOrgId: payer,
  }).returning();
  const verb = partStatusVerb(p.status);
  const noun = p.kind === "consumable" ? "consumable" : "part";
  const pn = p.partNumber ? ` (PN ${p.partNumber})` : "";
  const qty = p.qty ? ` x${p.qty}` : "";
  const note = p.note ? ` - ${p.note}` : "";
  await audit({
    actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId, entityType: "part", entityId: p.id,
    action: (verb
      ? `${verb} ${noun} '${p.name}'${qty}${pn}`
      : `added ${noun} '${p.name}'${qty}${pn} - ${p.status}`) + (taggedAsset ? ` [${assetLabel(taggedAsset)}]` : "") + note,
  });
  revWork(p);
  // Same posture as the visit flag on a work order: warn about the allowance
  // at the moment of commitment, never refuse the record.
  const flag = await partsFlag(payer, t0.instrumentId, p.costCents).catch(() => "");
  return { flag: flag || undefined };
}

export async function updatePart(partId: number, raw: PartInput) {
  const u = await requireEditor();
  const data = cleanPartInput(raw);
  const [before] = await db.select().from(parts).where(eq(parts.id, partId));
  if (!before) return;
  const stamps = partStamps(before, data.status, { installedAt: raw.installedAt, removedAt: raw.removedAt });
  // Only touch the asset tag when the edit actually changed it - re-validating
  // an unchanged tag would silently clear it if the asset has since detached.
  const retagged = (data.assetId ?? null) !== before.assetId;
  const taggedAsset = retagged ? await validAssetTag(data.assetId, before.instrumentId) : null;
  const assetId = retagged ? taggedAsset?.id ?? null : before.assetId;
  await assertWorkEditable(u, before);
  // An editor who can't see costs must not overwrite them blind.
  if (!canSeeCosts(u, await costOwnerOrg(before), await tenantOfWork(before))) {
    data.cost = before.cost; data.po = before.po;
  }
  await db.update(parts).set({
    ...data, ...stamps, assetId, name: data.name.trim(), note: data.note.trim(),
    costCents: parseMoney(data.cost),
  }).where(eq(parts.id, partId));
  const verb = partStatusVerb(data.status);
  const action = before.status !== data.status
    ? verb
      ? `${verb} part '${data.name}'${data.note.trim() ? ` - ${data.note.trim()}` : ""}`
      : `part '${data.name}' status: ${before.status} -> ${data.status}`
    : `edited part '${data.name}'`;
  await audit({
    actor: u.email, instrumentId: before.instrumentId, assetId: before.assetId, entityType: "part", entityId: partId,
    action, field: before.status !== data.status ? "status" : "", oldValue: before.status, newValue: data.status,
  });
  if (retagged) {
    await audit({
      actor: u.email, instrumentId: before.instrumentId, assetId: before.assetId, entityType: "part", entityId: partId,
      action: taggedAsset ? `tagged part '${data.name.trim()}' to ${assetLabel(taggedAsset)}` : `untagged part '${data.name.trim()}' (whole system)`,
    });
  }
  if (data.requestReplacement && data.status === "Removed") {
    await fileReplacementRequest({
      instrumentId: before.instrumentId, assetId, kind: data.kind, name: data.name.trim(),
      partNumber: data.partNumber, qty: data.qty, specs: data.specs, vendor: data.vendor,
    }, u.email);
  }
  revWork(before);
}

export async function setPartAsset(partId: number, assetId: number | null) {
  const u = await requireEditor();
  const [p] = await db.select().from(parts).where(eq(parts.id, partId));
  if (!p) return;
  const tagged = await validAssetTag(assetId, p.instrumentId);
  const next = tagged?.id ?? null;
  if (p.assetId === next) return;
  await assertWorkEditable(u, p);
  await db.update(parts).set({ assetId: next }).where(eq(parts.id, partId));
  await audit({
    actor: u.email, instrumentId: p.instrumentId, assetId: p.assetId, entityType: "part", entityId: partId,
    action: tagged ? `tagged part '${p.name}' to ${assetLabel(tagged)}` : `untagged part '${p.name}' (whole system)`,
  });
  revWork(p);
}

export async function setPartStatus(partId: number, status: string) {
  const u = await requireEditor();
  const [p] = await db.select().from(parts).where(eq(parts.id, partId));
  if (!p || p.status === status) return;
  const stamps = partStamps(p, status);
  await assertWorkEditable(u, p);
  await db.update(parts).set({ status, ...stamps }).where(eq(parts.id, partId));
  const verb = partStatusVerb(status);
  await audit({
    actor: u.email, instrumentId: p.instrumentId, assetId: p.assetId, entityType: "part", entityId: partId,
    action: verb ? `${verb} part '${p.name}'` : `part '${p.name}' status: ${p.status} -> ${status}`,
    field: "status", oldValue: p.status, newValue: status,
  });
  revWork(p);
}

export async function deletePart(partId: number, reason: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [p] = await db.select().from(parts).where(eq(parts.id, partId));
  if (!p) return {};
  await assertWorkEditable(u, p);
  await db.delete(parts).where(eq(parts.id, partId));
  await audit({
    actor: u.email, instrumentId: p.instrumentId, assetId: p.assetId, entityType: "part", entityId: partId,
    action: `deleted part record '${p.name}' - reason: ${why}`, field: "reason", newValue: why,
  });
  revWork(p);
  return {};
}

// ---------------- Attachments ----------------

export async function recordAttachment(target: WorkTarget, data: { fileName: string; kind: string; url: string; size: number; description?: string }) {
  await recordAttachments(target, [{ ...data, description: data.description ?? "" }]);
}

/** Batch variant: one insert + one audit entry per file, single revalidation. */
export async function recordAttachments(
  target: WorkTarget,
  files: { fileName: string; kind: string; url: string; size: number; description: string }[],
): Promise<{ error?: string }> {
  const u = await requireEditor();
  if (!files.length) return {};
  // Files may land on a settled order - the signed report that comes back
  // weeks after the job was filed. Hours, parts and tasks may not.
  const t0 = await resolveTarget(target, { lateFiles: true });
  if ("error" in t0) return t0;
  // Charged to whoever OWNS the record, not to whoever pressed upload: a tune
  // report on a client's system is the client's paperwork, and the shop filing
  // it on their behalf shouldn't pay for their storage.
  const guard = await guardStorage(await storeOwnerForTarget(t0), files.reduce((n, f) => n + (f.size || 0), 0));
  if (guard) return guard;
  const rows = await db.insert(attachments)
    .values(files.map((f) => ({
      ...f, description: f.description.trim(), tenantOrgId: t0.tenantOrgId,
      instrumentId: t0.instrumentId, assetId: t0.instrumentId === null ? t0.assetId : null,
      uploadedBy: u.name, workOrderId: t0.workOrderId,
    })))
    .returning();
  // Said in the record, not hidden in a timestamp: a file added to a FILED
  // job is fine exactly because it is visible as one.
  const late = t0.settledWo ? ` onto ${t0.settledWo.number} (${lateNote(t0.settledWo)})` : "";
  for (const a of rows) {
    await audit({
      actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId, entityType: "attachment", entityId: a.id,
      action: `uploaded ${a.kind}: ${a.fileName}${a.description ? ` - ${a.description}` : ""}${late}`,
    });
  }
  revWork({ instrumentId: t0.instrumentId, assetId: t0.assetId });
  return {};
}


/**
 * Add photos to a system or a unit.
 *
 * A photo is an ordinary attachment - one file, one row, counted against a quota
 * once and served through the same authorized proxy as every other file. What
 * makes it a photo is that a browser can show it (lib/photos), and what makes one
 * of them the COVER is a pointer on the record, so choosing a different cover
 * moves a pointer rather than moving files around.
 *
 * The first photo a record ever gets becomes its cover: a record with pictures
 * and no cover would show nothing, which is never what somebody uploading a
 * photo meant.
 */
export async function addPhotos(
  target: WorkTarget, files: { fileName: string; url: string; size: number }[],
): Promise<{ error?: string }> {
  const u = await requireEditor();
  if (!files.length) return {};
  const t0 = await resolveTarget(target);
  if ("error" in t0) return t0;
  const onSystem = t0.instrumentId !== null && t0.assetId === null;
  const guard = await guardStorage(await storeOwnerForTarget(t0), files.reduce((n, f) => n + (f.size || 0), 0));
  if (guard) return guard;

  const rows = await db.insert(attachments).values(files.map((f) => ({
    tenantOrgId: t0.tenantOrgId,
    instrumentId: t0.instrumentId, assetId: t0.instrumentId === null ? t0.assetId : null,
    fileName: f.fileName.slice(0, 200), kind: "Photo", url: f.url, size: f.size,
    uploadedBy: u.name, description: onSystem ? "System photo" : "Module photo",
  }))).returning();

  // The first photo a record ever gets becomes its cover - but a record sharing
  // its photos with a unit that already has one is not empty, and should not
  // quietly take the picture over.
  const twin = await photoTwin(t0);
  const held = sharedCover(await coverOf(t0), twin ? await coverOf(twin) : null);
  if (held === null) await setCoverRow(onSystem, t0, rows[0].id);
  if (twin) revWork(twin);
  await audit({
    actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId,
    entityType: "attachment", entityId: rows[0].id,
    action: `added ${rows.length} ${onSystem ? "system" : "module"} photo${rows.length === 1 ? "" : "s"}`,
  });
  revWork({ instrumentId: t0.instrumentId, assetId: t0.assetId });
  return {};
}

async function setCoverRow(
  onSystem: boolean, t0: { instrumentId: number | null; assetId: number | null }, id: number | null,
) {
  if (onSystem) {
    await db.update(instruments).set({ photoAttachmentId: id }).where(eq(instruments.id, t0.instrumentId!));
  } else {
    await db.update(assets).set({ photoAttachmentId: id }).where(eq(assets.id, t0.assetId!));
  }
}

/**
 * The other half of a one-box pair, or null.
 *
 * A unit tracked as a system of its own is two records describing one machine
 * (see lib/photos), and photographing it twice - once per page - is work nobody
 * should have to do. So a system with exactly one unit, and that unit, pool
 * their photos. Structural rather than a flag: attach a second module and the
 * system becomes a bench, whose photo is the bench and not one module of it.
 */
/** Which of a record's photos leads. The rest stay exactly where they are. */
export async function setCoverPhoto(target: WorkTarget, attachmentId: number): Promise<{ error?: string }> {
  const u = await requireEditor();
  const t0 = await resolveTarget(target);
  if ("error" in t0) return t0;
  // Only a photo already on this record, or on the unit/system it shares its
  // photos with: a cover is a pointer, and a pointer at somebody else's file
  // would be a way to read it.
  const [photo] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  if (!photo) return { error: "Not found" };
  const me = photoRecord(t0);
  const twin = await photoTwin(t0);
  const onRecord = (r: PhotoRecord) =>
    r.instrumentId !== null ? photo.instrumentId === r.instrumentId : photo.assetId === r.assetId;
  const holder = onRecord(me) ? me : twin && onRecord(twin) ? twin : null;
  if (!holder) return { error: "Not found" };

  // Stamped on whichever record the file is actually filed under, and cleared on
  // the other, so a shared pair has one cover rather than two that disagree.
  await setCoverRow(holder.instrumentId !== null, holder, attachmentId);
  const other = twin && (holder === me ? twin : me);
  if (other) await setCoverRow(other.instrumentId !== null, other, null);
  await audit({
    actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId,
    entityType: "attachment", entityId: attachmentId,
    action: `made '${photo.fileName}' the cover photo`,
  });
  revWork({ instrumentId: t0.instrumentId, assetId: t0.assetId });
  if (twin) revWork(twin);
  return {};
}

/**
 * Remove several photos at once, as one act.
 *
 * The reason this exists rather than looping deleteAttachment: fifteen setup
 * shots removed one at a time wrote fifteen lines into a history that is meant
 * to say what happened to the machine, and made a five-second job into fifteen
 * confirmations. One selection, one reason, one line.
 *
 * Same gate as deleting any file off a record - staff only, and only on a record
 * they may edit. Ids that are not photos, or belong to another record, are
 * dropped rather than refused: a stale page in another tab should take the rows
 * it can and say what it took.
 */
export async function removePhotos(
  target: WorkTarget, ids: number[], reason: string,
): Promise<{ removed?: number; error?: string }> {
  const u = await requireEditor();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  if (!ids.length) return { removed: 0 };
  const t0 = await resolveTarget(target);
  if ("error" in t0) return t0;
  if (!isHouse(u.role)) return { error: "Staff only" };
  await assertWorkEditable(u, { instrumentId: t0.instrumentId, assetId: t0.assetId });

  const me = photoRecord(t0);
  const twin = await photoTwin(t0);
  const onRecord = (a: { instrumentId: number | null; assetId: number | null }, r: PhotoRecord) =>
    (r.instrumentId !== null ? a.instrumentId === r.instrumentId : a.assetId === r.assetId);
  const rows = (await db.select().from(attachments).where(inArray(attachments.id, ids.slice(0, 200))))
    .filter((a) => isPhotoFile(a) && (onRecord(a, me) || (twin !== null && onRecord(a, twin))));
  if (!rows.length) return { error: "Nothing there to remove." };

  await db.delete(attachments).where(inArray(attachments.id, rows.map((a) => a.id)));
  await deleteBlobs(rows.map((a) => a.url));
  // A cover that was in the set leaves a pointer at a file that no longer
  // exists. Cleared on both halves of a shared pair, since either may hold it.
  const gone = new Set(rows.map((a) => a.id));
  for (const r of [me, ...(twin ? [twin] : [])]) {
    const held = await coverOf(r);
    if (held !== null && gone.has(held)) await setCoverRow(r.instrumentId !== null, r, null);
  }
  await audit({
    actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId,
    entityType: "attachment", entityId: rows[0].id,
    action: photoRemovalNote(rows.map((a) => a.fileName), why),
    field: "reason", newValue: why,
  });
  revWork({ instrumentId: t0.instrumentId, assetId: t0.assetId });
  if (twin) revWork(twin);
  return { removed: rows.length };
}

/**
 * How a photo sits in its tile - turned upright, zoomed, nudged.
 *
 * The stored file is not touched. Every place that shows this photo reads the
 * same numbers, so framing it once frames it everywhere, and re-framing later
 * costs nothing and loses nothing.
 */
export async function setPhotoFraming(attachmentId: number, framing: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [photo] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  if (!photo) return { error: "Not found" };
  await assertWorkEditable(u, photo.instrumentId === null && photo.assetId === null
    ? { instrumentId: null, assetId: null }
    : photo);
  // Round-tripped through the parser, so nothing unparseable or out of range is
  // ever stored - whatever a client sends.
  await db.update(attachments)
    .set({ framing: serializeFrame(parseFrame(framing)) })
    .where(eq(attachments.id, attachmentId));
  revWork(photo);
  revalidatePath("/gallery");
  return {};
}

/**
 * File something in the caller's document library - storage that belongs to no
 * system or unit. Every organization has one: blank templates, SOPs, assembled
 * packets awaiting a destination. The shelf is private to its organization on
 * both write and read (see lib/fileAccess), so nothing a client files can be
 * seen by another client, and the house shelf stays the house's.
 */
/**
 * Which store this person may file into, or an error.
 *
 * A folder belongs to one organization's store, exactly as a loose file does.
 * The house may work in any store it administers; everybody else works in
 * their own and nowhere else.
 */
async function folderStoreGate(u: Awaited<ReturnType<typeof requireEditor>>, orgId: number | null) {
  if (orgId === null) {
    // The operator's own store. House staff only.
    return isStaffRole(u.role) ? {} : { error: "Not found" };
  }
  if (u.orgId === orgId) return {};
  if (!isStaffRole(u.role)) return { error: "Not found" };
  const gate = await adminOrgGate(u, orgId);
  return "error" in gate ? gate : {};
}

/** Every folder in one store, for the rules in lib/folders to reason over. */
async function storeFolders(orgId: number | null) {
  return db.select().from(folders)
    .where(orgId === null ? isNull(folders.orgId) : eq(folders.orgId, orgId))
    .catch(() => []);
}

export async function createFolder(
  orgId: number | null, parentId: number | null, name: string,
): Promise<{ error?: string; id?: number }> {
  const u = await requireEditor();
  const gate = await folderStoreGate(u, orgId);
  if ("error" in gate) return gate;
  const clean = cleanFolderName(name);
  if ("error" in clean) return clean;
  const all = await storeFolders(orgId);
  if (parentId !== null && !all.some((f) => f.id === parentId)) return { error: "That folder is gone" };
  if (depthOf(all, parentId) >= MAX_DEPTH) return { error: `Folders only nest ${MAX_DEPTH} deep` };
  if (nameTaken(all, parentId, clean.name)) return { error: `There is already a "${clean.name}" here` };
  const [row] = await db.insert(folders).values({
    orgId, parentId, name: clean.name,
    // The workspace this store belongs to: the owning org's, or ours when the
    // store is the operator's own.
    tenantOrgId: orgId === null
      ? myTenantOrgId(u)
      : orgTenant((await db.select().from(orgs).where(eq(orgs.id, orgId)))[0]) ?? myTenantOrgId(u),
    createdBy: u.email,
  }).returning();
  await audit({
    actor: u.email, entityType: "folder", entityId: row.id,
    action: `made the folder "${clean.name}"`,
  });
  revalidatePath("/documents");
  return { id: row.id };
}

export async function renameFolder(id: number, name: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [row] = await db.select().from(folders).where(eq(folders.id, id));
  if (!row) return { error: "Not found" };
  const gate = await folderStoreGate(u, row.orgId);
  if ("error" in gate) return gate;
  const clean = cleanFolderName(name);
  if ("error" in clean) return clean;
  const all = await storeFolders(row.orgId);
  if (nameTaken(all, row.parentId, clean.name, id)) return { error: `There is already a "${clean.name}" here` };
  if (clean.name === row.name) return {};
  await db.update(folders).set({ name: clean.name }).where(eq(folders.id, id));
  await audit({
    actor: u.email, entityType: "folder", entityId: id,
    action: `renamed the folder "${row.name}" to "${clean.name}"`,
    field: "name", oldValue: row.name, newValue: clean.name,
  });
  revalidatePath("/documents");
  return {};
}

export async function moveFolder(id: number, intoId: number | null): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [row] = await db.select().from(folders).where(eq(folders.id, id));
  if (!row) return { error: "Not found" };
  const gate = await folderStoreGate(u, row.orgId);
  if ("error" in gate) return gate;
  if (row.parentId === intoId) return {};
  const all = await storeFolders(row.orgId);
  const ok = canMoveFolder(all, id, intoId);
  if (!ok.ok) return { error: ok.error };
  if (nameTaken(all, intoId, row.name, id)) return { error: `There is already a "${row.name}" there` };
  await db.update(folders).set({ parentId: intoId }).where(eq(folders.id, id));
  await audit({
    actor: u.email, entityType: "folder", entityId: id,
    action: `moved the folder "${row.name}" to ${intoId === null ? "the top level" : `"${all.find((f) => f.id === intoId)?.name ?? "another folder"}"`}`,
  });
  revalidatePath("/documents");
  return {};
}

/**
 * Delete an EMPTY folder.
 *
 * Non-empty is refused with the counts rather than cascaded: "delete folder"
 * and "delete forty files" are different acts, and one confirmation should
 * never be able to mean the second when somebody meant the first.
 */
export async function deleteFolder(id: number): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [row] = await db.select().from(folders).where(eq(folders.id, id));
  if (!row) return { error: "Not found" };
  const gate = await folderStoreGate(u, row.orgId);
  if ("error" in gate) return gate;
  const all = await storeFolders(row.orgId);
  const inside = [id, ...descendantIds(all, id)];
  const held = await db.select({ id: attachments.id }).from(attachments)
    .where(inArray(attachments.folderId, inside)).catch(() => []);
  const kids = descendantIds(all, id).length;
  if (kids || held.length) {
    const bits = [
      kids ? `${kids} folder${kids === 1 ? "" : "s"}` : "",
      held.length ? `${held.length} file${held.length === 1 ? "" : "s"}` : "",
    ].filter(Boolean).join(" and ");
    return { error: `"${row.name}" still holds ${bits} - empty it first` };
  }
  await db.delete(folders).where(eq(folders.id, id));
  await audit({
    actor: u.email, entityType: "folder", entityId: id,
    action: `deleted the empty folder "${row.name}"`,
  });
  revalidatePath("/documents");
  return {};
}

/**
 * Put files in a folder, or back at the root.
 *
 * Only LOOSE files move. A file that belongs to a system is already filed
 * where it should be, and the ids of ones that aren't loose are skipped rather
 * than refused - a selection spanning both is an ordinary thing to have, and
 * failing the whole move over it would be unhelpful.
 */
export async function moveFilesToFolder(
  attachmentIds: number[], folderId: number | null,
): Promise<{ error?: string; moved?: number }> {
  const u = await requireEditor();
  if (!attachmentIds.length) return { moved: 0 };
  const rows = await db.select().from(attachments).where(inArray(attachments.id, attachmentIds));
  const loose = rows.filter((r) => r.instrumentId === null && r.assetId === null);
  if (!loose.length) return { error: "Those files belong to records - they are already filed" };
  // One store per move. Files from two stores in one call would need two gates
  // and would mean somebody's selection spanned stores, which the page cannot
  // produce.
  const store = loose[0].orgId ?? null;
  if (loose.some((r) => (r.orgId ?? null) !== store)) return { error: "Those files are in different stores" };
  const gate = await folderStoreGate(u, store);
  if ("error" in gate) return gate;
  let dest: typeof folders.$inferSelect | undefined;
  if (folderId !== null) {
    [dest] = await db.select().from(folders).where(eq(folders.id, folderId));
    if (!dest || (dest.orgId ?? null) !== store) return { error: "That folder is not in this store" };
  }
  await db.update(attachments).set({ folderId })
    .where(inArray(attachments.id, loose.map((r) => r.id)));
  await audit({
    actor: u.email, entityType: "folder", entityId: folderId ?? 0,
    action: `moved ${loose.length} file${loose.length === 1 ? "" : "s"} to ${dest ? `"${dest.name}"` : "the top level"}`,
  });
  revalidatePath("/documents");
  return { moved: loose.length };
}

/**
 * A drop link: a URL that lets somebody WITHOUT a login send files into this
 * store - the technician at an air-gapped instrument who has the data on a
 * stick and no account here. The token is the credential, so it expires (90
 * days at most) and dies on demand; the public half lives in /drop/[token]
 * and the API routes beside it.
 */
export async function createDropLink(
  orgId: number | null, folderId: number | null, data: { label: string; expiresOn: string },
): Promise<{ error?: string; token?: string }> {
  const u = await requireEditor();
  const gate = await folderStoreGate(u, orgId);
  if ("error" in gate) return gate;
  const expiry = cleanExpiry(data.expiresOn, shopToday());
  if ("error" in expiry) return expiry;
  if (folderId !== null) {
    const all = await storeFolders(orgId);
    if (!all.some((f) => f.id === folderId)) return { error: "That folder is gone" };
  }
  const token = crypto.randomBytes(18).toString("base64url");
  const [row] = await db.insert(dropLinks).values({
    orgId, folderId, token, label: cleanLabel(data.label), expiresOn: expiry.expiresOn,
    tenantOrgId: myTenantOrgId(u), createdBy: u.email,
  }).returning();
  await audit({
    actor: u.email, entityType: "drop_link", entityId: row.id,
    action: `made a drop link${row.label ? ` "${row.label}"` : ""} (to ${expiry.expiresOn})`,
  });
  revalidatePath("/documents");
  return { token };
}

export async function revokeDropLink(id: number): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [row] = await db.select().from(dropLinks).where(eq(dropLinks.id, id));
  if (!row) return { error: "Not found" };
  const gate = await folderStoreGate(u, row.orgId);
  if ("error" in gate) return gate;
  if (row.revokedAt !== null) return {};
  await db.update(dropLinks).set({ revokedAt: new Date() }).where(eq(dropLinks.id, id));
  await audit({
    actor: u.email, entityType: "drop_link", entityId: id,
    action: `revoked the drop link${row.label ? ` "${row.label}"` : ""}`,
  });
  revalidatePath("/documents");
  return {};
}

/**
 * A share link: named files, readable by whoever holds the URL. The outbound
 * twin of a drop link, and the answer to "email it to them" for somebody with
 * no account - the same job the client's Mimecast was doing, pointed the
 * other way.
 *
 * The file set is named AT CREATION, from what this person can read at this
 * moment, and never grows. mayReadAttachment is the same gate /api/files
 * runs, so a share can never carry a byte its maker could not have downloaded
 * themselves.
 */
export async function createShareLink(
  attachmentIds: number[], data: { label: string; expiresOn: string },
): Promise<{ error?: string; token?: string }> {
  const u = await requireUser();
  if (u.role === "client_viewer") return { error: "Not allowed" };
  const ids = [...new Set(attachmentIds.filter((n) => Number.isInteger(n)))].slice(0, 100);
  if (!ids.length) return { error: "Pick at least one file" };
  const expiry = cleanExpiry(data.expiresOn, shopToday());
  if ("error" in expiry) return expiry;
  const rows = await db.select().from(attachments).where(inArray(attachments.id, ids));
  if (rows.length !== ids.length) return { error: "A file in the selection is gone" };
  for (const r of rows) {
    if (!(await mayReadAttachment(r))) return { error: "A file in the selection isn't yours to share" };
  }
  const token = crypto.randomBytes(18).toString("base64url");
  const [link] = await db.insert(shareLinks).values({
    token, label: cleanLabel(data.label), expiresOn: expiry.expiresOn,
    tenantOrgId: myTenantOrgId(u), createdBy: u.email,
  }).returning();
  await db.insert(shareLinkFiles).values(ids.map((attachmentId) => ({ shareId: link.id, attachmentId })));
  await audit({
    actor: u.email, entityType: "share_link", entityId: link.id,
    action: `shared ${ids.length} file${ids.length === 1 ? "" : "s"} by link${link.label ? ` "${link.label}"` : ""} (to ${expiry.expiresOn})`,
  });
  revalidatePath("/documents");
  return { token };
}

export async function revokeShareLink(id: number): Promise<{ error?: string }> {
  const u = await requireUser();
  const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, id));
  if (!row) return { error: "Not found" };
  // Yours to kill if you made it, or if you're staff of its workspace - the
  // person who notices a leaked URL is not always the person who minted it.
  if (row.createdBy !== u.email && !(isStaffRole(u.role) && (readTenant(u) === null || row.tenantOrgId === readTenant(u)))) {
    return { error: "Not found" };
  }
  if (row.revokedAt !== null) return {};
  await db.update(shareLinks).set({ revokedAt: new Date() }).where(eq(shareLinks.id, id));
  await audit({
    actor: u.email, entityType: "share_link", entityId: id,
    action: `revoked the share link${row.label ? ` "${row.label}"` : ""}`,
  });
  revalidatePath("/documents");
  return {};
}

export async function recordLibraryFiles(
  files: { fileName: string; url: string; size: number; description: string }[],
  /** The folder that was open when they were dropped. Null = the top level. */
  folderId: number | null = null,
): Promise<{ error?: string }> {
  // Every organization has a shelf of its own, so this is no longer house-only.
  // An org's files land on its shelf; the house's land on the operator's.
  const u = await requireEditor();
  if (!files.length) return {};
  const guard = await guardStorage(u.orgId, files.reduce((n, f) => n + (f.size || 0), 0));
  if (guard) return guard;
  // Dropped into an open folder, they belong in it. Checked rather than
  // trusted: the id comes from a URL, and a folder in somebody else's store
  // would file this person's upload somewhere they cannot see it.
  let dest: number | null = null;
  if (folderId !== null) {
    const [f] = await db.select().from(folders).where(eq(folders.id, folderId));
    if (f && (f.orgId ?? null) === (u.orgId ?? null)) dest = f.id;
  }
  const rows = await db.insert(attachments)
    .values(files.map((f) => ({
      ...f, description: f.description.trim(), kind: "Report", tenantOrgId: myTenantOrgId(u),
      instrumentId: null, assetId: null, orgId: u.orgId, folderId: dest, uploadedBy: u.name,
    })))
    .returning();
  for (const a of rows) {
    await audit({
      actor: u.email, entityType: "attachment", entityId: a.id,
      action: `filed ${a.fileName} in the document library`,
    });
  }
  revalidatePath("/documents");
  return {};
}

export async function updateAttachment(
  attachmentId: number, data: { fileName: string; kind: string; description: string; expiresOn?: string },
): Promise<{ error?: string }> {
  const u = await requireEditor();
  const fileName = data.fileName.trim().slice(0, 200);
  // Returned rather than thrown: the only caller used to swallow the throw, so
  // an empty name looked like a save that silently did nothing.
  if (!fileName) return { error: "Give the file a name" };
  const kind = (ATTACH_KINDS as readonly string[]).includes(data.kind) ? data.kind : "Other";
  const description = data.description.trim();
  const [a] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  if (!a) return { error: "Not found" };
  // A validity date only sticks when it IS a date - a typo'd expiry that can
  // never fire is worse than none, because somebody believes it is being watched.
  const expiresOn = data.expiresOn !== undefined && isIsoDay(data.expiresOn) ? data.expiresOn : (data.expiresOn === "" ? "" : a.expiresOn);
  if (a.fileName === fileName && a.kind === kind && a.description === description && a.expiresOn === expiresOn) return {};
  await assertWorkEditable(u, a);
  await db.update(attachments).set({ fileName, kind, description, expiresOn }).where(eq(attachments.id, attachmentId));
  const changes: string[] = [];
  if (a.fileName !== fileName) changes.push(`renamed to '${fileName}'`);
  if (a.kind !== kind) changes.push(`${a.kind} -> ${kind}`);
  if (a.description !== description) changes.push("description updated");
  if (a.expiresOn !== expiresOn) changes.push(expiresOn ? `expires ${expiresOn}` : "expiry cleared");
  await audit({
    actor: u.email, instrumentId: a.instrumentId, assetId: a.assetId, entityType: "attachment", entityId: attachmentId,
    action: `edited attachment '${a.fileName}': ${changes.join(", ")}`,
    field: "description", oldValue: a.description, newValue: description,
  });
  revWork(a);
  // A loose file lives on the Files page and nowhere else, so revWork - which
  // only knows about records - would leave a rename invisible until a reload.
  revalidatePath("/documents");
  return {};
}

/**
 * Best-effort blob removal - never lets a storage hiccup block the record
 * delete. Call AFTER the rows are gone: a URL still referenced by a surviving
 * attachment row is kept, because filing one library document onto three assets
 * makes three rows over one stored file, and deleting any one of them must not
 * blank the other two.
 */
async function deleteBlobs(urls: string[]) {
  if (!urls.length) return;
  const unique = [...new Set(urls)];
  // Two tables can point at one blob: attachments, and a catalog row holding a
  // stock photo. Both count as "still used", or clearing a model's photo would
  // delete the bytes out from under a file that happens to share the URL.
  const stillUsed = new Set([
    ...(await db.select({ url: attachments.url }).from(attachments).where(inArray(attachments.url, unique)))
      .map((r) => r.url),
    ...(await db.select({ url: vocabTerms.photoUrl }).from(vocabTerms).where(inArray(vocabTerms.photoUrl, unique)))
      .map((r) => r.url),
    ...(await db.select({ url: partPhotos.url }).from(partPhotos).where(inArray(partPhotos.url, unique)))
      .map((r) => r.url),
  ]);
  const orphans = unique.filter((u) => !stillUsed.has(u));
  if (!orphans.length) return;
  try {
    const { del } = await import("@vercel/blob");
    await del(orphans);
  } catch (e) {
    console.error("[blob] delete failed (orphaned file, harmless but billed):", (e as Error).message);
  }
}

// ---------------- Outside file stores (OneDrive / SharePoint) ----------------

/**
 * Whose account is connected, if any.
 *
 * Per person, never per organization: the connection reaches whatever that
 * individual can reach in their own company, so handing it to a colleague would
 * quietly hand over their document library too.
 */
export async function myCloudConnection(): Promise<{
  configured: boolean; account: string; brokenReason: string; setupProblem: string;
}> {
  const u = await requireUser();
  const isHouse = u.role === "owner" || u.role === "staff";
  // Half-configured is the state worth naming. The feature used to vanish
  // entirely, which is indistinguishable from a bug to whoever just set the
  // environment variables - so staff get told exactly what is missing.
  const problem = graphSetupProblem()
    || (vaultConfigured() ? "" : VAULT_UNCONFIGURED);
  if (problem) {
    return { configured: false, account: "", brokenReason: "", setupProblem: isHouse ? problem : "" };
  }
  const c = await connectionView(u.email);
  return {
    configured: true,
    account: c ? (c.accountEmail || c.accountName) : "",
    brokenReason: c?.brokenReason ?? "",
    setupProblem: "",
  };
}

export async function disconnectCloud(): Promise<{ error?: string }> {
  const u = await requireUser();
  await removeConnection(u.email);
  await audit({
    actor: u.email, entityType: "cloud", entityId: 0,
    action: "disconnected their Microsoft account",
  });
  revalidatePath("/pdf");
  return {};
}

/**
 * One folder's contents, or the results of a search.
 *
 * Reads only. Nothing here is written down: browsing somebody's OneDrive should
 * leave no trace of their folder names in this database, which is a different
 * posture from the rest of the app and the right one for files that are not ours.
 */
export async function browseCloud(
  driveId: string, itemId: string, query = "", pdfOnly = true,
): Promise<{ items?: CloudItem[]; error?: string }> {
  const u = await requireUser();
  if (u.role === "client_viewer") return { error: "Read-only accounts cannot connect an outside account." };
  const q = query.trim();
  const out = await withGraph(u.email, (token) => {
    // The top of the trail is a list of STORES - the person's own OneDrive, what
    // others shared with them, and the SharePoint library behind each of their
    // Teams. There is no folder to list at that level, so a query there has
    // nothing to search either: pick a store first.
    if (driveId === PLACES_DRIVE) return listPlaces(token);
    return q ? searchFiles(token, q, driveId, pdfOnly) : listFolder(token, driveId, itemId, pdfOnly);
  });
  return out.error ? { error: out.error } : { items: out.items ?? [] };
}

/**
 * Somewhere to put a finished packet.
 *
 * Returns a pre-authorized upload URL and the browser sends the bytes straight
 * to Microsoft. Routing a scanned packet through a serverless function to hand
 * it on unchanged would cost memory, time and a request-body ceiling smaller
 * than the packets people actually assemble.
 */
export async function startCloudUpload(
  driveId: string, folderId: string, fileName: string,
): Promise<{ uploadUrl?: string; name?: string; error?: string }> {
  const u = await requireEditor();
  const out = await withGraph(u.email, (token) => createUploadSession(token, driveId, folderId, fileName));
  if (out.error) return { error: out.error };
  await audit({
    actor: u.email, entityType: "cloud", entityId: 0,
    action: `saved "${out.name ?? fileName}" to their OneDrive`,
  });
  return { uploadUrl: out.uploadUrl, name: out.name };
}

/**
 * File an existing library document onto a system or unit. The library keeps
 * its copy: this is a second reference to one stored file, not a duplicate
 * upload, so the same calibration certificate can sit on every unit it covers
 * without paying for storage five times. deleteBlobs refcounts accordingly.
 *
 * Your own shelf only. A client can file its own SOP onto a system it works,
 * and the house can file the shop's; neither reaches into the other's library.
 */
export async function attachLibraryFile(target: WorkTarget, attachmentId: number): Promise<{ error?: string }> {
  const u = await requireEditor();
  // Same late-files door as a direct upload: filing the library's copy of the
  // signed report onto a closed job is the same archival act.
  const t = await resolveTarget(target, { lateFiles: true });
  if ("error" in t) return t;
  const [src] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  // Must actually be a library file, and one of yours. Re-filing another
  // record's attachment would move evidence between systems by a different
  // name; reaching into another org's shelf would be a leak.
  if (!src || src.instrumentId !== null || src.assetId !== null) return { error: "Not a library file" };
  if ((src.orgId ?? null) !== u.orgId) return { error: "Not found" };
  const already = await db.select({ id: attachments.id }).from(attachments)
    .where(and(
      eq(attachments.url, src.url),
      t.instrumentId !== null ? eq(attachments.instrumentId, t.instrumentId) : eq(attachments.assetId, t.assetId!),
    ));
  if (already.length) return { error: `${src.fileName} is already on this record` };
  const [row] = await db.insert(attachments).values({
    tenantOrgId: t.tenantOrgId,
    instrumentId: t.instrumentId, assetId: t.assetId,
    fileName: src.fileName, kind: src.kind, description: src.description,
    url: src.url, size: src.size, uploadedBy: u.name,
    // The job, when this was filed from a work order's page. Without it the
    // file landed on the system and never appeared on the order that filed it
    // - the page lists by this column.
    workOrderId: t.workOrderId,
  }).returning();
  await audit({
    actor: u.email, instrumentId: t.instrumentId, assetId: t.assetId,
    entityType: "attachment", entityId: row.id,
    action: `filed ${src.fileName} from the document library onto ${t.externalId || "this unit"}`
      + (t.settledWo ? ` (${t.settledWo.number} ${lateNote(t.settledWo)})` : ""),
  });
  revWork(row);
  return {};
}

/**
 * The caller's own library, for the picker on a record's Files panel. An action
 * rather than a page prop so a record page doesn't query the whole library on
 * every load just in case somebody opens the picker.
 */
/**
 * File the signed agreement against the agreement.
 *
 * attachments.agreementId has been in the schema since agreements were - and
 * nothing ever wrote it, so the terms lived in this app while the contract
 * everybody actually signs lived in somebody's mail. The file may come from the
 * library, the same way a manual is filed onto a catalog entry - or straight
 * off the desk, which is what uploadAgreementPapers below is for.
 */
export async function fileAgreementPaper(agreementId: number, attachmentId: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [a] = await db.select().from(agreements).where(eq(agreements.id, agreementId));
  if (!a) return { error: "Not found" };
  const gate = await adminOrgGate(u, a.orgId);
  if ("error" in gate) return gate;
  const [src] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  // Library files only - re-pointing a system's evidence at a contract would
  // move a report out of the record it proves.
  if (!src || src.instrumentId !== null || src.assetId !== null) return { error: "Not a library file" };
  if ((src.orgId ?? null) !== u.orgId) return { error: "Not found" };
  if (src.agreementId === agreementId) return {};
  await db.update(attachments).set({ agreementId }).where(eq(attachments.id, attachmentId));
  await audit({
    actor: u.email, entityType: "agreement", entityId: agreementId,
    action: `filed '${src.fileName}' against ${a.number || a.title || "the agreement"}`,
  });
  revalidatePath(`/settings/organizations/${a.orgId}`);
  revalidatePath("/agreements");
  return {};
}

/**
 * Put the signed paper on the agreement in one motion: record the upload and
 * file it, without a trip through the library first.
 *
 * The library route (fileAgreementPaper) assumed the PDF was already on the
 * shelf, which it never is at the moment somebody is typing a contract's terms
 * off it - so writing an agreement meant leaving the form, uploading under
 * Files, and coming back. One insert rather than record-then-link, so a failure
 * cannot leave a document on the shelf that nobody knows belongs to a contract.
 */
export async function uploadAgreementPapers(
  agreementId: number,
  files: { fileName: string; url: string; size: number }[],
): Promise<{ error?: string }> {
  const u = await requireStaff();
  if (!files.length) return {};
  const [a] = await db.select().from(agreements).where(eq(agreements.id, agreementId));
  if (!a) return { error: "Not found" };
  const gate = await adminOrgGate(u, a.orgId);
  if ("error" in gate) return gate;
  const guard = await guardStorage(u.orgId, files.reduce((n, f) => n + (f.size || 0), 0));
  if (guard) return guard;
  const rows = await db.insert(attachments).values(files.map((f) => ({
    fileName: f.fileName, url: f.url, size: f.size, description: "",
    kind: "Other", tenantOrgId: myTenantOrgId(u),
    instrumentId: null, assetId: null, orgId: u.orgId, agreementId,
    uploadedBy: u.name,
  }))).returning();
  for (const row of rows) {
    await audit({
      actor: u.email, entityType: "agreement", entityId: agreementId, tenantOrgId: a.tenantOrgId,
      action: `filed '${row.fileName}' against ${a.number || a.title || "the agreement"}`,
    });
  }
  revalidatePath(`/settings/organizations/${a.orgId}`);
  revalidatePath("/agreements");
  revalidatePath("/documents");
  return {};
}

/** Unfile it. The document stays in the library; only the link goes. */
export async function unfileAgreementPaper(attachmentId: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [src] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  if (!src || src.agreementId === null) return { error: "Not found" };
  const [a] = await db.select().from(agreements).where(eq(agreements.id, src.agreementId));
  if (a) {
    const gate = await adminOrgGate(u, a.orgId);
    if ("error" in gate) return gate;
  }
  await db.update(attachments).set({ agreementId: null }).where(eq(attachments.id, attachmentId));
  await audit({
    actor: u.email, entityType: "agreement", entityId: src.agreementId,
    action: `unfiled '${src.fileName}' from the agreement - the file stays in the library`,
  });
  if (a) revalidatePath(`/settings/organizations/${a.orgId}`);
  revalidatePath("/agreements");
  return {};
}

export async function listLibraryFiles(): Promise<{
  files: { id: number; fileName: string; kind: string; description: string; size: number }[];
}> {
  const u = await requireUser();
  const rows = await db.select({
    id: attachments.id, fileName: attachments.fileName, kind: attachments.kind,
    description: attachments.description, size: attachments.size,
  }).from(attachments)
    .where(and(
      isNull(attachments.instrumentId), isNull(attachments.assetId),
      u.orgId === null ? isNull(attachments.orgId) : eq(attachments.orgId, u.orgId),
    ))
    .orderBy(desc(attachments.createdAt))
    .limit(300);
  return { files: rows };
}

/**
 * Refuse a write that would overflow the store, naming the shortfall. Returns
 * an error object to hand straight back, or undefined when there's room. The
 * upload token route makes the same check earlier, so a 90MB transfer isn't
 * spent to learn the answer - this is the one that cannot be bypassed.
 */
/** Whose store a file on this record lands in - the record's owner. */
async function storeOwnerForTarget(
  t: { instrumentId: number | null; asset: typeof assets.$inferSelect | null },
): Promise<number | null> {
  if (t.instrumentId !== null) {
    const [i] = await db.select({ ownerOrgId: instruments.ownerOrgId }).from(instruments).where(eq(instruments.id, t.instrumentId));
    return i?.ownerOrgId ?? null;
  }
  return t.asset?.ownerOrgId ?? null;
}

async function guardStorage(orgId: number | null, addBytes: number): Promise<{ error: string } | undefined> {
  if (addBytes <= 0) return undefined;
  const q = await storeQuota(orgId);
  if (fits(q.usedBytes, addBytes, q.limitBytes === null ? 0 : Math.round(q.limitBytes / MB))) return undefined;
  return { error: overQuotaMessage(q.storeName, q, addBytes) };
}

export async function deleteAttachment(attachmentId: number, reason: string): Promise<{ error?: string }> {
  // An organization must be able to clear its OWN shelf - otherwise a storage
  // limit is a trap with no way out. Deleting a file off a record stays
  // staff-only, as it always was: that is somebody's evidence.
  const u = await requireEditor();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [a] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  if (!a) return {};
  if (a.instrumentId === null && a.assetId === null) {
    if ((a.orgId ?? null) !== u.orgId) return { error: "Not found" };
  } else {
    if (!isHouse(u.role)) return { error: "Staff only" };
    await assertWorkEditable(u, a);
  }
  await db.delete(attachments).where(eq(attachments.id, attachmentId));
  await deleteBlobs([a.url]); // remove the actual file from Vercel Blob, not just our record
  await audit({
    actor: u.email, instrumentId: a.instrumentId, assetId: a.assetId, entityType: "attachment", entityId: attachmentId,
    action: `removed attachment: ${a.fileName} (file deleted from storage) - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revWork(a);
  return {};
}

// ---------------- Sheet diffs ----------------

export async function resolveDiff(
  diffId: number,
  resolution: "kept_ours" | "accepted_sheet" | "kept_ours_pushed"
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [d] = await db.select().from(sheetDiffs).where(eq(sheetDiffs.id, diffId));
  if (!d || d.resolved) return {};

  // "Keep ours + fix sheet": write our value into the client's sheet first;
  // only mark resolved once the write succeeded.
  if (resolution === "kept_ours_pushed") {
    if (d.field === "Row") {
      // Only meaningful in the "we have it, the sheet doesn't" direction: add the row.
      if (d.sheetValue !== "(missing from sheet)") {
        return { error: "This row is on the sheet and not in our records - use Accept sheet to import it" };
      }
      const [inst] = await db.select().from(instruments).where(eq(instruments.externalId, d.externalId));
      if (!inst) return { error: `${d.externalId} is no longer in our records` };
      return await pushInstrumentToSheet(inst.id); // handles the append, audit, and diff close
    }
    let value = d.dbValue;
    const [inst] = await db.select().from(instruments).where(eq(instruments.externalId, d.externalId));
    if (d.field === "Stage" && inst) {
      // Write only what the sheet can express - internal-only stages stay ours.
      value = inst.stages.filter((s) => !["Waiting / blocked", "Waiting to ship"].includes(s)).join(", ");
    }
    if (d.field === "Notes" && inst) value = inst.notes;
    if (d.field === "Priority" && inst) value = String(inst.priority);
    try {
      await pushValueToSheet(d.externalId, d.field, value);
    } catch (e) {
      return { error: (e as Error).message || "Sheet update failed" };
    }
  }

  // Accepting a "Row" diff for a system the sheet has and we don't means:
  // import it. Pull the full sheet row (priority, stages, notes) when we can;
  // fall back to the diff's "model (client)" summary if the sheet is
  // unreachable. Runs BEFORE marking resolved so a failed import stays open.
  if (resolution === "accepted_sheet" && d.field === "Row" && d.dbValue === "(missing from our records)") {
    const [existing] = await db.select().from(instruments).where(eq(instruments.externalId, d.externalId));
    if (!existing) {
      let client = "", model = d.sheetValue, priority = 99, stages: string[] = [], notes = "";
      try {
        const sheetRow = (await fetchTrackerRows()).find((r) => r.externalId === d.externalId);
        if (sheetRow) ({ client, model, priority, stages, notes } = sheetRow);
      } catch {
        const m = /^(.*) \(([^)]*)\)$/.exec(d.sheetValue);
        if (m) { model = m[1]; client = m[2]; }
      }
      const rowStages = stages.length ? stages : ["Intake"];
      const [row] = await db.insert(instruments).values({
        tenantOrgId: myTenantOrgId(u),
        externalId: d.externalId, client, model, priority, stages: rowStages, notes,
      }).onConflictDoNothing().returning();
      if (row) {
        for (const s of rowStages) {
          await db.insert(stageEvents).values({ instrumentId: row.id, stage: s, kind: "added" });
        }
        await audit({
          actor: u.email, instrumentId: row.id, entityType: "instrument", entityId: row.externalId,
          action: `created instrument ${row.externalId}: ${row.model} (imported from sheet via parity)`,
        });
      }
    }
  }
  // The reverse Row case ("(missing from sheet)") is acknowledge-only on
  // purpose - accepting the sheet must never auto-delete our records.

  await db.update(sheetDiffs).set({ resolved: true, resolvedBy: u.email, resolution }).where(eq(sheetDiffs.id, diffId));
  // Accepting the sheet's value applies it for the fields we can apply mechanically.
  if (resolution === "accepted_sheet") {
    const [inst] = await db.select().from(instruments).where(eq(instruments.externalId, d.externalId));
    if (inst && d.field !== "Row") {
      if (d.field === "Notes") await db.update(instruments).set({ notes: d.sheetValue, updatedAt: new Date() }).where(eq(instruments.id, inst.id));
      if (d.field === "Priority") await db.update(instruments).set({ priority: parseInt(d.sheetValue) || inst.priority, updatedAt: new Date() }).where(eq(instruments.id, inst.id));
      // Stage diffs are resolved by hand in the UI; too lossy to auto-apply.
    }
  }
  const how = resolution === "kept_ours" ? "kept ours"
    : resolution === "accepted_sheet" ? "accepted sheet"
    : "kept ours and updated the sheet";
  await audit({
    actor: u.email, entityType: "sheet_diff", entityId: diffId,
    action: `resolved sheet diff on ${d.externalId} ${d.field} (${how})`,
  });
  revalidatePath("/parity");
  rev();
  return {};
}

// ---------------- End-of-day client update ----------------

/**
 * Upsert today's client-facing update for a system or a single asset. Written
 * where the work happens - the system's or asset's own page - and assembled by
 * /eod. Not audited: it's a draft of a message, not instrument history.
 */
export async function saveEodUpdate(
  target: { instrumentId: number | null; assetId: number | null },
  data: { systemUpdate: string; actionItem: string },
) {
  const u = await requireStaff();
  const date = shopToday();
  const systemUpdate = data.systemUpdate.trim();
  const actionItem = data.actionItem.trim();
  // owner_org_id is stamped on the way in and deliberately absent from the
  // conflict SET: the line belongs to whoever owned the system the day it was
  // written, forever, whatever happens to the system afterwards.
  if (target.instrumentId !== null) {
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, target.instrumentId));
    if (!inst) throw new Error("Not found");
    await db.insert(eodUpdates)
      .values({ tenantOrgId: inst.tenantOrgId, instrumentId: target.instrumentId, date, ownerOrgId: inst.ownerOrgId, systemUpdate, actionItem, updatedBy: u.name, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [eodUpdates.instrumentId, eodUpdates.date],
        set: { systemUpdate, actionItem, updatedBy: u.name, updatedAt: new Date() },
      });
  } else if (target.assetId !== null) {
    const [a] = await db.select().from(assets).where(eq(assets.id, target.assetId));
    if (!a) throw new Error("Not found");
    await db.insert(eodUpdates)
      .values({ tenantOrgId: a.tenantOrgId, assetId: target.assetId, date, ownerOrgId: a.ownerOrgId, systemUpdate, actionItem, updatedBy: u.name, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [eodUpdates.assetId, eodUpdates.date],
        set: { systemUpdate, actionItem, updatedBy: u.name, updatedAt: new Date() },
      });
  } else {
    throw new Error("Not found");
  }
  // No revalidatePath here on purpose: autosave fires on every typing pause,
  // and a revalidate would make the client re-fetch the whole page each time
  // (visible jank on mobile). The typist's screen is already current; other
  // viewers get fresh data on page load, which is how the EOD flow works.
}

/**
 * Email today's report to ONE client - the organization that owns those
 * systems - using its own recipient list. `orgId` null is the operator's own
 * group (house-stewarded work), which goes to the operator org's list.
 */
export async function sendEodEmail(orgId: number | null): Promise<{ error?: string; sent?: number }> {
  const u = await requireStaff();
  let recipients = "";
  let who = "";
  if (orgId === null) {
    const brand = await getBrand();
    const [op] = brand.operatorOrgId === null ? [] : await db.select().from(orgs).where(eq(orgs.id, brand.operatorOrgId));
    recipients = op?.eodRecipients ?? "";
    who = op?.name ?? brand.name;
  } else {
    const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
    if (!org) return { error: "Not found" };
    recipients = org.eodRecipients;
    who = org.name;
  }
  const to = recipients.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!to.length) return { error: `No recipients for ${who} - add them in Settings first` };
  const { subject, html, filled, total } = await composeEodEmail(shopToday(), shopTodayMDY(), orgId, myTenantOrgId(u));
  if (!total) return { error: `Nothing to report for ${who}` };
  if (!filled) return { error: `Every line for ${who} is still blank - write at least one update first` };
  try {
    await sendEmail(to, subject, html);
  } catch (e) {
    // Explicit user action, so surface the failure instead of swallowing it.
    console.error("[eod] send failed:", (e as Error).message);
    return { error: "Email failed to send - check AUTH_RESEND_KEY / EMAIL_FROM and try again" };
  }
  await audit({
    actor: u.email, entityType: "eod", entityId: `${shopToday()}:${orgId ?? "own"}`,
    action: `sent the ${who} daily report to ${to.length} recipient${to.length === 1 ? "" : "s"}`,
  });
  revalidatePath("/eod");
  return { sent: to.length };
}

/** Leave a system out of (or bring it back into) today's client email. Keeps any saved text. */
export async function setEodSkip(
  target: { instrumentId: number | null; assetId: number | null }, skipped: boolean,
) {
  const u = await requireStaff();
  const date = shopToday();
  if (target.instrumentId !== null) {
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, target.instrumentId));
    if (!inst) throw new Error("Not found");
    await db.insert(eodUpdates)
      .values({ tenantOrgId: inst.tenantOrgId, instrumentId: target.instrumentId, date, ownerOrgId: inst.ownerOrgId, skipped, updatedBy: u.name, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [eodUpdates.instrumentId, eodUpdates.date],
        set: { skipped, updatedBy: u.name, updatedAt: new Date() },
      });
  } else if (target.assetId !== null) {
    const [a] = await db.select().from(assets).where(eq(assets.id, target.assetId));
    if (!a) throw new Error("Not found");
    await db.insert(eodUpdates)
      .values({ tenantOrgId: a.tenantOrgId, assetId: target.assetId, date, ownerOrgId: a.ownerOrgId, skipped, updatedBy: u.name, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [eodUpdates.assetId, eodUpdates.date],
        set: { skipped, updatedBy: u.name, updatedAt: new Date() },
      });
  } else throw new Error("Not found");
  revalidatePath("/eod");
}

// ---------------- Discussions ----------------

/**
 * Who may be emailed about a post. An email quotes the post, so the recipient
 * list is exactly the post's readership and never wider: an internal note
 * reaches only the author's own organization, a General post only the room it
 * was written in, and a system post the organizations that system is shared
 * with. A @domain sign-in entry names nobody in particular, so it can't be a
 * recipient on its own.
 */
async function postAudience(p: {
  instrumentId: number | null; audience: Audience; authorOrgId: number | null; roomOrgId: number | null;
  /** The thread's workspace, so its own engineers are the staff side of it. */
  tenantOrgId?: number | null;
}): Promise<string[]> {
  const staff = await houseEmails(p.tenantOrgId);
  const entries = await db.select().from(clientAllowlist);
  const emailsFor = (orgId: number) => entries
    .filter((e) => e.orgId === orgId && !e.entry.trim().startsWith("@"))
    .map((e) => e.entry.toLowerCase());

  if (p.audience === "internal") return p.authorOrgId === null ? staff : emailsFor(p.authorOrgId);
  if (p.instrumentId === null) {
    return p.roomOrgId === null ? staff : [...new Set([...staff, ...emailsFor(p.roomOrgId)])];
  }
  const shares = await db.select({ orgId: systemShares.orgId }).from(systemShares)
    .where(eq(systemShares.instrumentId, p.instrumentId));
  if (!shares.length) return staff;
  return [...new Set([...staff, ...shares.flatMap((s) => emailsFor(s.orgId))])];
}

/**
 * The viewer as the discussion rules see them: which house, or which
 * organization. `houseOrgId` is the part that matters on an instance with two
 * service companies - see lib/discussionScope.
 */
const partyOf = (u: SessionUser): Viewer => ({
  isHouse: isHouse(u.role), orgId: u.orgId, houseOrgId: isHouse(u.role) ? myTenantOrgId(u) : null,
});

/** The organization a post is attributed to - null for the operator's own staff. */
const authorOrgOf = (u: SessionUser): number | null => (isHouse(u.role) ? null : u.orgId);

// Posting only needs a signed-in user: talking is not record-editing, so
// client viewers may post even while the edit toggle is off.

export async function postDiscussion(
  instrumentId: number | null,
  body: string,
  opts: { audience?: Audience; roomOrgId?: number | null } = {},
) {
  const u = await requireUser();
  const text = body.trim();
  if (!text) throw new Error("Post text required");
  const audience: Audience = opts.audience === "internal" ? "internal" : "all";
  const authorOrgId = authorOrgOf(u);
  let externalId = "";
  let roomOrgId: number | null = null;
  let postTenant: number | null = myTenantOrgId(u);

  if (instrumentId !== null) {
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
    if (!inst) throw new Error("Not found");
    postTenant = inst.tenantOrgId;
    // A thread lives with its system: you can only post where you can see.
    await assertSystemVisible(u, instrumentId);
    externalId = inst.externalId;
  } else {
    // The General board is a set of private rooms: an organization has its own,
    // the operator has one of its own and sits in all the others.
    const known = await db.select({ id: orgs.id }).from(orgs);
    const room = resolveRoom(partyOf(u), opts.roomOrgId ?? null, known.map((o) => o.id));
    if (!room.ok) throw new Error("Not found");
    roomOrgId = room.roomOrgId;
  }

  await db.insert(discussionPosts).values({
    // The workspace this was said in. On a system it is the system's, so a note
    // written on a client's machine stays with the company whose machine it is.
    // On the General board it is the speaker's own.
    tenantOrgId: postTenant, instrumentId,
    author: u.name, authorEmail: u.email, body: text, authorOrgId, audience, roomOrgId,
  });
  // The activity feed is read by everyone who can see the system, so an internal
  // post is recorded as having happened without quoting a word of it.
  await audit({
    actor: u.email, instrumentId: instrumentId ?? undefined, entityType: "discussion", entityId: externalId || "general",
    action: audience === "internal"
      ? `posted an internal note in ${externalId ? `${externalId} ` : "general "}discussion`
      : `posted in ${externalId ? `${externalId} ` : "general "}discussion: "${text.length > 120 ? text.slice(0, 120) + "..." : text}"`,
  });
  await notifyDiscussion({
    actorEmail: u.email, actorName: u.name,
    actorIsClient: u.role === "client_viewer" || u.role === "client_editor",
    body: text, instrumentId, label: externalId || "General",
    allowedEmails: await postAudience({
      instrumentId, audience, authorOrgId, roomOrgId,
      tenantOrgId: instrumentId === null ? myTenantOrgId(u) : await tenantOfSystem(instrumentId),
    }),
  });
  if (instrumentId !== null) rev(instrumentId);
  revalidatePath("/discussions");
}

/** Mark a thread read for the current user. See roomThreadId for the numbering. */
export async function markThreadRead(threadId: number) {
  const u = await requireUser();
  // Positive is a system, and it must be one the caller can see, so a read
  // marker can't be used to probe which system ids exist. 0 is the caller's own
  // General room. Negative is the operator's marker for one organization's room.
  if (threadId > 0) await assertSystemVisible(u, threadId);
  if (threadId < 0) {
    if (!isHouse(u.role)) throw new Error("Not found");
    const [o] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, -threadId));
    if (!o) throw new Error("Not found");
  }
  await db.insert(discussionReads)
    .values({ userEmail: u.email, threadId, lastSeenAt: new Date() })
    .onConflictDoUpdate({
      target: [discussionReads.userEmail, discussionReads.threadId],
      set: { lastSeenAt: new Date() },
    });
}

// ── Page layout ─────────────────────────────────────────────────────────────

/** Views whose arrangement is saveable. Anything else is rejected outright. */
const PANEL_VIEWS = ["system", "asset"] as const;

export type PanelArrangement = { order: string[]; right: string[]; hidden: string[] };

/**
 * Remember how this person arranged a record page. Their own row only - the
 * email comes from the session, never the caller - so there is nothing to probe
 * and no audit line to write: it's a view preference, like a read marker.
 *
 * Keys are stored as given but bounded in count and length, because this is the
 * one table a client can write to freely.
 */
export async function saveUiLayout(viewKey: string, data: PanelArrangement): Promise<{ error?: string }> {
  const u = await requireUser();
  if (!(PANEL_VIEWS as readonly string[]).includes(viewKey)) return { error: "Unknown view" };
  const keys = (list: unknown): string[] =>
    Array.isArray(list)
      ? [...new Set(list.filter((k): k is string => typeof k === "string" && k.length > 0 && k.length <= 40))].slice(0, 60)
      : [];
  const clean: PanelArrangement = { order: keys(data?.order), right: keys(data?.right), hidden: keys(data?.hidden) };
  const email = u.email.toLowerCase();
  await db.insert(uiLayouts)
    .values({ email, viewKey, data: clean, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [uiLayouts.email, uiLayouts.viewKey],
      set: { data: clean, updatedAt: new Date() },
    });
  return {};
}

/**
 * This person's saved arrangement, or null for the page's default. Read on the
 * server so the page renders already arranged - reading it in the browser would
 * show one frame of the default layout and then jump.
 */
export async function getUiLayout(viewKey: string): Promise<PanelArrangement | null> {
  const u = await requireUser();
  const [row] = await db.select({ data: uiLayouts.data }).from(uiLayouts)
    .where(and(eq(uiLayouts.email, u.email.toLowerCase()), eq(uiLayouts.viewKey, viewKey)))
    .catch(() => []);
  return (row?.data as PanelArrangement) ?? null;
}

/**
 * The file table's column widths, per person.
 *
 * Stored in ui_layouts beside the panel arrangements - same table, its own
 * viewKey - because it is the same kind of fact: how THIS person likes THIS
 * screen, worth nothing to anybody else and worth keeping for them. Clamped on
 * the way in so a bad drag (or a bad payload) cannot save a zero-width column
 * that looks like data loss.
 */
export type FileColumnWidths = { where: number; size: number; when: number };
const FILE_COLUMN_BOUNDS: Record<keyof FileColumnWidths, [number, number]> = {
  where: [90, 420], size: [56, 160], when: [90, 300],
};
const FILE_COLUMNS_KEY = "files-columns";

export async function saveFileColumns(widths: FileColumnWidths): Promise<{ error?: string }> {
  const u = await requireUser();
  const clean = Object.fromEntries(
    (Object.keys(FILE_COLUMN_BOUNDS) as (keyof FileColumnWidths)[]).map((k) => {
      const [lo, hi] = FILE_COLUMN_BOUNDS[k];
      const n = Math.round(Number(widths?.[k]));
      return [k, Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo];
    }),
  ) as FileColumnWidths;
  await db.insert(uiLayouts)
    .values({ email: u.email.toLowerCase(), viewKey: FILE_COLUMNS_KEY, data: clean, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [uiLayouts.email, uiLayouts.viewKey],
      set: { data: clean, updatedAt: new Date() },
    });
  return {};
}

/** This person's saved widths, or null for the defaults. Read on the server. */
export async function getFileColumns(): Promise<FileColumnWidths | null> {
  const u = await requireUser();
  const [row] = await db.select({ data: uiLayouts.data }).from(uiLayouts)
    .where(and(eq(uiLayouts.email, u.email.toLowerCase()), eq(uiLayouts.viewKey, FILE_COLUMNS_KEY)))
    .catch(() => []);
  return (row?.data as FileColumnWidths) ?? null;
}

// ── Inbox ───────────────────────────────────────────────────────────────────
// Read markers follow the markThreadRead precedent: your own inbox, no audit.
// Rows are only ever touched through the caller's own email, so there's no id
// to probe - marking someone else's notification read is unexpressible.

export async function markNotificationRead(id: number) {
  const u = await requireUser();
  await db.update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.email, u.email.toLowerCase()), isNull(notifications.readAt)));
  revalidatePath("/inbox");
  revalidatePath("/", "layout"); // the nav badge
}

export async function markAllNotificationsRead() {
  const u = await requireUser();
  await db.update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.email, u.email.toLowerCase()), isNull(notifications.readAt)));
  revalidatePath("/inbox");
  revalidatePath("/", "layout");
}

/** Per-kind email opt-out. The inbox row always lands; this gates the email. */
export async function setNotificationPref(kind: string, emailOn: boolean): Promise<{ error?: string }> {
  const u = await requireUser();
  if (!isNotifyKind(kind)) return { error: "Unknown notification kind" };
  const email = u.email.toLowerCase();
  await db.insert(notificationPrefs)
    .values({ email, kind, emailOn })
    .onConflictDoUpdate({ target: [notificationPrefs.email, notificationPrefs.kind], set: { emailOn } });
  // Audited (unlike read markers): "why did nobody get the email" needs an
  // answer months later, and the answer may be "they turned it off in May".
  await audit({
    actor: u.email, entityType: "notification_pref",
    action: `turned ${emailOn ? "on" : "off"} email for "${NOTIFY_KINDS.find((k) => k.kind === kind)?.label ?? kind}"`,
    field: kind, newValue: String(emailOn),
  });
  revalidatePath("/inbox");
  return {};
}

export async function updateDiscussionPost(postId: number, body: string) {
  const u = await requireEditor();
  const text = body.trim();
  if (!text) throw new Error("Post text required");
  const [p] = await db.select().from(discussionPosts).where(eq(discussionPosts.id, postId));
  if (!p || p.body === text) return;
  if (p.instrumentId !== null) await assertSystemVisible(u, p.instrumentId);
  // A post you cannot read is not yours to touch, and that holds for the
  // operator too - otherwise "internal" leaks through the edit and delete paths.
  if (!canSeePost(partyOf(u), { ...p, audience: p.audience as Audience })) throw new Error("Not found");
  // Editing someone else's words was possible for any editor - your own posts
  // (or staff) only.
  if (!isHouse(u.role) && p.authorEmail.toLowerCase() !== u.email.toLowerCase()) {
    throw new Error("You can only edit your own posts");
  }
  await db.update(discussionPosts).set({ body: text }).where(eq(discussionPosts.id, postId));
  const quotable = p.audience !== "internal";
  await audit({
    actor: u.email, instrumentId: p.instrumentId ?? undefined, entityType: "discussion", entityId: postId,
    action: `edited ${quotable ? "a" : "an internal"} discussion post by ${p.author}`,
    ...(quotable ? { field: "body", oldValue: p.body, newValue: text } : {}),
  });
  if (p.instrumentId !== null) rev(p.instrumentId);
  revalidatePath("/discussions");
}

export async function deleteDiscussionPost(postId: number, reason: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [p] = await db.select().from(discussionPosts).where(eq(discussionPosts.id, postId));
  if (!p) return {};
  if (p.instrumentId !== null) await assertSystemVisible(u, p.instrumentId);
  if (!canSeePost(partyOf(u), { ...p, audience: p.audience as Audience })) return { error: "Not found" };
  if (!isHouse(u.role) && p.authorEmail.toLowerCase() !== u.email.toLowerCase()) {
    return { error: "You can only delete your own posts" };
  }
  await db.delete(discussionPosts).where(eq(discussionPosts.id, postId));
  const quotable = p.audience !== "internal";
  await audit({
    actor: u.email, instrumentId: p.instrumentId ?? undefined, entityType: "discussion", entityId: postId,
    action: `deleted ${quotable ? "a" : "an internal"} discussion post by ${p.author} - reason: ${why}`,
    ...(quotable ? { field: "body", oldValue: p.body, newValue: why } : {}),
  });
  if (p.instrumentId !== null) rev(p.instrumentId);
  revalidatePath("/discussions");
  return {};
}

// ---------------- Procedures ----------------
// The one catalog of work definitions: everything here fires automatically on
// units - at intake (the old checkout items), on a cadence (the old
// maintenance templates), or both from a single row. Staff-managed like the
// equipment catalog it keys on.

/** "system" plus any nonempty type name - asset kinds are an open vocabulary. */
const validProcedureType = (t: string) => t === "system" || (!!t.trim() && t.trim().length <= 40);

type ProcedureInput = {
  assetType: string; kind: string; name: string; notes: string;
  resultType: string; target: string; tolerancePct: string;
  requiresNote: boolean; consumesPart: boolean;
  runsAtIntake: boolean; intervalDays: number | string | null;
  required?: boolean;
  qualification?: string;
  parts: ProcPart[]; modelScope: string[]; categoryScope?: string[];
  /** The steps, one per line. See lib/checklist. */
  checklist?: string;
  /** Whose words these are - see lib/provenance. */
  provenance?: string;
};

/** Validate + normalize; returns {error} or clean column values. */
function cleanProcedure(data: ProcedureInput): { error: string } | {
  assetType: string; kind: string; name: string; notes: string;
  resultType: string; target: string | null; tolerancePct: string | null;
  requiresNote: boolean; consumesPart: boolean;
  runsAtIntake: boolean; intervalDays: number | null;
  required: boolean;
  qualification: string;
  parts: string; modelScope: string[]; categoryScope: string[];
  checklist: string;
  provenance: string;
} {
  if (!validProcedureType(data.assetType)) return { error: "Pick an asset type" };
  if (!(CHECKOUT_KINDS as readonly string[]).includes(data.kind)) return { error: "Pick task or test" };
  const name = data.name.trim();
  if (!name || name.length > 120) return { error: "Name must be 1-120 characters" };
  const isTest = data.kind === "test";
  // Tasks carry one meaningful result type: inspect_replace, the outcome gate.
  // Everything else a task stores as pass_fail, which for a task means "none".
  const resultType = isTest
    ? ((RESULT_TYPES as readonly string[]).includes(data.resultType) ? data.resultType : "pass_fail")
    : (data.resultType === "inspect_replace" ? "inspect_replace" : "pass_fail");
  const target = isTest && (resultType === "measured" || resultType === "note") ? data.target.trim() || null : null;
  let tolerancePct: string | null = null;
  if (isTest && resultType === "measured" && data.tolerancePct.trim()) {
    const n = parseFloat(data.tolerancePct.trim());
    if (Number.isNaN(n) || n < 0) return { error: "Tolerance must be a number, e.g. 10" };
    tolerancePct = String(n);
  }
  let intervalDays: number | null = null;
  if (data.intervalDays !== null && String(data.intervalDays).trim() !== "") {
    const cadence = parseCadence(data.intervalDays);
    if ("error" in cadence) return cadence;
    intervalDays = cadence.days;
  }
  // A procedure that never fires is an orphan - refuse it at the source.
  if (!data.runsAtIntake && intervalDays === null) {
    return { error: "Pick when it runs: at intake, on a cadence, or both" };
  }
  // A system procedure USED to be refused a cadence here - "recurring work lives
  // on the modules" - on the reasoning that a schedule needs an asset to hang
  // off. It doesn't: pm_schedules has an instrument_id, generateDuePmTasks has
  // always handled it, and applySystemProcedures was written to stamp exactly
  // these. This one line was what forced a shop to write an annual system PM out
  // by hand on every system, once per system, forever - and to redo it whenever
  // the fleet grew. It is gone.
  //
  // A system's scope is its CATEGORY, not a model: a system is not one model, it
  // is a stack of them. Empty means every system, which is what the ones defined
  // before this column meant.
  //
  // Module-level procedures carry a category scope too: "Autosampler" is one
  // module type, but the TOC sampler's procedures are not the LC-MS sampler's.
  // Empty still means every system type the module serves.
  const modelScope = data.assetType === "system"
    ? [] : [...new Set(data.modelScope.map((m) => m.trim()).filter(Boolean))];
  const categoryScope = [...new Set((data.categoryScope ?? []).map((c) => c.trim()).filter(Boolean))];
  return {
    assetType: data.assetType, kind: data.kind, name, notes: data.notes.trim(),
    resultType, target, tolerancePct,
    requiresNote: !isTest && data.requiresNote, consumesPart: !isTest && data.consumesPart,
    runsAtIntake: data.runsAtIntake, intervalDays,
    // Persisted since the sheet grew the checkbox - it used to be silently
    // dropped here, so "Required for sign-off" never actually saved.
    required: data.required ?? false,
    // '' when the tag isn't one of ours - an unknown value silently becoming a
    // qualification is exactly the kind of surprise a regulated record can't have.
    qualification: (QUALIFICATIONS as readonly string[]).includes(data.qualification ?? "")
      ? data.qualification! : "",
    parts: serializeProcParts(data.parts), modelScope, categoryScope,
    // Normalized here rather than at every reader: what gets stored is what
    // the stamper will produce, so the editor shows the real steps back.
    checklist: serializeChecklist(parseChecklist(data.checklist ?? "")),
    provenance: cleanProvenance(data.provenance),
  };
}

/** Which units or systems a procedure is narrowed to, or nothing when it is all of them. */
const procScopeLabel = (scope: string[]) => (scope.length ? ` (${scope.join(", ")} only)` : "");

/**
 * The scope that actually applies to a procedure: categories for a system-level
 * one, models for everything else. Two procedures with the same name on the same
 * type are duplicates only if they also cover the same things - "Annual PM
 * (LC-MS)" and "Annual PM (GC)" are two jobs, not one typed twice.
 */
const scopeOf = (p: { assetType: string; modelScope: string[]; categoryScope: string[] }) =>
  (p.assetType === "system" ? p.categoryScope : p.modelScope);
// Module rows compare BOTH scopes: "Replace syringe" under TOC and "Replace
// syringe" under LC-MS are two jobs, not one typed twice.
const sameScope = (
  a: { assetType: string; modelScope: string[]; categoryScope: string[] },
  b: { assetType: string; modelScope: string[]; categoryScope: string[] },
) => scopeOf(a).join("|").toLowerCase() === scopeOf(b).join("|").toLowerCase()
  && a.categoryScope.join("|").toLowerCase() === b.categoryScope.join("|").toLowerCase();
const procTimingLabel = (p: { runsAtIntake: boolean; intervalDays: number | null }) =>
  p.runsAtIntake && p.intervalDays !== null ? `at intake + ${cadenceLabel(p.intervalDays)}`
    : p.runsAtIntake ? "at intake" : cadenceLabel(p.intervalDays!);

/**
 * The same procedure, on another module type.
 *
 * A leak check is a leak check whether the thing being checked is a pump or the
 * whole LC stack, and writing it out twice produces two subtly different leak
 * checks. Copying takes the work - the notes, the timing, the parts, whether it
 * is mandatory - and leaves behind the model scope, which named models of the
 * type it came from and would match nothing on the new one.
 *
 * Several targets in one go, because "this belongs on the stack and on the
 * detector too" is the same thought twice.
 */
export async function copyProcedureToTypes(
  procedureId: number, assetTypes: string[],
): Promise<{ error?: string; copied?: number; skipped?: string[] }> {
  const u = await requireStaff();
  const [p] = await db.select().from(procedures).where(eq(procedures.id, procedureId));
  if (!p) return { error: "Not found" };
  if (readTenant(u) !== null && p.tenantOrgId !== readTenant(u)) return { error: "Not found" };

  const wanted = [...new Set(assetTypes.map((t) => t.trim()).filter(Boolean))]
    .filter((t) => t.toLowerCase() !== p.assetType.toLowerCase());
  if (!wanted.length) return { error: "Pick a module type to copy this to." };

  // Only types the catalog knows: a procedure filed against a typo would sit in
  // a group nothing ever generates work from.
  const known = await db.select({ name: vocabTerms.name }).from(vocabTerms)
    .where(and(eq(vocabTerms.kind, "asset_type"), forTenant(vocabTerms.tenantOrgId, readTenant(u))));
  const byName = new Map(known.map((k) => [k.name.toLowerCase(), k.name]));
  const targets = wanted.map((t) => byName.get(t.toLowerCase())).filter((t): t is string => !!t);
  if (!targets.length) return { error: "That module type is not in the catalog." };

  const existing = await db.select({ assetType: procedures.assetType, name: procedures.name, position: procedures.position })
    .from(procedures).where(forTenant(procedures.tenantOrgId, readTenant(u)));

  const skipped: string[] = [];
  let copied = 0;
  for (const to of targets) {
    if (alreadyHas(existing, to, p.name)) { skipped.push(to); continue; }
    const after = Math.max(0, ...existing.filter((e) => e.assetType === to).map((e) => e.position));
    const copy = procedureCopy(p, to, after + 1);
    await db.insert(procedures).values({ ...copy, tenantOrgId: p.tenantOrgId });
    existing.push({ assetType: to, name: p.name, position: after + 1 });
    copied += 1;
  }
  if (copied) {
    await audit({
      actor: u.email, entityType: "procedure", entityId: procedureId,
      action: `copied "${p.name}" from ${p.assetType} to ${targets.filter((t) => !skipped.includes(t)).join(", ")}`,
    });
    revalidatePath("/settings/procedures");
    rev();
  }
  return { copied, skipped };
}

/**
 * Move a module type from one system category to another.
 *
 * Correcting a filing mistake - "LC System" entered under UV-Vis when it belongs
 * under LC-MS - without re-entering the models underneath it.
 *
 * There is no row that says a type belongs to a category: the tree is derived
 * from the tags on that type's MODELS (see lib/procedureMove). So this rewrites
 * those tags and touches nothing else - every model keeps its name, its
 * manufacturer, and any other category it was also filed under.
 */
export async function moveTypeToCategory(
  assetType: string, from: string, to: string,
): Promise<{ error?: string; moved?: number }> {
  const u = await requireStaff();
  const t = readTenant(u);
  const terms = await db.select().from(vocabTerms).where(forTenant(vocabTerms.tenantOrgId, t));

  const target = terms.find((v) => v.kind === "category" && v.name.trim().toLowerCase() === to.trim().toLowerCase());
  if (!target) return { error: `"${to}" is not a system type in the catalog.` };

  const plan = refilePlan(
    terms.filter((v) => v.kind === "model")
      .map((v) => ({ id: v.id, assetType: v.assetType, name: v.name, categories: v.categories })),
    assetType, from, target.name,
  );
  if (!plan.length) return { error: refileSummary(assetType, from, target.name, 0) };

  for (const row of plan) {
    await db.update(vocabTerms).set({ categories: row.categories }).where(eq(vocabTerms.id, row.id));
  }
  await audit({
    actor: u.email, entityType: "vocab", entityId: 0,
    action: refileSummary(assetType, from, target.name, plan.length),
    field: "categories", oldValue: from, newValue: target.name,
  });
  revalidatePath("/settings/procedures");
  revalidatePath("/settings/catalog");
  rev();
  return { moved: plan.length };
}

export async function addProcedure(data: ProcedureInput): Promise<{ error?: string; applied?: number }> {
  const u = await requireStaff();
  const clean = cleanProcedure(data);
  if ("error" in clean) return clean;
  const siblings = await db.select().from(procedures).where(eq(procedures.assetType, clean.assetType));
  if (siblings.some((i) => i.kind === clean.kind && i.name.toLowerCase() === clean.name.toLowerCase()
      && sameScope(i, clean)))
    return { error: `"${clean.name}" already exists for this type` };
  const position = Math.max(0, ...siblings.map((i) => i.position)) + 1;
  const [row] = await db.insert(procedures).values({ ...clean, position, tenantOrgId: myTenantOrgId(u) }).returning();
  await audit({
    actor: u.email, entityType: "procedure", entityId: row.id,
    action: `added ${clean.kind} procedure "${clean.name}" for ${clean.assetType} - ${procTimingLabel(clean)}${procScopeLabel(scopeOf(clean))}`,
  });
  // A new recurring procedure covers the fleet already on the floor, per unit
  // deduped by title so hand-written schedules block the catalog's copy.
  let applied = 0;
  if (clean.intervalDays !== null) applied = await backfillProcedure(clean.assetType, shopToday(), u.email, myTenantOrgId(u));
  revalidatePath("/settings/procedures");
  revalidatePath("/maintenance");
  return { applied };
}

/**
 * "Apply to only this model": fork a shared procedure at the point of edit.
 *
 * A procedure covering many models is one definition on purpose - but the day
 * the G6495C's teardown grows a step the others don't need, the edit must be
 * able to land on just that model without the person re-creating the whole
 * thing by hand. So: the original loses this model from its scope, a copy
 * scoped to only this model is created carrying the edited content, and the
 * schedules already stamped onto units of this model are re-pointed at the
 * copy - their history, cadence and next-due stay exactly where they were.
 *
 * An empty scope means "every model of the type", including future ones; the
 * fork has to materialize that to today's list minus this model. That loss of
 * "and whatever comes later" is real and deliberate - it is what "this model
 * is different now" means - and the audit line records it.
 */
export async function forkProcedureForModel(
  procedureId: number, model: string, data: ProcedureInput,
): Promise<{ error?: string; newId?: number; repointed?: number }> {
  const u = await requireStaff();
  const m = model.trim();
  if (!m) return { error: "No model given" };
  const [orig] = await db.select().from(procedures).where(eq(procedures.id, procedureId));
  if (!orig) return { error: "Not found" };
  if (readTenant(u) !== null && orig.tenantOrgId !== readTenant(u)) return { error: "Not found" };
  if (orig.assetType === "system") return { error: "System procedures are scoped by category, not model" };
  const covers = orig.modelScope.length === 0
    || orig.modelScope.some((x) => x.toLowerCase() === m.toLowerCase());
  if (!covers) return { error: `This procedure doesn't cover ${m}` };

  const clean = cleanProcedure({ ...data, assetType: orig.assetType });
  if ("error" in clean) return clean;
  if (data.provenance === undefined) clean.provenance = orig.provenance;

  // What the original keeps: its explicit scope minus this model, or - for an
  // all-models row - today's catalog list minus this model.
  let keep: string[];
  if (orig.modelScope.length) {
    keep = orig.modelScope.filter((x) => x.toLowerCase() !== m.toLowerCase());
  } else {
    const models = await db.select({ name: vocabTerms.name }).from(vocabTerms)
      .where(and(eq(vocabTerms.kind, "model"), eq(vocabTerms.assetType, orig.assetType),
        forTenant(vocabTerms.tenantOrgId, readTenant(u))));
    keep = models.map((r) => r.name).filter((x) => x.toLowerCase() !== m.toLowerCase());
  }
  if (!keep.length) return { error: `It only covers ${m} - just save the edit normally` };

  await db.update(procedures).set({ modelScope: keep }).where(eq(procedures.id, procedureId));
  const siblings = await db.select().from(procedures).where(eq(procedures.assetType, orig.assetType));
  const position = Math.max(0, ...siblings.map((i) => i.position)) + 1;
  const [copy] = await db.insert(procedures).values({
    ...clean, modelScope: [m], position, tenantOrgId: orig.tenantOrgId,
  }).returning();

  // Schedules the original stamped onto units of this model follow the fork,
  // keeping their own cadence and history - only the definition they answer
  // to changes.
  const stamped = await db.select({ id: pmSchedules.id, assetId: pmSchedules.assetId })
    .from(pmSchedules).where(eq(pmSchedules.procedureId, procedureId));
  const assetIds = stamped.map((r) => r.assetId).filter((x): x is number => x !== null);
  let repointed = 0;
  if (assetIds.length) {
    const units = await db.select({ id: assets.id, model: assets.model }).from(assets)
      .where(inArray(assets.id, assetIds));
    const mine = new Set(units.filter((a) => a.model.toLowerCase() === m.toLowerCase()).map((a) => a.id));
    const ids = stamped.filter((r) => r.assetId !== null && mine.has(r.assetId)).map((r) => r.id);
    if (ids.length) {
      await db.update(pmSchedules).set({ procedureId: copy.id }).where(inArray(pmSchedules.id, ids));
      repointed = ids.length;
    }
  }

  await audit({
    actor: u.email, entityType: "procedure", entityId: copy.id,
    action: `split "${clean.name}" (${orig.assetType}) off for ${m} only - the shared version now covers `
      + `${keep.length} model${keep.length === 1 ? "" : "s"}${orig.modelScope.length ? "" : " (was: every model)"}`
      + `${repointed ? `; ${repointed} schedule${repointed === 1 ? "" : "s"} follow${repointed === 1 ? "s" : ""} the ${m} version` : ""}`,
  });
  revalidatePath("/settings/procedures");
  revalidatePath("/maintenance");
  return { newId: copy.id, repointed };
}

export async function updateProcedure(
  procedureId: number,
  data: ProcedureInput,
  // "Also apply to existing units now" - the sheet's opt-in when the TIMING
  // changed. Without it, edits touch new units only; schedules already on
  // units keep running as they were.
  applyNow = false,
): Promise<{ error?: string; applied?: number; retimed?: number; unscheduled?: number }> {
  const u = await requireStaff();
  const [before] = await db.select().from(procedures).where(eq(procedures.id, procedureId));
  if (!before) return { error: "Not found" };
  const clean = cleanProcedure({ ...data, assetType: before.assetType }); // type is fixed at creation
  if ("error" in clean) return clean;
  // An edit that doesn't mention provenance must not silently un-classify the
  // row: cleanProcedure defaults it to '' (unreviewed), which for a procedure
  // somebody has already cleared would quietly drop it out of the licensable
  // set. Absent means "leave it"; only an explicit value changes it.
  if (data.provenance === undefined) clean.provenance = before.provenance;
  const siblings = await db.select().from(procedures).where(eq(procedures.assetType, before.assetType));
  if (siblings.some((i) => i.id !== procedureId && i.kind === clean.kind && i.name.toLowerCase() === clean.name.toLowerCase()
      && sameScope(i, clean)))
    return { error: `"${clean.name}" already exists for this type` };
  await db.update(procedures).set(clean).where(eq(procedures.id, procedureId));
  await audit({
    actor: u.email, entityType: "procedure", entityId: procedureId,
    action: `edited ${clean.kind} procedure "${clean.name}" for ${before.assetType} - ${procTimingLabel(clean)}${procScopeLabel(scopeOf(clean))}`,
    field: "procedure",
    oldValue: `${before.kind} | ${before.name} | ${procTimingLabel(before)} | ${scopeOf(before).join(", ")}`,
    newValue: `${clean.kind} | ${clean.name} | ${procTimingLabel(clean)} | ${scopeOf(clean).join(", ")}`,
  });

  const addedRepeat = before.intervalDays === null && clean.intervalDays !== null;
  const removedRepeat = before.intervalDays !== null && clean.intervalDays === null;
  const changedInterval = before.intervalDays !== null && clean.intervalDays !== null && before.intervalDays !== clean.intervalDays;
  let applied = 0, retimed = 0, unscheduled = 0;
  if (applyNow && addedRepeat) {
    applied = await backfillProcedure(before.assetType, shopToday(), u.email, myTenantOrgId(u));
  }
  if (applyNow && changedInterval) {
    // Re-time the schedules this procedure stamped out: keep their history,
    // move the next occurrence to one new cadence after the last completion
    // (or after today, for ones never yet done).
    const children = await db.select().from(pmSchedules).where(eq(pmSchedules.procedureId, procedureId));
    const today = shopToday();
    for (const c of children) {
      const nextDue = addDays(c.lastDone || today, clean.intervalDays!);
      await db.update(pmSchedules).set({ everyDays: clean.intervalDays!, nextDue }).where(eq(pmSchedules.id, c.id));
      retimed++;
    }
    if (retimed) {
      await audit({
        actor: u.email, entityType: "procedure", entityId: procedureId,
        action: `re-timed ${retimed} existing schedule(s) of "${clean.name}" to ${cadenceLabel(clean.intervalDays!)}`,
      });
    }
  }
  if (applyNow && removedRepeat) {
    // Opt-in removal of the schedules this procedure stamped out. Their
    // generated tasks survive (the task FK goes null), and hand-written
    // schedules are untouched - they were never the catalog's to remove.
    const children = await db.select().from(pmSchedules).where(eq(pmSchedules.procedureId, procedureId));
    for (const c of children) {
      await db.delete(pmSchedules).where(eq(pmSchedules.id, c.id));
      unscheduled++;
    }
    if (unscheduled) {
      await audit({
        actor: u.email, entityType: "procedure", entityId: procedureId,
        action: `unscheduled "${clean.name}" from ${unscheduled} unit(s) - tasks already created stay`,
      });
    }
  }
  revalidatePath("/settings/procedures");
  revalidatePath("/maintenance");
  rev();
  return { applied, retimed, unscheduled };
}

export async function deleteProcedure(procedureId: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [i] = await db.select().from(procedures).where(eq(procedures.id, procedureId));
  if (!i) return {};
  // Schedules and tasks already on units survive - the FK goes null and they
  // belong to their units now.
  await db.delete(procedures).where(eq(procedures.id, procedureId));
  await audit({
    actor: u.email, entityType: "procedure", entityId: procedureId,
    action: `removed ${i.kind} procedure "${i.name}" for ${i.assetType} (${procTimingLabel(i)})${procScopeLabel(i.modelScope)} - work already on units stays`,
  });
  revalidatePath("/settings/procedures");
  revalidatePath("/maintenance");
  return {};
}

// ---------------- Sign-off ----------------

/**
 * Resolve the gate for a target from live data. Both the page and the sign
 * action call this - the action recomputes rather than trusting anything the
 * browser sent, because the gate IS the meaning of the signature.
 *
 * A system's gate spans its own work AND the work on its installed assets: a
 * pump with a failed test is not a shippable system.
 */
async function gateFor(target: WorkTarget) {
  let taskRows: (typeof tasks.$inferSelect)[] = [];
  if (target.instrumentId !== null) {
    const installed = await db.select({ id: assets.id }).from(assets).where(eq(assets.instrumentId, target.instrumentId));
    const ids = installed.map((a) => a.id);
    taskRows = await db.select().from(tasks).where(
      ids.length ? or(eq(tasks.instrumentId, target.instrumentId), inArray(tasks.assetId, ids))
        : eq(tasks.instrumentId, target.instrumentId)
    );
  } else if (target.assetId !== null) {
    taskRows = await db.select().from(tasks).where(eq(tasks.assetId, target.assetId));
  }
  const procIds = [...new Set(taskRows.flatMap((t) => (t.procedureId !== null ? [t.procedureId] : [])))];
  const procRows = procIds.length
    ? await db.select({ id: procedures.id, kind: procedures.kind, required: procedures.required })
        .from(procedures).where(inArray(procedures.id, procIds))
    : [];
  const taskIds = taskRows.map((t) => t.id);
  const reportRows = taskIds.length
    ? await db.select({ taskId: attachments.taskId }).from(attachments).where(inArray(attachments.taskId, taskIds))
    : [];
  const reportsByTask = new Map<number, number>();
  for (const r of reportRows) {
    if (r.taskId !== null) reportsByTask.set(r.taskId, (reportsByTask.get(r.taskId) ?? 0) + 1);
  }
  // A recorded reading is evidence too - see lib/signoff. Before there was
  // anywhere to put the number, a file was the closest thing available.
  const resultRows = taskIds.length
    ? await db.select({ taskId: taskResults.taskId }).from(taskResults).where(inArray(taskResults.taskId, taskIds))
    : [];
  for (const r of resultRows) reportsByTask.set(r.taskId, (reportsByTask.get(r.taskId) ?? 0) + 1);
  return signoffGate(
    taskRows.map((t) => {
      const p = procRows.find((x) => x.id === t.procedureId);
      return { id: t.id, title: t.title, state: t.state, required: p?.required ?? false, kind: p?.kind ?? "task" };
    }),
    reportsByTask,
  );
}

export async function signOffTarget(
  target: WorkTarget,
  data: { signerName: string; signerTitle: string; meaning: string; note: string },
): Promise<{ error?: string }> {
  // The house releases equipment; a client signing their own acceptance is a
  // different document and not this one.
  const u = await requireStaff();
  const t0 = await resolveTarget(target);
  if ("error" in t0) return t0;
  // Typing your own name is the act of signing - an empty box is not a signature.
  const signerName = data.signerName.trim();
  if (signerName.length < 2) return { error: "Type your full name to sign" };
  const gate = await gateFor(target);
  if (!gate.ready) return { error: `Not ready to sign: ${gate.blockers.map((b) => b.text).join("; ")}` };
  const existing = await db.select().from(signoffs).where(
    and(
      target.instrumentId !== null ? eq(signoffs.instrumentId, target.instrumentId) : eq(signoffs.assetId, target.assetId!),
      isNull(signoffs.revokedAt),
    )
  );
  if (existing.some((e) => e.signedBy.toLowerCase() === u.email.toLowerCase())) {
    return { error: "You have already signed this" };
  }
  const [row] = await db.insert(signoffs).values({
    instrumentId: t0.instrumentId, assetId: t0.instrumentId === null ? t0.assetId : null,
    signedBy: u.email, signerName, signerTitle: data.signerTitle.trim(),
    meaning: data.meaning.trim() || "Approved for release",
    note: data.note.trim(), data: snapshotOf(gate),
  }).returning();
  await audit({
    actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId, entityType: "signoff", entityId: row.id,
    action: `signed off ${targetLabel(t0.externalId, t0.asset)} as "${signerName}" - ${row.meaning} (${gate.tasksDone}/${gate.tasksTotal} tasks, ${gate.requiredTests.length} mandatory test${gate.requiredTests.length === 1 ? "" : "s"} evidenced)`,
  });
  revWork({ instrumentId: t0.instrumentId, assetId: t0.assetId });
  return {};
}

/**
 * Withdraw a signature. Kept, not deleted, with a reason - the fact that
 * something was signed and then withdrawn is exactly the kind of history a
 * sign-off record exists to hold.
 */
export async function revokeSignoff(signoffId: number, reason: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [row] = await db.select().from(signoffs).where(eq(signoffs.id, signoffId));
  if (!row || row.revokedAt) return {};
  await db.update(signoffs).set({ revokedAt: new Date(), revokedBy: u.email, revokedReason: why })
    .where(eq(signoffs.id, signoffId));
  await audit({
    actor: u.email, instrumentId: row.instrumentId, assetId: row.assetId, entityType: "signoff", entityId: signoffId,
    action: `withdrew ${row.signerName}'s sign-off - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revWork({ instrumentId: row.instrumentId, assetId: row.assetId });
  return {};
}

/** File an uploaded document as the evidence for one task, or unfile it. */
export async function setAttachmentTask(attachmentId: number, taskId: number | null): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [a] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  if (!a) return { error: "Not found" };
  await assertWorkEditable(u, a);
  if (taskId !== null) {
    // The task has to belong to the same system or unit as the file, or a
    // report could be filed as evidence for work it has nothing to do with.
    const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    if (!t) return { error: "Not found" };
    const sameSystem = a.instrumentId !== null && t.instrumentId === a.instrumentId;
    const sameAsset = a.assetId !== null && t.assetId === a.assetId;
    if (!sameSystem && !sameAsset) return { error: "That task belongs to something else" };
  }
  await db.update(attachments).set({ taskId }).where(eq(attachments.id, attachmentId));
  const [t] = taskId !== null ? await db.select().from(tasks).where(eq(tasks.id, taskId)) : [];
  await audit({
    actor: u.email, instrumentId: a.instrumentId, assetId: a.assetId, entityType: "attachment", entityId: attachmentId,
    action: t ? `filed ${a.fileName} as the report for '${t.title}'` : `unfiled ${a.fileName} from its task`,
  });
  revWork(a);
  return {};
}

/** Persist a drag-reorder within one asset type's list. */
export async function reorderProcedures(assetType: string, orderedIds: number[]) {
  const u = await requireStaff();
  if (!validProcedureType(assetType)) return;
  const siblings = await db.select().from(procedures).where(eq(procedures.assetType, assetType));
  const known = new Map(siblings.map((i) => [i.id, i]));
  let position = 1;
  for (const id of orderedIds) {
    const item = known.get(id);
    if (!item) continue; // ignore ids from other types or stale UIs
    if (item.position !== position) {
      await db.update(procedures).set({ position }).where(eq(procedures.id, id));
    }
    position++;
  }
  await audit({
    actor: u.email, entityType: "procedure", entityId: assetType,
    action: `reordered the ${assetType} procedure list`,
  });
  revalidatePath("/settings/procedures");
}

// ---------------- Validation documents ----------------
// The validation shelf of a regulated system. The lifecycle rules live in
// lib/gxp and are enforced HERE, not just hidden in the UI - "the protocol
// was approved before it ran" is a server-checked fact or it is nothing.

/** Doc + the caller's right to touch it. Staff manage validation paper. */
async function validationDocAccess(docId: number) {
  const u = await requireStaff();
  const [d] = await db.select().from(validationDocs).where(eq(validationDocs.id, docId));
  if (!d) return { error: "Not found" as const };
  await assertSystemVisible(u, d.instrumentId);
  return { u, d };
}

const activeSignatures = async (docId: number) =>
  (await db.select().from(validationSignatures)
    .where(and(eq(validationSignatures.docId, docId), isNull(validationSignatures.revokedAt))));

export async function addValidationDoc(
  instrumentId: number,
  data: { docType: string; title: string; attachmentId: number | null; reviewOn: string; note: string; supersedesId?: number | null },
): Promise<{ error?: string; id?: number }> {
  const u = await requireStaff();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  await assertSystemVisible(u, instrumentId);
  const docType = (DOC_TYPES as readonly string[]).find((t) => t.toLowerCase() === data.docType.trim().toLowerCase());
  if (!docType) return { error: "Pick a document type" };
  const title = data.title.trim();
  if (!title || title.length > 160) return { error: "Title must be 1-160 characters" };
  const reviewOn = isIsoDay(data.reviewOn) ? data.reviewOn : "";
  if (data.attachmentId !== null) {
    // A linked file must be this system's own paper.
    const [a] = await db.select().from(attachments).where(eq(attachments.id, data.attachmentId));
    if (!a || a.instrumentId !== instrumentId) return { error: "That file belongs to another record" };
  }

  // A revision supersedes; it never replaces. The old version keeps its state
  // history under the version number it was approved as.
  let version = 1;
  const supersedesId = data.supersedesId ?? null;
  if (supersedesId !== null) {
    const [old] = await db.select().from(validationDocs).where(eq(validationDocs.id, supersedesId));
    if (!old || old.instrumentId !== instrumentId) return { error: "Not found" };
    if (old.state === "Superseded") return { error: "That version is already superseded - revise the current one" };
    version = old.version + 1;
    await db.update(validationDocs).set({ state: "Superseded" }).where(eq(validationDocs.id, supersedesId));
  }

  const [row] = await db.insert(validationDocs).values({
    instrumentId, docType, title, state: "Draft", version, supersedesId,
    attachmentId: data.attachmentId, reviewOn, note: data.note.trim(),
    createdBy: u.email, tenantOrgId: inst.tenantOrgId,
  }).returning();
  await audit({
    actor: u.email, instrumentId, entityType: "validation", entityId: row.id,
    action: supersedesId !== null
      ? `revised ${docType} '${title}' to v${version} (v${version - 1} superseded)`
      : `filed ${docType} '${title}' as Draft`,
  });
  revalidatePath(`/instruments/${instrumentId}`);
  return { id: row.id };
}

/**
 * Sign a validation document in a role. Typing your name is the act of
 * signing. The Approved role is the one with teeth: it is refused anywhere but
 * Draft, and landing it moves the document to Approved.
 */
export async function signValidationDoc(
  docId: number, data: { role: string; signerName: string; signerTitle: string; note: string },
): Promise<{ error?: string }> {
  const acc = await validationDocAccess(docId);
  if ("error" in acc) return acc;
  const { u, d } = acc;
  const role = (SIG_ROLES as readonly string[]).includes(data.role) ? data.role : "Approved";
  const signerName = data.signerName.trim();
  if (signerName.length < 2) return { error: "Type your full name to sign" };
  if (d.state === "Superseded") return { error: "This version is superseded - sign the current one" };
  if (role === "Approved" && !canApprove(d)) {
    return { error: `Only a Draft can be approved - this is ${d.state}` };
  }
  const sigs = await activeSignatures(docId);
  if (sigs.some((x) => x.role === role && x.signedBy.toLowerCase() === u.email.toLowerCase())) {
    return { error: `You have already signed as ${role}` };
  }
  await db.insert(validationSignatures).values({
    docId, role, signedBy: u.email, signerName,
    signerTitle: data.signerTitle.trim(), note: data.note.trim(),
  });
  if (role === "Approved") {
    await db.update(validationDocs).set({ state: "Approved" }).where(eq(validationDocs.id, docId));
  }
  await audit({
    actor: u.email, instrumentId: d.instrumentId, entityType: "validation", entityId: docId,
    action: `signed ${d.docType} '${d.title}' v${d.version} as ${role} ("${signerName}")${role === "Approved" ? " - now Approved" : ""}`,
  });
  revalidatePath(`/instruments/${d.instrumentId}`);
  return {};
}

/**
 * Withdraw a signature, with a reason, keeping the row - a signature that was
 * given and taken back is exactly the history this shelf exists to hold.
 * Pulling the last approval returns the document to Draft; once Executed the
 * record moves forward by superseding, never by un-signing.
 */
export async function revokeValidationSignature(sigId: number, reason: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [sig] = await db.select().from(validationSignatures).where(eq(validationSignatures.id, sigId));
  if (!sig || sig.revokedAt !== null) return { error: "Not found" };
  const [d] = await db.select().from(validationDocs).where(eq(validationDocs.id, sig.docId));
  if (!d) return { error: "Not found" };
  await assertSystemVisible(u, d.instrumentId);
  const why = reason.trim();
  if (!why) return { error: "Say why - a signature withdrawn without a reason is a record with a hole in it" };
  if (sig.role === "Approved" && !canRevokeApproval(d)) {
    return { error: "This version has been executed - revise it instead of un-signing it" };
  }
  await db.update(validationSignatures).set({ revokedAt: new Date(), revokeReason: why })
    .where(eq(validationSignatures.id, sigId));
  if (sig.role === "Approved") {
    const stillApproved = (await activeSignatures(d.id)).some((x) => x.role === "Approved");
    if (!stillApproved && d.state === "Approved") {
      await db.update(validationDocs).set({ state: "Draft" }).where(eq(validationDocs.id, d.id));
    }
  }
  await audit({
    actor: u.email, instrumentId: d.instrumentId, entityType: "validation", entityId: d.id,
    action: `withdrew ${sig.role} signature ("${sig.signerName}") from ${d.docType} '${d.title}' v${d.version} - reason: ${why}`,
  });
  revalidatePath(`/instruments/${d.instrumentId}`);
  return {};
}

/** An approved protocol has been run. The readings and reports are the evidence. */
export async function markValidationDocExecuted(docId: number): Promise<{ error?: string }> {
  const acc = await validationDocAccess(docId);
  if ("error" in acc) return acc;
  const { u, d } = acc;
  if (!canExecute(d)) {
    return { error: isProtocol(d.docType)
      ? `Approve it first - executing a ${d.state} protocol is the finding auditors look for`
      : "Only protocols get executed - reports are approved after writing" };
  }
  await db.update(validationDocs).set({ state: "Executed" }).where(eq(validationDocs.id, docId));
  await audit({
    actor: u.email, instrumentId: d.instrumentId, entityType: "validation", entityId: docId,
    action: `marked ${d.docType} '${d.title}' v${d.version} executed`,
  });
  revalidatePath(`/instruments/${d.instrumentId}`);
  return {};
}

/** Only an unsigned Draft. Anything further along supersedes instead. */
export async function deleteValidationDoc(docId: number, reason: string): Promise<{ error?: string }> {
  const acc = await validationDocAccess(docId);
  if ("error" in acc) return acc;
  const { u, d } = acc;
  const sigs = await activeSignatures(docId);
  if (!canDelete(d, sigs.length)) {
    return { error: "Only an unsigned Draft can be removed - supersede this with a revision instead" };
  }
  const why = reason.trim();
  if (!why) return { error: "Say why" };
  await db.delete(validationDocs).where(eq(validationDocs.id, docId));
  await audit({
    actor: u.email, instrumentId: d.instrumentId, entityType: "validation", entityId: docId,
    action: `removed draft ${d.docType} '${d.title}' - reason: ${why}`,
  });
  revalidatePath(`/instruments/${d.instrumentId}`);
  return {};
}

/** Which validation documents a kind of equipment owes - the catalog card. */
export async function setCatalogDocTypes(termId: number, docTypes: string[]): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [term] = await db.select().from(vocabTerms).where(eq(vocabTerms.id, termId));
  if (!term) return { error: "Not found" };
  const t = readTenant(u);
  if (t !== null && term.tenantOrgId !== t) return { error: "Not found" };
  const clean = docTypes
    .map((x) => (DOC_TYPES as readonly string[]).find((k) => k.toLowerCase() === x.trim().toLowerCase()))
    .filter((x): x is string => !!x);
  await db.update(vocabTerms).set({ docTypes: clean }).where(eq(vocabTerms.id, termId));
  await audit({
    actor: u.email, entityType: "vocab", entityId: termId,
    action: `set validation package for ${term.kind === "category" ? "system type" : term.kind === "asset_type" ? "module type" : "model"} ${term.name}: ${clean.join(", ") || "none"}`,
    field: "docTypes", oldValue: term.docTypes.join(", "), newValue: clean.join(", "),
  });
  revalidatePath("/settings/catalog");
  return {};
}

// ---------------- Direct messages ----------------
// Person-to-person conversations, as opposed to discussion posts, which belong
// to a system. Membership is the whole access rule: you can read a thread if
// and only if you are in it, and you may only start one with people your
// directory already shows you.

/** Your membership row, or null when the thread is not yours to read. */
async function threadSeat(threadId: number, email: string) {
  const [seat] = await db.select().from(threadMembers)
    .where(and(eq(threadMembers.threadId, threadId), eq(threadMembers.email, email.toLowerCase())));
  return seat && !seat.leftAt ? seat : null;
}

/** The directory, which is exactly who this person may write to. */
async function messageable(u: SessionUser) {
  return messageableFrom(await visibleDirectory(u), u.email);
}

export async function startThread(
  emails: string[], data: { title: string; body: string },
): Promise<{ error?: string; id?: number }> {
  const u = await requireUser();
  const allowed = await messageable(u);
  const want = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!want.length) return { error: "Pick somebody to write to" };
  // Every recipient has to be somebody this person may already see. Silently
  // dropping a stranger would create a thread quietly missing a member.
  const picked = want.map((e) => allowed.find((a) => a.email.toLowerCase() === e));
  if (picked.some((p) => !p)) return { error: "You can only message people you work with" };
  const clean = cleanBody(data.body);
  if ("error" in clean) return clean;

  const [thread] = await db.insert(messageThreads).values({
    tenantOrgId: myTenantOrgId(u),
    title: data.title.trim().slice(0, 80),
    createdBy: u.email, lastMessageAt: new Date(),
  }).returning();

  const now = new Date();
  await db.insert(threadMembers).values([
    // The author starts read - they have just written the only message in it.
    { threadId: thread.id, email: u.email.toLowerCase(), name: u.name || u.email, orgName: u.orgName ?? "", addedBy: u.email, lastReadAt: now },
    ...picked.map((p) => ({
      threadId: thread.id, email: p!.email.toLowerCase(), name: p!.name, orgName: p!.org, addedBy: u.email,
    })),
  ]);
  await db.insert(messages).values({
    threadId: thread.id, authorEmail: u.email, authorName: u.name || u.email, body: clean.body,
  });
  await notifyMessage({
    to: picked.map((p) => p!.email), threadId: thread.id,
    fromName: u.name || u.email, body: clean.body,
    title: data.title.trim(), memberCount: picked.length + 1,
  });
  revalidatePath("/messages");
  return { id: thread.id };
}

export async function sendMessage(threadId: number, body: string): Promise<{ error?: string }> {
  const u = await requireUser();
  const seat = await threadSeat(threadId, u.email);
  if (!seat) return { error: "Not found" };
  const clean = cleanBody(body);
  if ("error" in clean) return clean;
  const now = new Date();
  await db.insert(messages).values({
    threadId, authorEmail: u.email, authorName: u.name || u.email, body: clean.body,
  });
  await db.update(messageThreads).set({ lastMessageAt: now }).where(eq(messageThreads.id, threadId));
  // Writing is reading: your own message must never come back as unread.
  await db.update(threadMembers).set({ lastReadAt: now }).where(eq(threadMembers.id, seat.id));
  const others = await db.select().from(threadMembers)
    .where(and(eq(threadMembers.threadId, threadId), isNull(threadMembers.leftAt)));
  const [thread] = await db.select().from(messageThreads).where(eq(messageThreads.id, threadId));
  await notifyMessage({
    to: others.filter((o) => o.email !== u.email.toLowerCase()).map((o) => o.email),
    threadId, fromName: u.name || u.email, body: clean.body,
    title: thread?.title ?? "", memberCount: others.length,
  });
  revalidatePath("/messages");
  revalidatePath(`/messages/${threadId}`);
  return {};
}

/** Opening a conversation is reading it. Idempotent, called on every view. */
export async function markMessagesRead(threadId: number): Promise<void> {
  const u = await requireUser();
  const seat = await threadSeat(threadId, u.email);
  if (!seat) return;
  await db.update(threadMembers).set({ lastReadAt: new Date() }).where(eq(threadMembers.id, seat.id));
  revalidatePath("/messages");
}

/** Add somebody to a thread already running. They see what was said before. */
export async function addToThread(threadId: number, email: string): Promise<{ error?: string }> {
  const u = await requireUser();
  const seat = await threadSeat(threadId, u.email);
  if (!seat) return { error: "Not found" };
  const allowed = await messageable(u);
  const person = allowed.find((a) => a.email.toLowerCase() === email.trim().toLowerCase());
  if (!person) return { error: "You can only add people you work with" };
  const [existing] = await db.select().from(threadMembers)
    .where(and(eq(threadMembers.threadId, threadId), eq(threadMembers.email, person.email.toLowerCase())));
  if (existing && !existing.leftAt) return { error: `${person.name} is already here` };
  if (existing) {
    await db.update(threadMembers).set({ leftAt: null, addedBy: u.email }).where(eq(threadMembers.id, existing.id));
  } else {
    await db.insert(threadMembers).values({
      threadId, email: person.email.toLowerCase(), name: person.name, orgName: person.org, addedBy: u.email,
    });
  }
  // Said in the room, because a new pair of eyes on a conversation is
  // something the people already in it should not have to notice for
  // themselves.
  await db.insert(messages).values({
    threadId, authorEmail: u.email, authorName: u.name || u.email,
    body: `${u.name || u.email} added ${person.name} to the conversation.`,
  });
  await db.update(messageThreads).set({ lastMessageAt: new Date() }).where(eq(messageThreads.id, threadId));
  revalidatePath(`/messages/${threadId}`);
  return {};
}

/** Leave. What was said stays - the others' copy is not yours to remove. */
export async function leaveThread(threadId: number): Promise<{ error?: string }> {
  const u = await requireUser();
  const seat = await threadSeat(threadId, u.email);
  if (!seat) return { error: "Not found" };
  await db.update(threadMembers).set({ leftAt: new Date() }).where(eq(threadMembers.id, seat.id));
  await db.insert(messages).values({
    threadId, authorEmail: u.email, authorName: u.name || u.email,
    body: `${u.name || u.email} left the conversation.`,
  });
  revalidatePath("/messages");
  return {};
}

/** Take back your own message. Kept as a tombstone, never erased. */
export async function deleteMessage(messageId: number): Promise<{ error?: string }> {
  const u = await requireUser();
  const [m] = await db.select().from(messages).where(eq(messages.id, messageId));
  if (!m) return { error: "Not found" };
  if (m.authorEmail.toLowerCase() !== u.email.toLowerCase()) return { error: "Only the author can take a message back" };
  if (!(await threadSeat(m.threadId, u.email))) return { error: "Not found" };
  await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, messageId));
  revalidatePath(`/messages/${m.threadId}`);
  return {};
}

/** Everyone this person may start a conversation with, for the picker. */
export async function listMessageable(): Promise<{ people: { name: string; email: string; org: string }[] }> {
  const u = await requireUser();
  return { people: await messageable(u) };
}

// ---------------- Stage vocabulary ----------------

const HEX = /^#[0-9a-fA-F]{6}$/;

export async function addStage(name: string, bg: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const n = name.trim();
  if (!n || n.length > 40) return { error: "Stage name must be 1-40 characters" };
  if (!HEX.test(bg)) return { error: "Pick a color" };
  const existing = await db.select().from(stageDefs);
  if (existing.some((s) => s.name.toLowerCase() === n.toLowerCase())) return { error: `"${n}" already exists` };
  const sortOrder = Math.max(0, ...existing.map((s) => s.sortOrder)) + 1;
  await db.insert(stageDefs).values({ tenantOrgId: myTenantOrgId(u), name: n, bg: bg.toUpperCase(), fg: autoFg(bg), sortOrder }).onConflictDoNothing();
  await audit({ actor: u.email, entityType: "settings", entityId: n, action: `added stage "${n}"` });
  revalidatePath("/settings");
  rev();
  return {};
}

export async function setStageColor(id: number, bg: string) {
  const u = await requireOwner();
  if (!HEX.test(bg)) return;
  const [s] = await db.select().from(stageDefs).where(eq(stageDefs.id, id));
  if (!s || s.bg === bg.toUpperCase()) return;
  await db.update(stageDefs).set({ bg: bg.toUpperCase(), fg: autoFg(bg) }).where(eq(stageDefs.id, id));
  await audit({
    actor: u.email, entityType: "settings", entityId: s.name,
    action: `recolored stage "${s.name}"`, field: "bg", oldValue: s.bg, newValue: bg.toUpperCase(),
  });
  revalidatePath("/settings");
  rev();
}

export async function renameStage(id: number, name: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const n = name.trim();
  if (!n || n.length > 40) return { error: "Stage name must be 1-40 characters" };
  const [s] = await db.select().from(stageDefs).where(eq(stageDefs.id, id));
  if (!s || s.name === n) return {};
  if (s.builtin) return { error: "Built-in stages can't be renamed - sync and reports key on their names" };
  const existing = await db.select().from(stageDefs);
  if (existing.some((x) => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) return { error: `"${n}" already exists` };
  await db.update(stageDefs).set({ name: n }).where(eq(stageDefs.id, id));
  // Carry the rename onto every instrument tagged with the old name.
  const insts = await db.select().from(instruments);
  for (const i of insts) {
    if (!i.stages.includes(s.name)) continue;
    await db.update(instruments)
      .set({ stages: i.stages.map((x) => (x === s.name ? n : x)), updatedAt: new Date() })
      .where(eq(instruments.id, i.id));
  }
  await audit({
    actor: u.email, entityType: "settings", entityId: n,
    action: `renamed stage "${s.name}" to "${n}"`, field: "name", oldValue: s.name, newValue: n,
  });
  revalidatePath("/settings");
  rev();
  return {};
}

export async function deleteStage(id: number): Promise<{ error?: string }> {
  const u = await requireOwner();
  const [s] = await db.select().from(stageDefs).where(eq(stageDefs.id, id));
  if (!s) return {};
  if (s.builtin) return { error: "Built-in stages can't be deleted - sync and reports key on their names" };
  await db.delete(stageDefs).where(eq(stageDefs.id, id));
  // Strip it from any instruments; keep the at-least-one-stage invariant.
  const insts = await db.select().from(instruments);
  for (const i of insts) {
    if (!i.stages.includes(s.name)) continue;
    const next = i.stages.filter((x) => x !== s.name);
    await db.update(instruments)
      .set({ stages: next.length ? next : ["Intake"], updatedAt: new Date() })
      .where(eq(instruments.id, i.id));
    await db.insert(stageEvents).values({ instrumentId: i.id, stage: s.name, kind: "removed" });
    if (!next.length) await db.insert(stageEvents).values({ instrumentId: i.id, stage: "Intake", kind: "added" });
  }
  await audit({ actor: u.email, entityType: "settings", entityId: s.name, action: `deleted stage "${s.name}"` });
  revalidatePath("/settings");
  rev();
  return {};
}

/** Who the EOD "Send to LabZen" button emails. Comma-separated. */
/** Who receives one organization's daily report. Each client has its own list. */
/**
 * Set an organization's file-storage ceiling, in megabytes. 0 removes it.
 * Owner-only: this is the commercial dial, and lowering it is the one setting
 * on this page that can stop somebody working - so the refusal below names what
 * they are already holding rather than silently accepting a limit they've
 * already blown past.
 */
// ---------------- Remote support ----------------

/**
 * Whether an organization's own editors may reach their own machines. The house
 * always can - that is the service being sold - so this is the client
 * self-service tier and nothing else. Owner-only, like every other commercial
 * dial on that page.
 */
/**
 * The gate on administering one organization: its dials, its people, its
 * existence. An operator's staff administer their own clients and nobody else's -
 * not another operator, and not another operator's client, however the id arrives.
 *
 * Owner-only used to be the rule because there was one service company on the
 * instance and one owner of it. What matters now is WHICH company, so the check
 * is per-organization; being an owner elsewhere is not a key to this.
 */
async function adminOrgGate(u: SessionUser, orgId: number): Promise<
  { error: string } | { org: typeof orgs.$inferSelect }
> {
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };
  if (!mayAdminOrg(tenantViewer(u), org)) return { error: "Not found" };
  return { org };
}

export async function setOrgRemoteAccess(orgId: number, on: boolean): Promise<{ error?: string }> {
  const u = await requireStaff();
  const gate = await adminOrgGate(u, orgId);
  if ("error" in gate) return gate;
  const { org } = gate;
  await db.update(orgs).set({ remoteAccessEnabled: on }).where(eq(orgs.id, orgId));
  await audit({
    actor: u.email, entityType: "settings", entityId: orgId,
    action: `turned remote support for ${org.name} ${on ? "on" : "off"}`,
    field: "remoteAccessEnabled", oldValue: String(org.remoteAccessEnabled), newValue: String(on),
  });
  revalidatePath("/", "layout");
  revalidatePath("/settings");
  revalidatePath("/remote");
  return {};
}

/**
 * Whether this organization's records offer resale controls at all.
 *
 * Off by default. A lab that services four instruments will never list one for
 * sale, and a control nobody presses still has to be read past on every page.
 */
export async function setOrgResale(orgId: number, on: boolean): Promise<{ error?: string }> {
  const u = await requireStaff();
  const gate = await adminOrgGate(u, orgId);
  if ("error" in gate) return gate;
  const { org } = gate;
  await db.update(orgs).set({ resaleEnabled: on }).where(eq(orgs.id, orgId));
  await audit({
    actor: u.email, entityType: "settings", entityId: orgId,
    action: `turned resale listings for ${org.name} ${on ? "on" : "off"}`,
    field: "resaleEnabled", oldValue: String(org.resaleEnabled), newValue: String(on),
  });
  revalidatePath("/", "layout");
  revalidatePath("/settings");
  return {};
}

/**
 * An installer link that joins one organization's device group. Staff-only: this
 * is a capability to enroll a machine, and handing it out is our act, not a
 * client's. Short-lived by construction on the engine side.
 */
export async function enrollRemoteDevice(
  orgId: number,
): Promise<{ error?: string; url?: string; orgName?: string }> {
  const u = await requireStaff();
  if (!mayEnroll(u, { moduleOn: (await getModules()).remote })) return { error: "Remote support is off" };
  if (!remoteConfigured()) return { error: NOT_CONFIGURED };
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };
  const group = await ensureOrgGroup(orgId);
  if ("error" in group) return group;
  const made = await agentInstallerLink(group.groupId);
  if (!made) return { error: "Couldn't reach the remote-support host to build an installer." };
  // An installer joins exactly one client's roster. If the host built one for a
  // different group than we asked for, that is a machine filed under the wrong
  // client, so refuse rather than hand over a link that looks fine.
  if (made.groupId && made.groupId !== group.groupId) {
    return { error: `The host built an installer for the wrong group; nothing was handed out. Tell whoever runs the portal.` };
  }
  await audit({
    actor: u.email, entityType: "remote", entityId: orgId,
    action: `generated a remote-support installer for ${org.name}`,
  });
  return { url: made.url, orgName: org.name };
}

/**
 * Open a session. The order here is the point: decide, then WRITE IT DOWN, then
 * mint. An unused token is a non-event; an unaudited connection to a customer's
 * instrument PC is the thing this module exists to make impossible.
 *
 * Called by the session page rather than from a browser, so the whole pipeline -
 * permission, consent, audit, token - runs once per session in one place, and the
 * page renders the result. `embedded` asks for a URL suited to our own frame.
 */
export async function connectRemoteDevice(
  deviceId: number, opts: { embedded?: boolean } = {},
): Promise<{ error?: string; url?: string }> {
  const u = await requireUser();
  const { remote: moduleOn } = await getModules();
  const row = await deviceWithOrg(deviceId);
  if (!row) return { error: "Not found" };
  const { device } = row;

  // A persona may look at a client's remote view but never reach through it.
  const { persona } = await viewContext();
  const ability = remoteAbility(
    u, { moduleOn, personaActive: persona !== null },
    { orgId: device.orgId, tenantOrgId: device.tenantOrgId }, { remoteAccessEnabled: row.orgRemote ?? false },
  );
  if (!ability.see) return { error: "Not found" };
  if (!ability.connect) return { error: ability.refusal || "You can't connect to this machine." };

  const [system] = device.instrumentId === null ? [] : await db
    .select({ ownerOrgId: instruments.ownerOrgId, stages: instruments.stages, externalId: instruments.externalId })
    .from(instruments).where(eq(instruments.id, device.instrumentId));
  const consent = consentModeFor(device, system ?? null);

  // Tell the engine what the far end should see, before anything is reachable.
  // A machine that must ask first and can't be told to ask does not get
  // connected to; one that needn't ask and can't be told so is only left
  // prompting, which is the harmless direction to fail in.
  const applied = await applyDeviceConsent(device.nodeId, consent.mode);
  if (applied.error && consent.mode === "consent") {
    return { error: `This machine has to ask its user first, and the host couldn't be told to: ${applied.error}` };
  }

  const where = system?.externalId ? ` on ${system.externalId}` : "";
  await audit({
    actor: u.email, instrumentId: device.instrumentId, entityType: "remote", entityId: device.id,
    action: `opened a remote session to ${device.name || "a machine"}${where}`
      + ` at ${row.orgName ?? "an unassigned organization"}`
      + ` (${consent.mode === "consent" ? "consent required" : "unattended"}: ${consent.why})`,
  });

  const url = connectUrl(device.nodeId, { embedded: opts.embedded === true });
  if (typeof url !== "string") return url;
  return { url };
}

// ---------------- Work orders ----------------
// One job, from the ask to the close-out.
//
// The lifecycle - which states exist and who may move between them - is
// lib/workOrders and is pure. Everything here is the half that needs a database:
// who asked, what number it gets, what the audit trail says happened, and the
// rule that a work order never outranks the tenancy checks the rest of the file
// already does. An order on a system you cannot see does not exist for you.

const revWo = (wo: { instrumentId: number | null; assetId: number | null }) => {
  revWork(wo);
  revalidatePath("/work");
};

/**
 * Load an order with everything needed to decide what this viewer may do to it.
 *
 * "Not found" rather than "no" when the underlying record is not theirs, which
 * is the posture every other read path in this file takes: refusing tells
 * somebody the job exists.
 */
async function loadWorkOrder(u: SessionUser, woId: number): Promise<
  { error: string } | {
    wo: typeof workOrders.$inferSelect;
    inst: typeof instruments.$inferSelect | null;
    /** Which side of the job they are on, or null for neither. */
    mover: Mover | null;
  }
> {
  const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, woId));
  if (!wo) return { error: "Not found" };

  let inst: typeof instruments.$inferSelect | null = null;
  let ownerOrgId: number | null = null;
  if (wo.instrumentId !== null) {
    if (!(await canSeeSystemSafe(u, wo.instrumentId))) return { error: "Not found" };
    [inst] = await db.select().from(instruments).where(eq(instruments.id, wo.instrumentId));
    ownerOrgId = inst?.ownerOrgId ?? null;
  } else if (wo.assetId) {
    if (!(await assetAccess(u, wo.assetId)).see) return { error: "Not found" };
    const [a] = await db.select().from(assets).where(eq(assets.id, wo.assetId));
    ownerOrgId = a?.ownerOrgId ?? null;
  }

  const staff = isHouse(u.role);
  const mover = moverOf(
    { isHouse: staff, orgId: u.orgId, houseOrgId: staff ? readTenant(u) : null },
    wo, ownerOrgId,
  );
  return { wo, inst: inst ?? null, mover };
}

/**
 * Write the order itself: the number, the row, the audit line.
 *
 * Kept separate from the action that calls it because two of its three callers
 * are not "somebody opened a work order" - they are a client pressing "Request
 * service", who may have read-only rights and must still be able to ask.
 *
 * The number races: two orders filed in the same second both read the same
 * highest number. The unique index in schema-sync is what makes that a failed
 * insert rather than two jobs called WO-1042, and this retries a handful of
 * times, which is enough for a shop and honest about what it is.
 */
async function fileWorkOrder(opts: {
  actorEmail: string;
  instrumentId: number | null; assetId: number | null; tenantOrgId: number | null;
  orgId: number | null; requestedBy: string; requestedByEmail: string;
  title: string; body: string; severity: string; origin: string; assignee: string;
  externalId: string;
}): Promise<typeof workOrders.$inferSelect> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const used = await db.select({ number: workOrders.number }).from(workOrders)
      .where(forTenant(workOrders.tenantOrgId, opts.tenantOrgId));
    const number = nextWoNumber(used.map((r) => r.number));
    try {
      const [wo] = await db.insert(workOrders).values({
        tenantOrgId: opts.tenantOrgId, number,
        instrumentId: opts.instrumentId,
        assetId: opts.instrumentId === null ? opts.assetId : null,
        orgId: opts.orgId, requestedBy: opts.requestedBy, requestedByEmail: opts.requestedByEmail,
        title: opts.title, body: opts.body, severity: severityOf(opts.severity).key,
        origin: opts.origin, assignee: opts.assignee, openedOn: shopToday(),
      }).returning();
      await audit({
        actor: opts.actorEmail, instrumentId: opts.instrumentId, assetId: opts.assetId,
        entityType: "work_order", entityId: wo.id,
        action: `opened ${wo.number}${opts.externalId ? ` on ${opts.externalId}` : ""}: ${wo.title}`
          + ` (${severityOf(wo.severity).label.toLowerCase()})`,
      });
      return wo;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/**
 * Somebody at the shop opens a job. The other way in is a client asking - see
 * reportIssue and requestPm, which land in the same place.
 */
export async function openWorkOrder(
  target: WorkTarget,
  data: { title: string; body: string; severity: string; assignee?: string },
): Promise<{ error?: string; id?: number; number?: string; flag?: string }> {
  const u = await requireEditor();
  const title = data.title.trim().slice(0, 160);
  if (!title) return { error: "Say briefly what the job is" };
  const t0 = await resolveTarget({ instrumentId: target.instrumentId, assetId: target.assetId });
  if ("error" in t0) return t0;

  // Whose job it is: the record's owner, not whoever typed it. An engineer
  // opening an order on a client's instrument is opening the CLIENT's job.
  const orgId = t0.instrumentId !== null
    ? (await db.select({ o: instruments.ownerOrgId }).from(instruments)
        .where(eq(instruments.id, t0.instrumentId)))[0]?.o ?? null
    : t0.asset?.ownerOrgId ?? null;

  const wo = await fileWorkOrder({
    actorEmail: u.email,
    instrumentId: t0.instrumentId, assetId: t0.assetId, tenantOrgId: t0.tenantOrgId,
    orgId, requestedBy: u.name || u.email, requestedByEmail: u.email,
    title, body: data.body.trim().slice(0, 4000), severity: data.severity,
    origin: "", assignee: (data.assignee ?? "").trim(),
    externalId: targetLabel(t0.externalId, t0.asset),
  });
  // Dispatched at intake: the engineer hears about it now, not when somebody
  // remembers to edit the order later. The link goes to the job itself.
  if ((data.assignee ?? "").trim()) {
    await notifyTaskAssigned({
      actorEmail: u.email, actorName: u.name || u.email, assignee: data.assignee!.trim(),
      taskTitle: `${wo.number} ${title}`,
      instrumentId: t0.instrumentId ?? undefined, assetId: t0.assetId ?? undefined,
      externalId: targetLabel(t0.externalId, t0.asset), workOrderId: wo.id,
    });
  }
  revWo(wo);
  // The entitlement check rides the answer, never blocks the job: the client's
  // instrument is down either way, but a visit spent beyond the contract must
  // not be spent silently. Failure to compute = no flag, not no work order.
  const flag = await visitFlag(orgId, t0.instrumentId).catch(() => "");
  return { id: wo.id, number: wo.number, flag: flag || undefined };
}

/**
 * File work that already happened - the paper history a system arrives with.
 *
 * A work order normally opens live and earns its close-out; a system serviced
 * for years before it entered this software has neither, and the history is
 * real whether or not the software watched it happen. So this writes the
 * record already closed, on the date it was done, with "what was done" as the
 * one required thing - a backfilled job with no summary is a date, not
 * history. The reference keeps the paper trail's own number when there is
 * one; otherwise the house series stamps it like any other job.
 */
export async function logPastWorkOrder(
  target: WorkTarget,
  data: { title: string; summary: string; date: string; reference?: string; doneBy?: string },
): Promise<{ error?: string; id?: number; number?: string }> {
  const u = await requireEditor();
  const title = data.title.trim().slice(0, 160);
  if (!title) return { error: "Say briefly what the job was" };
  const summary = data.summary.trim().slice(0, 4000);
  if (!summary) return { error: "Say what was done - a backfilled job with no summary is a date, not history" };
  const date = data.date.trim();
  if (!isIsoDay(date)) return { error: "Pick the date it was done" };
  if (date > shopToday()) return { error: "That's the future - open a work order instead" };
  const t0 = await resolveTarget({ instrumentId: target.instrumentId, assetId: target.assetId });
  if ("error" in t0) return t0;

  const reference = (data.reference ?? "").trim().slice(0, 40);
  const used = await db.select({ number: workOrders.number }).from(workOrders)
    .where(forTenant(workOrders.tenantOrgId, t0.tenantOrgId));
  if (reference && used.some((r) => r.number.toLowerCase() === reference.toLowerCase())) {
    return { error: `${reference} is already a work order here` };
  }
  const number = reference || nextWoNumber(used.map((r) => r.number));

  const orgId = t0.instrumentId !== null
    ? (await db.select({ o: instruments.ownerOrgId }).from(instruments)
        .where(eq(instruments.id, t0.instrumentId)))[0]?.o ?? null
    : t0.asset?.ownerOrgId ?? null;
  const doneBy = (data.doneBy ?? "").trim() || (u.name || u.email);

  const [wo] = await db.insert(workOrders).values({
    tenantOrgId: t0.tenantOrgId, number,
    instrumentId: t0.instrumentId, assetId: t0.instrumentId === null ? t0.assetId : null,
    orgId, requestedBy: doneBy, requestedByEmail: u.email,
    title, body: "", severity: "Planned", state: "closed",
    openedOn: date, closeSummary: summary, closedBy: doneBy,
    // Noon, so the calendar date survives every timezone's midnight.
    closedAt: new Date(`${date}T12:00:00Z`), resolvedAt: new Date(`${date}T12:00:00Z`),
  }).returning();
  await audit({
    actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId,
    entityType: "work_order", entityId: wo.id,
    action: `logged past work ${wo.number} (${date}): ${title}`,
  });
  revWo(wo);
  return { id: wo.id, number: wo.number };
}

/** The ask, the urgency and who has it. The house's to edit - it runs the job. */
export async function updateWorkOrder(
  woId: number, data: { title: string; body: string; severity: string; assignee: string },
): Promise<{ error?: string }> {
  const u = await requireUser();
  const found = await loadWorkOrder(u, woId);
  if ("error" in found) return found;
  const { wo, mover } = found;
  if (mover !== "house") return { error: "That is the service team's to change." };
  const title = data.title.trim().slice(0, 160);
  if (!title) return { error: "Say briefly what the job is" };

  const next = {
    title, body: data.body.trim().slice(0, 4000),
    severity: severityOf(data.severity).key, assignee: data.assignee.trim(),
  };
  await db.update(workOrders).set(next).where(eq(workOrders.id, woId));

  // One line per field that moved, because "edited WO-1042" answers nothing
  // three months later when somebody asks why it stopped being urgent.
  for (const [field, before, after] of [
    ["title", wo.title, next.title], ["severity", wo.severity, next.severity],
    ["assignee", wo.assignee, next.assignee], ["body", wo.body, next.body],
  ] as const) {
    if (before === after) continue;
    await audit({
      actor: u.email, instrumentId: wo.instrumentId, assetId: wo.assetId,
      entityType: "work_order", entityId: wo.id,
      action: field === "body"
        ? `rewrote what ${wo.number} asks for`
        : `set ${wo.number} ${field} to ${after || "(none)"}`,
      field, oldValue: before, newValue: after,
    });
  }
  if (next.assignee && next.assignee !== wo.assignee) {
    await notifyTaskAssigned({
      actorEmail: u.email, actorName: u.name, assignee: next.assignee,
      taskTitle: `${wo.number} ${next.title}`, instrumentId: wo.instrumentId ?? undefined,
      assetId: wo.assetId ?? undefined,
      externalId: found.inst?.externalId ?? "", workOrderId: wo.id,
    });
  }
  revWo(wo);
  return {};
}

/**
 * Move an order along. Everything except resolving, which needs a sentence
 * about what was done and so has its own action.
 */
export async function setWorkOrderState(woId: number, state: string): Promise<{ error?: string }> {
  const u = await requireUser();
  const found = await loadWorkOrder(u, woId);
  if ("error" in found) return found;
  const { wo, mover } = found;
  if (mover === null) return { error: "This one isn't yours to change." };
  if (state === "resolved") return { error: "Say what was done to resolve it." };
  // Closing without a close-out is how service history turns into a list of
  // dates. A resolved order already has one; anything else has to be resolved
  // first, which is where the sentence gets written.
  if (state === "closed" && wo.state !== "resolved") {
    return { error: "Resolve it first, with a line about what was done." };
  }

  const move = woMove(wo.state, state, mover);
  if (!move.ok) return { error: move.error };

  await db.update(workOrders).set({
    state: move.next,
    closedAt: move.next === "closed" || move.next === "cancelled" ? new Date() : null,
    closedBy: move.next === "closed" || move.next === "cancelled" ? (u.name || u.email) : "",
    // Reopening un-resolves it: a job being worked again has not been finished,
    // and leaving the stamp would date the finish to the first attempt.
    resolvedAt: woOpen(move.next) ? null : wo.resolvedAt,
  }).where(eq(workOrders.id, woId));

  await audit({
    actor: u.email, instrumentId: wo.instrumentId, assetId: wo.assetId,
    entityType: "work_order", entityId: wo.id,
    action: `${wo.number} is now ${WO_LABEL[move.next].toLowerCase()}`,
    field: "state", oldValue: wo.state, newValue: move.next,
  });
  revWo(wo);
  return {};
}

/**
 * The close-out: what was actually done, which is the thing the record keeps.
 *
 * Counted rather than retyped - the tasks and hours are already on the order, so
 * the sentence somebody writes is the part only a person can write, and the rest
 * is added up here.
 */
export async function resolveWorkOrder(woId: number, summary: string): Promise<{ error?: string }> {
  const u = await requireUser();
  const found = await loadWorkOrder(u, woId);
  if ("error" in found) return found;
  const { wo, mover } = found;
  if (mover !== "house") return { error: "The service team marks work resolved." };
  const move = woMove(wo.state, "resolved", "house");
  if (!move.ok) return { error: move.error };
  const said = summary.trim().slice(0, 2000);
  if (said.length < 3) return { error: "Say what was done - it is what the record keeps." };

  const [doneRows, timeRows, partRows] = await Promise.all([
    db.select({ state: tasks.state }).from(tasks).where(eq(tasks.workOrderId, woId)),
    db.select({ minutes: timeEntries.minutes }).from(timeEntries).where(eq(timeEntries.workOrderId, woId)),
    // Parts are not tagged to an order (they belong to the system, and a part
    // fitted is a part fitted whoever asked for it), so this counts what was
    // fitted while the order was open - which is what a reader means by "what
    // went into this job".
    wo.instrumentId === null ? Promise.resolve([]) : db.select({ id: parts.id }).from(parts)
      .where(and(eq(parts.instrumentId, wo.instrumentId), eq(parts.status, "Installed"),
        sql`${parts.installedAt} >= ${wo.openedOn}`)),
  ]);
  const line = closeLine(said, {
    tasks: doneRows.filter((t) => t.state === "Done").length,
    minutes: timeRows.reduce((n, t) => n + t.minutes, 0),
    parts: partRows.length,
  });

  await db.update(workOrders)
    .set({ state: "resolved", closeSummary: line, resolvedAt: new Date() })
    .where(eq(workOrders.id, woId));
  await audit({
    actor: u.email, instrumentId: wo.instrumentId, assetId: wo.assetId,
    entityType: "work_order", entityId: wo.id,
    action: `resolved ${wo.number}: ${line}`,
    field: "state", oldValue: wo.state, newValue: "resolved",
  });

  // On the system's own conversation, where the client is already looking. The
  // close-out is the one thing about a job they will read again.
  if (wo.instrumentId !== null) {
    await db.insert(discussionPosts).values({
      tenantOrgId: wo.tenantOrgId, instrumentId: wo.instrumentId,
      body: `${wo.number} resolved - ${line}`,
      author: u.name || u.email, authorEmail: u.email, authorOrgId: u.orgId, audience: "all",
    });
  }
  revWo(wo);
  return {};
}

/**
 * Put an existing task into a job, or take it out of one.
 *
 * The common case is a job that grew: an order was opened, and the three tasks
 * that answer it were written before anybody thought to file them under it.
 */
export async function setTaskWorkOrder(taskId: number, woId: number | null): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t) return { error: "Not found" };
  await assertWorkEditable(u, t);
  if (woId === null) {
    await db.update(tasks).set({ workOrderId: null }).where(eq(tasks.id, taskId));
    revWork(t);
    return {};
  }
  const found = await loadWorkOrder(u, woId);
  if ("error" in found) return found;
  const { wo } = found;
  // Same two checks resolveTarget makes: on this record, and still taking work.
  const onThis = t.instrumentId !== null ? wo.instrumentId === t.instrumentId : wo.assetId === t.assetId;
  if (!onThis) return { error: "That work order is not on this record" };
  if (!woAcceptsWork(wo.state)) return { error: `${wo.number} is ${WO_LABEL[wo.state].toLowerCase()}.` };

  await db.update(tasks).set({ workOrderId: wo.id }).where(eq(tasks.id, taskId));
  await audit({
    actor: u.email, instrumentId: t.instrumentId, assetId: t.assetId,
    entityType: "work_order", entityId: wo.id,
    action: `filed task '${t.title}' under ${wo.number}`,
  });
  revWo(wo);
  return {};
}

/**
 * Put a system in the queue of whoever services it because the client just asked
 * for something. The rules are the ones the daily generator uses (lib/pmQueue)
 * and the same event and audit rows get written, so the move reads like any other
 * in the system's history rather than like something that happened to it.
 */
async function handOffForClientAsk(
  inst: { id: number; externalId: string; queueOrgId: number | null; archived: boolean; tenantOrgId: number | null },
  why: string, actor: string,
): Promise<void> {
  const shares = await db.select({ orgId: orgs.id, kind: orgs.kind })
    .from(systemShares).innerJoin(orgs, eq(orgs.id, systemShares.orgId))
    .where(eq(systemShares.instrumentId, inst.id));
  const decision = pmHandoff({
    queueOrgId: inst.queueOrgId,
    // Whoever services this system is the workspace it belongs to.
    operatorOrgId: inst.tenantOrgId,
    shares, archived: inst.archived,
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
  await db.update(instruments)
    .set({ queueOrgId: decision.toOrgId, queueReason: why, queueSince: new Date() })
    .where(eq(instruments.id, inst.id));
  await db.insert(queueEvents).values({
    instrumentId: inst.id, fromOrgId: inst.queueOrgId, toOrgId: decision.toOrgId,
    fromName, toName, reason: why, actor,
  });
  await audit({
    actor, instrumentId: inst.id, entityType: "queue", entityId: inst.externalId,
    action: `moved ${inst.externalId} from ${fromName}'s queue to ${toName}'s - ${why}`,
    field: "queue", oldValue: fromName, newValue: toName,
  });
}

/**
 * A client says something is wrong with their system.
 *
 * One press, and everything that should follow follows: a work order is opened
 * with a number they can quote, the system is marked as needing maintenance, it
 * lands in whoever services it's queue, a task exists to work from, the words
 * are on the record as a post the client can add to, and the people who fix
 * things are told. Attachments are uploaded first and passed in, so a photo of
 * an error dialog arrives with the report rather than after it.
 *
 * The work order is the part that was missing. Before it, the only evidence a
 * request had been answered was somebody remembering to tick a task, and there
 * was nothing to close and nothing to report a state on.
 */
export async function reportIssue(instrumentId: number, data: {
  severity: string; summary: string; details: string;
  files?: { fileName: string; url: string; size: number; kind: string }[];
}): Promise<{ error?: string; taskId?: number; number?: string; workOrderId?: number }> {
  const u = await requireUser();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  // Anybody who can see the system may say something is wrong with it - reporting
  // a fault is not editing a record, and a read-only account watching an
  // instrument fail should not have to find somebody with more rights.
  if (!(await canSeeSystemSafe(u, instrumentId))) return { error: "Not found" };
  if (inst.archived) return { error: "That system is archived" };

  const severity = ["Down", "Degraded", "Question"].includes(data.severity) ? data.severity : "Degraded";
  const summary = data.summary.trim().slice(0, 160);
  if (!summary) return { error: "Say briefly what is wrong" };
  const details = data.details.trim().slice(0, 4000);
  const files = (data.files ?? []).slice(0, 10);

  const orgName = u.orgId === null ? (await getBrand()).operatorName : u.orgName || "a client";

  // Marked as needing maintenance, without disturbing where it is in its build.
  const stages = inst.stages.includes("Maintenance due") ? inst.stages : [...inst.stages, "Maintenance due"];
  if (stages !== inst.stages) {
    await db.update(instruments).set({ stages }).where(eq(instruments.id, instrumentId));
    await db.insert(stageEvents).values({ instrumentId, stage: "Maintenance due", kind: "added" });
  }

  // The job. Everything below hangs off it, which is what makes those rows one
  // thing that can be reported on and closed rather than four loose records.
  const wo = await fileWorkOrder({
    actorEmail: u.email,
    instrumentId, assetId: null, tenantOrgId: inst.tenantOrgId,
    // Whose job it is. The reporter's own organization; for our own staff
    // reporting on a client's system, the system's owner.
    orgId: u.orgId ?? inst.ownerOrgId,
    requestedBy: u.name || u.email, requestedByEmail: u.email,
    title: summary, body: details, severity, origin: "issue", assignee: "",
    externalId: inst.externalId,
  });

  // Something to work from, dated today, so it shows up as work rather than as a
  // message somebody has to remember to act on.
  const [task] = await db.insert(tasks).values({
    tenantOrgId: inst.tenantOrgId,
    instrumentId, assetId: null,
    title: `${severity}: ${summary}`,
    body: [details, `Reported by ${u.name || u.email} at ${orgName}.`].filter(Boolean).join("\n\n"),
    dueDate: shopToday(), origin: "issue", workOrderId: wo.id,
  }).returning();

  // The files, attached to the task so they read as evidence for it, and to the
  // order so they are on the job's own page too.
  for (const f of files) {
    await db.insert(attachments).values({
      tenantOrgId: inst.tenantOrgId,
      instrumentId, taskId: task.id, workOrderId: wo.id,
      fileName: f.fileName.slice(0, 200), url: f.url,
      size: f.size, kind: f.kind || "Other", uploadedBy: u.email,
      description: `Reported with "${summary}"`, orgId: u.orgId,
    });
  }

  // On the record as a conversation, which is the half they asked for: they can
  // add to it, and so can we, without either side leaving the system.
  await db.insert(discussionPosts).values({
    tenantOrgId: inst.tenantOrgId, instrumentId,
    body: [`${wo.number} · ${severity} - ${summary}`, details].filter(Boolean).join("\n\n"),
    author: u.name || u.email, authorEmail: u.email, authorOrgId: u.orgId, audience: "all",
  });

  // Into the queue of whoever services it, by the same rules due maintenance uses.
  await handOffForClientAsk(inst, `${severity.toLowerCase()} reported: ${summary}`, u.email);

  await audit({
    actor: u.email, instrumentId, entityType: "issue", entityId: inst.externalId,
    action: `${orgName} reported ${severity.toLowerCase()} on ${inst.externalId} as ${wo.number}: ${summary}`
      + `${files.length ? ` (${files.length} file${files.length === 1 ? "" : "s"})` : ""}`,
  });

  await notifyIssueRaised({
    to: await houseEmails(inst.tenantOrgId), externalId: inst.externalId, instrumentId, orgName,
    severity, summary: `${wo.number} - ${summary}`, details,
    reporter: u.name || u.email, files: files.length,
  });

  rev(instrumentId);
  revalidatePath("/work");
  return { taskId: task.id, number: wo.number, workOrderId: wo.id };
}

/**
 * A client asks for maintenance. The other half of the same button: nothing is
 * broken, they want the PM done.
 *
 * Deliberately not the same thing as an engineer pressing "Do it now" on a
 * schedule. That advances the cadence on completion; this does not touch any
 * schedule at all, because a client should not be able to move a contract's
 * maintenance calendar by asking. The request becomes work dated by the horizon
 * they asked for, in our queue, with what the calendar already says written on it
 * - so pulling the real schedule forward stays a decision somebody makes.
 *
 * Asking twice doesn't file twice: the second ask lands on the discussion of the
 * open one, which is where a "any update?" belongs.
 */
export async function requestPm(instrumentId: number, data: { window: string; note: string }):
Promise<{ error?: string; taskId?: number; already?: boolean; number?: string; workOrderId?: number }> {
  const u = await requireUser();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  // Same rule as reporting a fault: anybody who can see the system may ask for
  // its upkeep. Asking is not editing.
  if (!(await canSeeSystemSafe(u, instrumentId))) return { error: "Not found" };
  if (inst.archived) return { error: "That system is archived" };

  const w = pmWindow(data.window);
  const note = data.note.trim().slice(0, 2000);
  const today = shopToday();
  const orgName = u.orgId === null ? (await getBrand()).operatorName : u.orgName || "a client";
  const who = u.name || u.email;

  const post = (body: string) => db.insert(discussionPosts).values({
    tenantOrgId: inst.tenantOrgId,
    instrumentId, body, author: who, authorEmail: u.email, authorOrgId: u.orgId, audience: "all",
  });

  // One open request per system. A second ask is a message about the first, not a
  // second job for two people to each do once.
  const [openReq] = await db.select({ id: tasks.id, dueDate: tasks.dueDate }).from(tasks)
    .where(and(eq(tasks.instrumentId, instrumentId), eq(tasks.origin, "pm_request"), ne(tasks.state, "Done")))
    .limit(1);
  if (openReq) {
    await post([`Maintenance requested again - ${w.label.toLowerCase()}.`, note].filter(Boolean).join("\n\n"));
    await audit({
      actor: u.email, instrumentId, entityType: "task", entityId: openReq.id,
      action: `${orgName} followed up on the maintenance request for ${inst.externalId} (open, due ${openReq.dueDate})`,
    });
    rev(instrumentId);
    return { taskId: openReq.id, already: true };
  }

  // What the calendar already says, read across the system's own schedules and
  // those living on the units installed in it - the same set the page shows.
  const assetIds = (await db.select({ id: assets.id }).from(assets)
    .where(eq(assets.instrumentId, instrumentId))).map((a) => a.id);
  const scheds = await db.select({ title: pmSchedules.title, nextDue: pmSchedules.nextDue, paused: pmSchedules.paused })
    .from(pmSchedules).where(assetIds.length
      ? or(eq(pmSchedules.instrumentId, instrumentId), inArray(pmSchedules.assetId, assetIds))
      : eq(pmSchedules.instrumentId, instrumentId));
  const calendar = scheduleLine(scheds, today);

  // Upkeep is owed, and the dashboard should say so - without disturbing where
  // the system is in its build.
  if (!inst.stages.includes("Maintenance due")) {
    await db.update(instruments).set({ stages: [...inst.stages, "Maintenance due"] }).where(eq(instruments.id, instrumentId));
    await db.insert(stageEvents).values({ instrumentId, stage: "Maintenance due", kind: "added" });
  }

  const dueDate = pmRequestDue(today, w.key);
  // Planned, not an emergency - the fourth thing a work order can be. It gets a
  // number and a close-out like any other job, because "did the PM we asked for
  // in March ever happen" is exactly the question a work order exists to answer.
  const wo = await fileWorkOrder({
    actorEmail: u.email,
    instrumentId, assetId: null, tenantOrgId: inst.tenantOrgId,
    orgId: u.orgId ?? inst.ownerOrgId,
    requestedBy: who, requestedByEmail: u.email,
    title: pmRequestTitle(note), body: [note, calendar].filter(Boolean).join("\n\n"),
    severity: "Planned", origin: "pm_request", assignee: "",
    externalId: inst.externalId,
  });

  const [task] = await db.insert(tasks).values({
    tenantOrgId: inst.tenantOrgId,
    instrumentId, assetId: null,
    title: pmRequestTitle(note),
    body: [note, `Requested by ${who} at ${orgName} - ${w.label.toLowerCase()}.`, calendar].filter(Boolean).join("\n\n"),
    dueDate, origin: "pm_request", workOrderId: wo.id,
  }).returning();

  await post([`${wo.number} · Maintenance requested - ${w.label.toLowerCase()}.`, note].filter(Boolean).join("\n\n"));
  await handOffForClientAsk(inst, `maintenance requested: ${w.label.toLowerCase()}`, u.email);
  await audit({
    actor: u.email, instrumentId, entityType: "task", entityId: task.id,
    action: `${orgName} asked for maintenance on ${inst.externalId} as ${wo.number} - ${w.label.toLowerCase()}, due ${dueDate}`,
  });
  await notifyPmRequested({
    to: await houseEmails(inst.tenantOrgId), externalId: inst.externalId, instrumentId, orgName,
    windowLabel: w.label, note, calendar, requester: who, dueDate,
  });

  rev(instrumentId);
  revalidatePath("/maintenance");
  revalidatePath("/work");
  return { taskId: task.id, number: wo.number, workOrderId: wo.id };
}

/** Point a device at the system it drives, or clear the link. Staff only. */
export async function linkRemoteDevice(deviceId: number, instrumentId: number | null): Promise<{ error?: string }> {
  const u = await requireStaff();
  const row = await deviceWithOrg(deviceId);
  if (!row) return { error: "Not found" };
  let label = "nothing";
  if (instrumentId !== null) {
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
    if (!inst) return { error: "Not found" };
    label = inst.externalId;
  }
  await db.update(remoteDevices).set({ instrumentId }).where(eq(remoteDevices.id, deviceId));
  await audit({
    actor: u.email, instrumentId, entityType: "remote", entityId: deviceId,
    action: `linked ${row.device.name || "a machine"} to ${label}`,
  });
  revalidatePath("/remote");
  return {};
}

/**
 * Give a machine a name a person can use.
 *
 * Stored beside the hostname rather than over it: the engine refreshes the
 * hostname on every reconcile, so anything typed into that column would survive
 * until the next time somebody opened the page. It also stays visible next to
 * the nickname, because "Altis PC" finds the machine and DESKTOP-39VTF39 proves
 * it is the right one.
 */
export async function renameRemoteDevice(deviceId: number, nickname: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const row = await deviceWithOrg(deviceId);
  if (!row) return { error: "Not found" };
  const next = cleanNickname(nickname);
  if (next === row.device.nickname) return {};
  await db.update(remoteDevices).set({ nickname: next }).where(eq(remoteDevices.id, deviceId));
  await audit({
    actor: u.email, instrumentId: row.device.instrumentId, entityType: "remote", entityId: deviceId,
    action: next
      ? `called ${row.device.name || "a machine"} "${next}"`
      : `cleared the name on ${row.device.name || "a machine"}`,
    field: "nickname", oldValue: row.device.nickname, newValue: next,
  });
  revalidatePath("/remote");
  revalidatePath(`/remote/${deviceId}`);
  return {};
}

/**
 * Force a consent prompt on, force it off, or go back to deriving it from
 * custody. Off-after-handoff is the paid exception; on-in-the-shop is for a
 * machine somebody is sitting at all day.
 */
export async function setRemoteConsent(deviceId: number, mode: "derive" | "always" | "never"): Promise<{ error?: string }> {
  const u = await requireStaff();
  const row = await deviceWithOrg(deviceId);
  if (!row) return { error: "Not found" };
  const consentOverride = mode === "derive" ? null : mode === "always";
  await db.update(remoteDevices).set({ consentOverride }).where(eq(remoteDevices.id, deviceId));
  await audit({
    actor: u.email, instrumentId: row.device.instrumentId, entityType: "remote", entityId: deviceId,
    action: `set ${row.device.name || "a machine"} to ${
      mode === "derive" ? "follow custody for consent" : mode === "always" ? "always ask before connecting" : "never ask before connecting"
    }`,
  });
  revalidatePath("/remote");
  return {};
}

/**
 * Forget a machine. Deliberately does NOT claim to have removed access: an agent
 * that is still installed keeps checking in, and the only way to stop it is to
 * uninstall it on the machine. The caller's confirmation says so.
 */
export async function removeRemoteDevice(deviceId: number, reason: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const row = await deviceWithOrg(deviceId);
  if (!row) return {};
  await db.delete(remoteDevices).where(eq(remoteDevices.id, deviceId));
  await audit({
    actor: u.email, instrumentId: row.device.instrumentId, entityType: "remote", entityId: deviceId,
    action: `removed ${row.device.name || "a machine"} from remote support`
      + ` - the agent stays installed until somebody uninstalls it - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revalidatePath("/remote");
  return {};
}

export async function setOrgStorageLimit(orgId: number, limitMb: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const mb = Math.max(0, Math.round(Number(limitMb) || 0));
  const gate = await adminOrgGate(u, orgId);
  if ("error" in gate) return gate;
  const { org } = gate;
  if (mb > 0) {
    const used = await storeUsedBytes(orgId);
    if (used > mb * MB) {
      return { error: `${org.name} is already storing ${fmtBytes(used)}. Set at least that, or have them remove files first.` };
    }
  }
  await db.update(orgs).set({ storageLimitMb: mb }).where(eq(orgs.id, orgId));
  await audit({
    actor: u.email, entityType: "settings", entityId: orgId,
    action: `${org.name} file storage limit: ${mb === 0 ? "no limit" : `${mb} MB`}`,
    field: "storageLimitMb", oldValue: String(org.storageLimitMb), newValue: String(mb),
  });
  revalidatePath("/settings");
  revalidatePath("/documents");
  return {};
}

export async function updateEodRecipients(orgId: number, value: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const entries = value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = entries.find((e) => !ALLOW_EMAIL.test(e));
  if (bad) return { error: `"${bad}" doesn't look like an email` };
  const eodRecipients = entries.join(", ");
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };
  await db.update(orgs).set({ eodRecipients }).where(eq(orgs.id, orgId));
  await audit({
    actor: u.email, entityType: "settings", entityId: orgId,
    action: `${org.name} daily report recipients: ${eodRecipients || "(none)"}`,
  });
  revalidatePath("/settings");
  revalidatePath("/eod");
  return {};
}

// ---------------- Client sign-in allowlist ----------------

/** "jane@labzenllc.com" (one person) or "@labzenllc.com" (whole domain). */
const ALLOW_EMAIL = /^[^\s@]+@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;
const ALLOW_DOMAIN = /^@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;

export async function addClientAccess(raw: string, orgId: number, canEdit = false): Promise<{ error?: string }> {
  // Two routes in, and they are the two halves of the product's story: an
  // operator's staff invite anyone into an organization THEY administer - their
  // own clients, which is what "log in and get operational" means for a service
  // company that just bought this - and an organization's own editors invite
  // colleagues into their own org, exact emails only. Domain wildcards stay with
  // the workspace: "@acme.com" is a standing grant, not a colleague.
  const u = await requireEditor();
  const entry = raw.trim().toLowerCase();
  const asStaff = u.role === "owner" || u.role === "staff";
  if (!asStaff) {
    if (u.orgId === null || orgId !== u.orgId) return { error: "Not found" };
    if (!ALLOW_EMAIL.test(entry)) return { error: 'Enter a colleague\'s email, like "jane@company.com"' };
  } else if (!ALLOW_EMAIL.test(entry) && !ALLOW_DOMAIN.test(entry)) {
    // Returned, not thrown: prod masks thrown server-action messages.
    return { error: 'Enter an email like "jane@company.com" or a domain like "@company.com"' };
  }
  // An entry with no organization would be a login with no scope, so require it -
  // and staff may only name one their own workspace runs.
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Pick which organization they sign in as" };
  if (asStaff && !mayAdminOrg(tenantViewer(u), org)) return { error: "Pick which organization they sign in as" };
  await db.insert(clientAllowlist).values({ entry, orgId, canEdit, addedBy: u.name }).onConflictDoNothing();
  await audit({
    actor: u.email, entityType: "settings", entityId: entry,
    action: `allowed client sign-in: ${entry} as ${org.name} (${canEdit ? "editor" : "viewer"})`,
  });
  // A domain names no one, so only an exact email gets the invitation.
  if (ALLOW_EMAIL.test(entry)) {
    await notifyInvite({ to: entry, inviterName: u.name, orgName: org.name });
  }
  revalidatePath("/settings");
  rev();
  return {};
}

/** Flip a sign-in entry between editor and viewer. Takes effect on their next page load. */
export async function setClientAccessRole(id: number, canEdit: boolean): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [row] = await db.select().from(clientAllowlist).where(eq(clientAllowlist.id, id));
  if (!row) return { error: "Not found" };
  // Their organization has to be one this workspace administers - a role is
  // access, and access to somebody else's client is not ours to widen.
  if (row.orgId === null) return { error: "Not found" };
  const gate = await adminOrgGate(u, row.orgId);
  if ("error" in gate) return gate;
  if (row.canEdit === canEdit) return {};
  await db.update(clientAllowlist).set({ canEdit }).where(eq(clientAllowlist.id, id));
  await audit({
    actor: u.email, entityType: "settings", entityId: row.entry,
    action: `${row.entry} is now ${canEdit ? "an editor" : "a viewer"}`,
    field: "can_edit", oldValue: String(row.canEdit), newValue: String(canEdit),
  });
  revalidatePath("/settings");
  return {};
}

/**
 * Whether one person at a client organization may read its agreements.
 *
 * Access to a system and access to the contract behind it are different
 * questions, and everybody at an org used to get both. A lab manager needs the
 * terms; the tech checking whether the LC is fixed usually does not, and at
 * some companies must not.
 */
export async function setClientSeesAgreements(id: number, canSee: boolean): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [row] = await db.select().from(clientAllowlist).where(eq(clientAllowlist.id, id));
  if (!row) return { error: "Not found" };
  if (row.orgId === null) return { error: "Not found" };
  const gate = await adminOrgGate(u, row.orgId);
  if ("error" in gate) return gate;
  if (row.canSeeAgreements === canSee) return {};
  await db.update(clientAllowlist).set({ canSeeAgreements: canSee }).where(eq(clientAllowlist.id, id));
  await audit({
    actor: u.email, entityType: "settings", entityId: row.entry,
    action: `${row.entry} ${canSee ? "may now read" : "may no longer read"} their organization's agreements`,
    field: "can_see_agreements", oldValue: String(row.canSeeAgreements), newValue: String(canSee),
  });
  revalidatePath("/settings");
  revalidatePath(`/settings/organizations/${row.orgId}`);
  return {};
}

export async function setClientAccessOrg(id: number, orgId: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [row] = await db.select().from(clientAllowlist).where(eq(clientAllowlist.id, id));
  if (!row) return { error: "Not found" };
  // Both ends: the organization it is leaving and the one it is joining must
  // both be ours, or this would move a login between workspaces.
  const to = await adminOrgGate(u, orgId);
  if ("error" in to) return { error: "Pick an organization" };
  const org = to.org;
  if (row.orgId !== null) {
    const from = await adminOrgGate(u, row.orgId);
    if ("error" in from) return { error: "Not found" };
  }
  if (row.orgId === orgId) return {};
  await db.update(clientAllowlist).set({ orgId }).where(eq(clientAllowlist.id, id));
  await audit({
    actor: u.email, entityType: "settings", entityId: row.entry,
    action: `${row.entry} now signs in as ${org.name}`, field: "orgId",
    oldValue: String(row.orgId ?? ""), newValue: String(orgId),
  });
  revalidatePath("/settings");
  return {};
}

export async function removeClientAccess(id: number) {
  // An operator's staff remove anyone from an organization they administer; an
  // org's editors remove their own colleagues (exact-email rows in their own org).
  const u = await requireEditor();
  const [row] = await db.select().from(clientAllowlist).where(eq(clientAllowlist.id, id));
  if (!row) return;
  if (u.role === "owner" || u.role === "staff") {
    if (row.orgId === null) return;
    if (!("org" in await adminOrgGate(u, row.orgId))) return;
  } else if (u.orgId === null || row.orgId !== u.orgId || row.entry.trim().startsWith("@")) {
    return;
  }
  await db.delete(clientAllowlist).where(eq(clientAllowlist.id, id));
  // Revoke live sessions for anyone who just lost access - removal should
  // take effect now, not when their 30-day session happens to expire.
  const allUsers = await db.select().from(users);
  for (const usr of allUsers) {
    const email = usr.email.toLowerCase();
    if (!matchesEntry(email, row.entry)) continue;
    if (roleForEmail(email)) continue; // still allowed via env (staff or CLIENT_EMAILS)
    if (await emailInClientAllowlist(email)) continue; // still covered by another entry
    await db.delete(sessions).where(eq(sessions.userId, usr.id));
  }
  await audit({
    actor: u.email, entityType: "settings", entityId: row.entry,
    action: `removed client sign-in: ${row.entry}`,
  });
  revalidatePath("/settings");
}

// ---------------- Time entries ----------------
// The labor half of the record. Anyone who can edit the work can log hours;
// the entry names who did the work (roster name), not just who typed it in.

export async function logTime(
  target: WorkTarget,
  data: { hours: string; person: string; date: string; note: string },
): Promise<{ error?: string }> {
  const u = await requireEditor();
  const minutes = parseHours(data.hours);
  if (minutes === null || minutes <= 0) return { error: "Enter hours like 1.5, 1:30 or 45m" };
  const date = data.date.trim();
  if (!isIsoDay(date)) return { error: "Pick a date" };
  const t0 = await resolveTarget(target);
  if ("error" in t0) return t0;
  const person = data.person.trim() || u.name;
  const [row] = await db.insert(timeEntries).values({
    tenantOrgId: t0.tenantOrgId,
    instrumentId: t0.instrumentId, assetId: t0.assetId,
    person, date, minutes, note: data.note.trim(), loggedBy: u.email,
    workOrderId: t0.workOrderId,
  }).returning();
  await audit({
    actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId, entityType: "time", entityId: row.id,
    action: `logged ${formatHours(minutes)} - ${person}${t0.asset ? ` [${assetLabel(t0.asset)}]` : ""}${row.note ? ` - ${row.note}` : ""}`,
  });
  revWork(row);
  return {};
}

export async function deleteTimeEntry(id: number, reason: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [row] = await db.select().from(timeEntries).where(eq(timeEntries.id, id));
  if (!row) return {};
  await assertWorkEditable(u, row);
  await db.delete(timeEntries).where(eq(timeEntries.id, id));
  await audit({
    actor: u.email, instrumentId: row.instrumentId, assetId: row.assetId, entityType: "time", entityId: id,
    action: `removed a ${formatHours(row.minutes)} entry (${row.person}, ${row.date}) - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revWork(row);
  return {};
}

// ---------------- Sharing ----------------
// Who a system is visible to. Staff share with anyone; an organization with
// edit rights may bring in a service provider on a system it works, which is
// how both sides get outside help without discovering each other's clients.

export async function shareSystem(instrumentId: number, orgId: number, access: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  const level = access === "edit" ? "edit" : "view";
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Pick an organization" };
  // The house of THIS system's workspace shares it with anyone. Another
  // operator's staff, invited onto it, follow the client rules below - they are a
  // provider here, and a provider does not hand out access to somebody else's
  // instrument.
  if (!houseOf(u, inst.tenantOrgId)) {
    // An org may only add providers, only to systems it can edit, and never
    // itself (which would be a self-granted upgrade).
    try { await assertSystemEditable(u, instrumentId); } catch { return { error: "Not found" }; }
    if (org.kind !== "provider") return { error: "You can only bring in a service provider" };
    if (org.id === u.orgId) return { error: "That's your own organization" };
  }
  const [existing] = await db.select().from(systemShares)
    .where(and(eq(systemShares.instrumentId, instrumentId), eq(systemShares.orgId, orgId)));
  if (existing) {
    if (existing.access === level) return {};
    await db.update(systemShares).set({ access: level }).where(eq(systemShares.id, existing.id));
  } else {
    await db.insert(systemShares).values({ instrumentId, orgId, access: level, addedBy: u.email });
  }
  await audit({
    actor: u.email, instrumentId, entityType: "share", entityId: inst.externalId,
    action: `${existing ? "changed" : "granted"} ${org.name} ${level} access to ${inst.externalId}`,
    field: "access", oldValue: existing?.access ?? "", newValue: level,
  });
  rev(instrumentId);
  return {};
}

/**
 * A system can end the same way twice - a provider brought back and let go
 * again, a reseller who buys a system back and sells it on. The second record
 * covers the same tenure as the first, so it supersedes rather than stacks:
 * otherwise the holder's shelf fills with near-identical copies of one system.
 * Nothing is deleted - a frozen dossier is evidence, and the superseded row
 * still reads at its own URL. It simply leaves the listings.
 */
async function supersedeRecords(instrumentId: number, orgId: number, kind: string) {
  await db.update(engagementRecords).set({ supersededAt: new Date() })
    .where(and(
      eq(engagementRecords.instrumentId, instrumentId),
      eq(engagementRecords.orgId, orgId),
      eq(engagementRecords.kind, kind),
      isNull(engagementRecords.supersededAt),
    ));
}

export async function unshareSystem(instrumentId: number, orgId: number): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };
  if (!houseOf(u, inst.tenantOrgId)) {
    try { await assertSystemEditable(u, instrumentId); } catch { return { error: "Not found" }; }
    // An org can withdraw a provider it brought in, but not its own access
    // (that's the house's call) and not another client's.
    if (org.kind !== "provider") return { error: "You can only remove a service provider" };
  }
  const [share] = await db.select().from(systemShares)
    .where(and(eq(systemShares.instrumentId, instrumentId), eq(systemShares.orgId, orgId)));
  if (!share) return {};
  // A service provider keeps its own service reports: freeze the full dossier
  // as of this moment before the share goes. Nothing recorded after today can
  // ever reach it. Clients don't get one - unsharing a client is cleanup, not
  // the end of an engagement.
  if (org.kind === "provider") {
    const dossier = await composeSystemDossier(instrumentId, orgId);
    if (dossier) {
      await supersedeRecords(instrumentId, orgId, "revoked");
      await db.insert(engagementRecords).values({
        instrumentId, orgId, kind: "revoked", externalId: inst.externalId, label: dossier.label,
        revokedBy: u.email, data: dossier,
      });
    }
  }
  await db.delete(systemShares).where(eq(systemShares.id, share.id));
  // Losing the share also vacates the approver's seat: an owner with no access
  // shouldn't keep deciding who gets on.
  if (inst.ownerOrgId === orgId) {
    await db.update(instruments).set({ ownerOrgId: null }).where(eq(instruments.id, instrumentId));
  }
  await audit({
    actor: u.email, instrumentId, entityType: "share", entityId: inst.externalId,
    action: `removed ${org.name}'s access to ${inst.externalId}${org.kind === "provider" ? " - they keep a frozen record of the engagement" : ""}`,
  });
  rev(instrumentId);
  return {};
}

/**
 * Move a system into somebody else's queue - or take it back into ours.
 *
 * This is the "not our move" button. A repaired system sitting in Checkout
 * while the client runs their application tests is finished work as far as the
 * shop is concerned, but archiving it would be a lie and shipping it hasn't
 * happened yet. Parking it with the client clears it off our board, tells them
 * it's theirs to act on, and keeps the clock honest: days spent in their queue
 * are excluded from our turnaround (lib/reports).
 *
 * The same mechanism covers a blockage - "waiting on your nitrogen generator
 * contractor" - and the last mile, where a reseller takes the system back to
 * hand it on to their own customer.
 *
 * toOrgId null means our queue. A reason is always required: a system landing
 * in your queue with no explanation is worse than an email.
 */
export async function kickToQueue(
  instrumentId: number, toOrgId: number | null, reason: string,
): Promise<{ error?: string }> {
  const u = await requireEditor();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  if (!(await canSeeSystemSafe(u, instrumentId))) return { error: "Not found" };
  if (!canKick(u, inst)) {
    return {
      error: inst.archived
        ? "That system is archived"
        : "Only the operator, whoever currently holds it, or the owner can move a system between queues",
    };
  }
  if (inst.queueOrgId === toOrgId) {
    return { error: toOrgId === null ? "It's already in our queue" : "It's already in that queue" };
  }
  // You can't park a system with an organization that can't see it - they'd get
  // a notification about a record they can't open.
  let to: typeof orgs.$inferSelect | undefined;
  if (toOrgId !== null) {
    [to] = await db.select().from(orgs).where(eq(orgs.id, toOrgId));
    if (!to) return { error: "Unknown organization" };
    const [share] = await db.select({ id: systemShares.id }).from(systemShares)
      .where(and(eq(systemShares.instrumentId, instrumentId), eq(systemShares.orgId, toOrgId)));
    if (!share) return { error: `${to.name} doesn't have access to ${inst.externalId} - share it with them first` };
  }
  const [from] = inst.queueOrgId === null ? [] : await db.select().from(orgs).where(eq(orgs.id, inst.queueOrgId));
  const brand = await getBrand();
  const fromName = from?.name ?? brand.operatorName;
  const toName = to?.name ?? brand.operatorName;

  await db.update(instruments)
    .set({ queueOrgId: toOrgId, queueReason: why, queueSince: new Date() })
    .where(eq(instruments.id, instrumentId));
  await db.insert(queueEvents).values({
    instrumentId, fromOrgId: inst.queueOrgId, toOrgId,
    fromName, toName, reason: why, actor: u.email,
  });
  await audit({
    actor: u.email, instrumentId, entityType: "queue", entityId: inst.externalId,
    action: `moved ${inst.externalId} from ${fromName}'s queue to ${toName}'s - ${why}`,
    field: "queue", oldValue: fromName, newValue: toName,
  });

  // Tell the side that now owns the next move. Landing in our own queue tells
  // staff; landing in an org's queue tells that org's people.
  const recipients = toOrgId === null
    ? await houseEmails(inst.tenantOrgId)
    : (await db.select({ entry: clientAllowlist.entry }).from(clientAllowlist)
        .where(eq(clientAllowlist.orgId, toOrgId)))
        // An "@domain" entry names a domain, not a mailbox.
        .map((a) => a.entry.trim()).filter((e) => e.includes("@") && !e.startsWith("@"));
  const audience = recipients.filter((e) => e.toLowerCase() !== u.email.toLowerCase());
  if (audience.length) {
    await notifyQueueKick({
      to: audience, externalId: inst.externalId, instrumentId,
      fromName, toName, reason: why, stages: inst.stages,
    });
  }
  rev(instrumentId);
  return {};
}

/**
 * A system changes hands. This is the whole event, not just a repointed owner:
 *
 * - custody is recorded, so the chain reads "LabZen Jun '24 -> Acme Aug '26"
 *   forever - for resale, that provenance is the product
 * - the outgoing owner gets a frozen engagement record of their tenure, the
 *   same dossier a departing provider gets, and then loses live access unless
 *   they're kept on as a viewer (a reseller usually wants that)
 * - service providers keep their shares. Sierra shipped it and still maintains
 *   it; the new owner sees exactly who else has access and can revoke
 * - part costs do NOT transfer. Each part row already carries the org that
 *   bought it (parts.owner_org_id), so what LabZen paid stays LabZen's - see
 *   lib/redact. Nothing else about the record is hidden from the new owner:
 *   they inherit the full service history, which is the point
 *
 * Staff-only, deliberately. A serial number is not proof of purchase and
 * neither is a request; somebody at the operator has to witness the transfer.
 */
export async function handOffSystem(instrumentId: number, toOrgId: number, opts?: {
  note?: string; keepPreviousAsViewer?: boolean;
}): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  const [to] = await db.select().from(orgs).where(eq(orgs.id, toOrgId));
  if (!to) return { error: "Unknown organization" };
  if (inst.ownerOrgId === toOrgId) return { error: `${to.name} already owns ${inst.externalId}` };
  const [from] = inst.ownerOrgId === null ? [] : await db.select().from(orgs).where(eq(orgs.id, inst.ownerOrgId));
  const note = (opts?.note ?? "").trim().slice(0, 300);

  // Freeze the outgoing owner's record BEFORE anything moves, so the dossier is
  // their tenure as it actually stood and nothing recorded afterwards leaks in.
  if (from) {
    const dossier = await composeSystemDossier(instrumentId, from.id);
    if (dossier) {
      await supersedeRecords(instrumentId, from.id, "handoff");
      await db.insert(engagementRecords).values({
        instrumentId, orgId: from.id, kind: "handoff", externalId: inst.externalId, label: dossier.label,
        revokedBy: u.email, data: dossier,
      });
    }
  }

  // The client label follows ownership when it WAS ownership, and is left alone
  // when somebody set it to something else on purpose - see lib/owner. Without
  // this a transfer moved the owner and left the system reading "Client: LabZen"
  // to everybody who opened it.
  const client = clientAfterHandoff(inst.client, from?.name ?? "", to.name);
  await db.update(instruments).set({ ownerOrgId: toOrgId, client }).where(eq(instruments.id, instrumentId));
  // The new owner needs to be able to see what they now own.
  await db.insert(systemShares)
    .values({ instrumentId, orgId: toOrgId, access: "edit", addedBy: u.email })
    .onConflictDoUpdate({ target: [systemShares.instrumentId, systemShares.orgId], set: { access: "edit" } });

  if (from) {
    if (opts?.keepPreviousAsViewer) {
      await db.update(systemShares).set({ access: "view" })
        .where(and(eq(systemShares.instrumentId, instrumentId), eq(systemShares.orgId, from.id)));
    } else {
      await db.delete(systemShares)
        .where(and(eq(systemShares.instrumentId, instrumentId), eq(systemShares.orgId, from.id)));
    }
  }

  await db.insert(custodyEvents).values({
    instrumentId, kind: "transfer",
    fromOrgId: from?.id ?? null, toOrgId,
    fromName: from?.name ?? "", toName: to.name,
    note, actor: u.email,
  });

  // Who's left with access, named in the audit line: after a handoff the first
  // question is always "so who can still see this?"
  const remaining = await db.select({ name: orgs.name })
    .from(systemShares).innerJoin(orgs, eq(orgs.id, systemShares.orgId))
    .where(and(eq(systemShares.instrumentId, instrumentId), ne(systemShares.orgId, toOrgId)));
  await audit({
    actor: u.email, instrumentId, entityType: "custody", entityId: inst.externalId,
    action: `handed ${inst.externalId} from ${from?.name ?? "house stewardship"} to ${to.name}`
      + (client !== inst.client ? `; client is now ${client}` : "")
      + (from ? `; ${from.name} keeps a frozen record${opts?.keepPreviousAsViewer ? " and read-only access" : " and loses access"}` : "")
      + (remaining.length ? `; still shared with ${remaining.map((r) => r.name).join(", ")}` : "")
      + (note ? ` - ${note}` : ""),
    field: "owner", oldValue: from?.name ?? "", newValue: to.name,
  });

  // Tell the new owner's people, and the outgoing owner's, in one go.
  const audience = await db.select({ entry: clientAllowlist.entry })
    .from(clientAllowlist)
    .where(from ? inArray(clientAllowlist.orgId, [toOrgId, from.id]) : eq(clientAllowlist.orgId, toOrgId));
  // Exact addresses only - an "@domain" entry names a domain, not a mailbox.
  const exact = audience.map((a) => a.entry.trim()).filter((e) => e.includes("@") && !e.startsWith("@"));
  if (exact.length) {
    await notifyHandoff({
      to: exact, externalId: inst.externalId, instrumentId,
      fromName: from?.name ?? "house stewardship", toName: to.name, note,
    });
  }
  rev(instrumentId);
  revalidatePath("/records");
  return {};
}

/**
 * Whose system it is. Ownership doesn't grant visibility (shares do) - it
 * says which client org's editors decide access requests. Setting it is the
 * house's call, and it's also the claim flow: when the real owner of an
 * unclaimed, provider-created system joins the platform, staff hand it over.
 *
 * For an actual change of hands use handOffSystem, which records custody and
 * settles the outgoing owner's access and record. This one is the blunt
 * correction: fixing a mis-assignment, or returning a system to the house.
 */
export async function setSystemOwner(
  instrumentId: number, orgId: number | null,
  // Accepted so this and setAssetOwnerOrg have one shape, and ignored: a
  // system's free-text label is `client`, and whether that is always the same
  // fact as its owner is not settled. See lib/owner.
  _typed = "",
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  let org: typeof orgs.$inferSelect | undefined;
  if (orgId !== null) {
    [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
    if (!org) return { error: "Not found" };
  }
  if (inst.ownerOrgId === orgId) return {};
  // Same rule as a handoff: a label that was naming the old owner follows, one
  // somebody wrote themselves does not. Assigning ownership by hand and moving
  // it by handoff must not leave the record saying two different things.
  const [was] = inst.ownerOrgId === null ? [] : await db.select().from(orgs).where(eq(orgs.id, inst.ownerOrgId));
  const client = clientAfterHandoff(inst.client, was?.name ?? "", org?.name ?? "");
  await db.update(instruments).set({ ownerOrgId: orgId, client }).where(eq(instruments.id, instrumentId));
  // An owner who can't see their own system helps no one: guarantee a share
  // (existing access levels are left alone).
  if (orgId !== null) {
    await db.insert(systemShares).values({ instrumentId, orgId, access: "edit", addedBy: u.email }).onConflictDoNothing();
  }
  await audit({
    actor: u.email, instrumentId, entityType: "instrument", entityId: inst.externalId,
    action: org ? `made ${org.name} the owner of ${inst.externalId}` : `returned ${inst.externalId} to house stewardship`,
    field: "owner", newValue: org?.name ?? "",
  });
  rev(instrumentId);
  return {};
}

// ---------------- CSV import ----------------
// The Excel migration path: rows become systems and their assets. Rows that
// share a System ID build one system; rows with no System ID become standalone
// shelf assets. Reuses createInstrument/createAsset so imported records get
// exactly the treatment hand-entered ones do (auto-share, ownership, checkout
// generation, audit).

export type ImportRow = {
  systemId: string; client: string; category: string; location: string;
  kind: string; model: string; serial: string; manufacturer: string; note: string;
  // Same columns the on-screen grid uses, so a template exported from one
  // imports through the other without rearranging anything.
  owner: string; asFound: string;
};
export type ImportRowResult = { row: number; action: string; error?: string };

const IMPORT_MAX_ROWS = 500;

export async function importFleet(rows: ImportRow[], dryRun: boolean): Promise<{
  error?: string; results?: ImportRowResult[]; systems?: number; assets?: number; duplicates?: number;
}> {
  const u = await requireEditor();
  if (!rows.length) return { error: "Nothing to import" };
  if (rows.length > IMPORT_MAX_ROWS) return { error: `Import ${IMPORT_MAX_ROWS} rows at a time (got ${rows.length})` };

  const existing = await db.select({ id: instruments.id, externalId: instruments.externalId }).from(instruments);
  const byExt = new Map(existing.map((i) => [i.externalId.toLowerCase(), i.id]));
  const extOf = new Map(existing.map((i) => [i.id, i.externalId]));
  const createdThisRun = new Map<string, number>(); // externalId -> new instrument id
  const results: ImportRowResult[] = [];
  let systemsMade = 0, assetsMade = 0, skippedDupes = 0;

  // Duplicate protection. Re-importing a sheet used to double the fleet; now a
  // row that already exists is skipped and says what it matched. Keyed on the
  // system's EXTERNAL id rather than its row id, because rows landing in a
  // system this run is about to create have no row id yet.
  const priorAssets = await db.select({
    id: assets.id, instrumentId: assets.instrumentId, kind: assets.kind, model: assets.model,
    serial: assets.serial, owner: assets.owner, location: assets.location,
  }).from(assets);
  const dupeFields = (a: typeof priorAssets[number]) => ({
    systemKey: a.instrumentId !== null ? (extOf.get(a.instrumentId) ?? "").toLowerCase() : "",
    kind: a.kind, model: a.model, serial: a.serial, owner: a.owner, location: a.location,
  });
  const describeKey = new Map<string, string>();
  for (const a of priorAssets) {
    const k = assetDupeKey(dupeFields(a));
    if (!describeKey.has(k)) {
      const where = a.instrumentId !== null ? ` in ${extOf.get(a.instrumentId) ?? "a system"}` : " on the shelf";
      describeKey.set(k, `${a.kind}${a.model ? ` ${a.model}` : ""}${a.serial ? ` SN ${a.serial}` : ""}${where}`);
    }
  }
  const planRow = importPlanner(priorAssets.map(dupeFields), (k) => describeKey.get(k) ?? "");

  for (let n = 0; n < rows.length; n++) {
    const r = rows[n];
    const sysId = r.systemId.trim();
    const kind = r.kind.trim();
    try {
      if (!kind && !sysId) { results.push({ row: n + 1, action: "skipped", error: "No system ID and no asset type" }); continue; }
      if (!kind) {
        // A row can name a system alone (header row for its assets).
        if (byExt.has(sysId.toLowerCase()) || createdThisRun.has(sysId.toLowerCase())) {
          results.push({ row: n + 1, action: `system ${sysId} already exists` });
          continue;
        }
        if (!dryRun) {
          const id = await createInstrument({ externalId: sysId, client: r.client.trim(), category: r.category.trim(), priority: 99 });
          createdThisRun.set(sysId.toLowerCase(), id);
        } else createdThisRun.set(sysId.toLowerCase(), -1);
        systemsMade++;
        results.push({ row: n + 1, action: `create system ${sysId}` });
        continue;
      }

      let instrumentId: number | null = null;
      let sysAction = "";
      if (sysId) {
        const known = createdThisRun.get(sysId.toLowerCase()) ?? byExt.get(sysId.toLowerCase()) ?? null;
        if (known !== null) {
          // Appending to an existing system needs edit rights on it.
          if (byExt.has(sysId.toLowerCase()) && !(await canEditSystem(u, known))) {
            results.push({ row: n + 1, action: "skipped", error: `No edit access to ${sysId}` });
            continue;
          }
          instrumentId = known;
          sysAction = `into ${sysId}`;
        } else {
          if (!dryRun) {
            instrumentId = await createInstrument({ externalId: sysId, client: r.client.trim(), category: r.category.trim(), priority: 99 });
            createdThisRun.set(sysId.toLowerCase(), instrumentId);
          } else { createdThisRun.set(sysId.toLowerCase(), -1); instrumentId = -1; }
          systemsMade++;
          sysAction = `into new system ${sysId}`;
        }
      } else {
        sysAction = "standalone (shelf)";
      }

      // Already on file? Skip it and say so. Checked after the system is
      // resolved, since a serial-less row is only a duplicate within its own
      // system. The planner spends down existing copies as it goes, so a sheet
      // legitimately listing three identical units still tops up to three.
      const verdict = planRow({
        systemKey: sysId.toLowerCase(), kind, model: r.model.trim(), serial: r.serial.trim(),
        owner: (r.owner || r.client).trim(), location: r.location.trim(),
      });
      if (verdict.skip) {
        skippedDupes++;
        // Reported through `action`, not `error`: a skipped duplicate is the
        // importer working, not a row the person has to go fix.
        results.push({ row: n + 1, action: `skipped, ${verdict.reason}` });
        continue;
      }

      if (!dryRun) {
        const res = await createAsset(instrumentId === -1 ? null : instrumentId, {
          kind, model: r.model.trim(), serial: r.serial.trim(), manufacturer: r.manufacturer.trim(),
          // An explicit Owner column wins; falling back to Client keeps older
          // templates working.
          owner: (r.owner || r.client).trim(), asFound: (r.asFound ?? "").trim(),
          location: r.location.trim(), note: r.note.trim(),
        });
        if (res.error) { results.push({ row: n + 1, action: "failed", error: res.error }); continue; }
      }
      assetsMade++;
      results.push({ row: n + 1, action: `add ${kind}${r.model ? ` ${r.model.trim()}` : ""} ${sysAction}` });
    } catch (e) {
      results.push({ row: n + 1, action: "failed", error: (e as Error).message });
    }
  }

  if (!dryRun && (systemsMade || assetsMade)) {
    // The catalog is the only source of truth for types, models and
    // categories, so a migration registers what it brings in - otherwise the
    // imported fleet would be full of equipment no picker can name again.
    const vocab = await db.select().from(vocabTerms);
    const has = (kind: string, at: string, name: string) => vocab.some((v) =>
      v.kind === kind && v.assetType.toLowerCase() === at.toLowerCase() && v.name.toLowerCase() === name.toLowerCase());
    const newTerms: { kind: string; assetType: string; name: string }[] = [];
    for (const r of rows) {
      const kind = r.kind.trim(), model = r.model.trim(), cat = r.category.trim();
      if (kind && !has("asset_type", "", kind) && !newTerms.some((t) => t.kind === "asset_type" && t.name.toLowerCase() === kind.toLowerCase()))
        newTerms.push({ kind: "asset_type", assetType: "", name: kind });
      if (kind && model && !has("model", kind, model) && !newTerms.some((t) => t.kind === "model" && t.assetType.toLowerCase() === kind.toLowerCase() && t.name.toLowerCase() === model.toLowerCase()))
        newTerms.push({ kind: "model", assetType: kind, name: model });
      if (cat && !has("category", "", cat) && !newTerms.some((t) => t.kind === "category" && t.name.toLowerCase() === cat.toLowerCase()))
        newTerms.push({ kind: "category", assetType: "", name: cat });
    }
    if (newTerms.length) {
      await db.insert(vocabTerms).values(newTerms.map((t) => ({ ...t, tenantOrgId: myTenantOrgId(u) }))).onConflictDoNothing();
      await audit({
        actor: u.email, entityType: "vocab", entityId: "csv-import",
        action: `import added ${newTerms.length} catalog term(s) - review in Settings > Catalog`,
      });
      revalidatePath("/settings/catalog");
    }
    await audit({
      actor: u.email, entityType: "settings", entityId: "csv-import",
      action: `imported ${systemsMade} system(s) and ${assetsMade} asset(s) from CSV`,
    });
    rev();
    revalidatePath("/assets");
  }
  return { results, systems: systemsMade, assets: assetsMade, duplicates: skippedDupes };
}

// ---------------- View as ----------------

/**
 * Walk the portal with an organization's permissions. Gated on the REAL
 * session being the owner's - a persona can't grant itself another one, and it
 * can always be exited even though the persona itself may not reach Settings.
 * Nothing is impersonated but authorization: writes stay audited under the
 * owner's own email.
 */
/**
 * Sign out. An exported action rather than an inline one, because the control
 * now lives in the account menu - a client component, which cannot declare a
 * server action inside itself.
 */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}

export async function setViewAs(orgId: number | null, mode: "editor" | "viewer" = "editor"): Promise<{ error?: string }> {
  const real = await requireRealOwner();
  const jar = await cookies();
  if (orgId === null) {
    jar.delete(VIEW_AS_COOKIE);
  } else {
    const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
    if (!org) return { error: "Not found" };
    jar.set(VIEW_AS_COOKIE, `${orgId}:${mode}`, {
      httpOnly: true, sameSite: "lax", path: "/",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 8, // a working day, then back to yourself
    });
    // Audited: a record of when the operator was looking through other eyes.
    await audit({
      actor: real.email, entityType: "settings", entityId: "view_as",
      action: `started viewing the portal as ${org.name} (${mode})`,
    });
  }
  revalidatePath("/", "layout");
  return {};
}

// ---------------- Asset sharing ----------------
// The standalone-asset twin of system sharing: a spare's dossier shown to any
// number of organizations. Staff share with anyone; the asset's owner-org
// editors may bring in (and withdraw) provider orgs only - same split as
// systems, enforced here regardless of what the UI offers.

async function assetShareGate(u: SessionUser, assetId: number, org: { id: number; kind: string }): Promise<{ error?: string; asset?: typeof assets.$inferSelect }> {
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!asset) return { error: "Not found" };
  if (!houseOf(u, asset.tenantOrgId)) {
    const ownerEditor = asset.ownerOrgId !== null && asset.ownerOrgId === u.orgId && u.role === "client_editor";
    if (!ownerEditor) return { error: "Not found" };
    if (org.kind !== "provider") return { error: "You can only bring in a service provider" };
    if (org.id === u.orgId) return { error: "That's your own organization" };
  }
  return { asset };
}

export async function shareAsset(assetId: number, orgId: number, access: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Pick an organization" };
  const gate = await assetShareGate(u, assetId, org);
  if (gate.error || !gate.asset) return { error: gate.error };
  const level = access === "edit" ? "edit" : "view";
  const [existing] = await db.select().from(assetShares)
    .where(and(eq(assetShares.assetId, assetId), eq(assetShares.orgId, orgId)));
  if (existing) {
    if (existing.access === level) return {};
    await db.update(assetShares).set({ access: level }).where(eq(assetShares.id, existing.id));
  } else {
    await db.insert(assetShares).values({ assetId, orgId, access: level, addedBy: u.email });
  }
  await audit({
    actor: u.email, assetId, entityType: "share", entityId: assetLabel(gate.asset),
    action: `${existing ? "changed" : "granted"} ${org.name} ${level} access to ${assetLabel(gate.asset)}`,
    field: "access", oldValue: existing?.access ?? "", newValue: level,
  });
  revalidatePath(`/assets/${assetId}`);
  revalidatePath("/assets");
  return {};
}

export async function unshareAsset(assetId: number, orgId: number): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };
  const gate = await assetShareGate(u, assetId, org);
  if (gate.error || !gate.asset) return { error: gate.error };
  await db.delete(assetShares).where(and(eq(assetShares.assetId, assetId), eq(assetShares.orgId, orgId)));
  await audit({
    actor: u.email, assetId, entityType: "share", entityId: assetLabel(gate.asset),
    action: `removed ${org.name}'s access to ${assetLabel(gate.asset)}`,
  });
  revalidatePath(`/assets/${assetId}`);
  revalidatePath("/assets");
  return {};
}

/** Staff-only owner reassign, matching setSystemOwner. */
/**
 * Who owns a unit - the link AND the label, written together.
 *
 * A unit carried both and let them be set in two different places, so it could
 * say "LabZen" on the row while LabZen genuinely could not see it. The name now
 * follows the organization (lib/owner); `typed` is only read when no
 * organization is chosen, for a company that is not on the platform at all.
 */
export async function setAssetOwnerOrg(
  assetId: number, orgId: number | null, typed = "",
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!asset) return { error: "Not found" };
  const visible = await visibleOrgs(u);
  if (orgId !== null && !visible.some((o) => o.id === orgId)) return { error: "Not found" };
  const next = ownerFields(orgId, typed, visible.map((o) => ({ id: o.id, name: o.name })));
  if (asset.ownerOrgId === next.orgId && asset.owner === next.name) return {};
  await db.update(assets).set({ ownerOrgId: next.orgId, owner: next.name }).where(eq(assets.id, assetId));
  await audit({
    actor: u.email, assetId, entityType: "asset", entityId: assetId,
    action: next.orgId !== null
      ? `made ${next.name} the owner of ${assetLabel(asset)}`
      : next.name
        ? `recorded ${next.name} as the owner of ${assetLabel(asset)} (not an organization on this instance)`
        : `returned ${assetLabel(asset)} to house stewardship`,
    field: "owner", oldValue: asset.owner, newValue: next.name,
  });
  revalidatePath(`/assets/${assetId}`);
  revalidatePath("/assets");
  return {};
}

// ---------------- For sale ----------------
// Resale is the owner's call: staff, or the owning organization's editors.
// While a system is for sale, its listing token serves a public, heavily
// redacted page (app/listing) - history and opted-in reports, never location,
// client identity, internal notes, or pricing.

function canSell(u: SessionUser, inst: { ownerOrgId: number | null }): boolean {
  if (isHouse(u.role)) return true;
  return inst.ownerOrgId !== null && inst.ownerOrgId === u.orgId && u.role === "client_editor";
}

export async function setForSale(instrumentId: number, on: boolean, saleNote: string): Promise<{ error?: string; token?: string }> {
  const u = await requireEditor();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  if (!canSell(u, inst)) {
    return { error: (await canSeeSystemSafe(u, instrumentId)) ? "Only the system's owner can list it for sale" : "Not found" };
  }
  // The token survives unmarking - the URL just goes dead - so a re-list keeps
  // any links already shared with buyers.
  const token = inst.listingToken || crypto.randomBytes(18).toString("base64url");
  await db.update(instruments)
    .set({ forSale: on, saleNote: saleNote.trim().slice(0, 500), listingToken: token })
    .where(eq(instruments.id, instrumentId));
  await audit({
    actor: u.email, instrumentId, entityType: "instrument", entityId: inst.externalId,
    action: on
      ? `listed ${inst.externalId} for sale - the public listing shows service history and chosen files only`
      : `took ${inst.externalId} off the market - its listing page is dead`,
    field: "for_sale", oldValue: String(inst.forSale), newValue: String(on),
  });
  rev(instrumentId);
  return { token };
}

/** The asset twin of setForSale - same contract, gated on the asset's owner. */
export async function setAssetForSale(assetId: number, on: boolean, saleNote: string): Promise<{ error?: string; token?: string }> {
  const u = await requireEditor();
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!asset) return { error: "Not found" };
  const seller = isHouse(u.role) || (asset.ownerOrgId !== null && asset.ownerOrgId === u.orgId && u.role === "client_editor");
  if (!seller) {
    const a = await assetAccess(u, assetId);
    return { error: a.see ? "Only the asset's owner can list it for sale" : "Not found" };
  }
  const token = asset.listingToken || crypto.randomBytes(18).toString("base64url");
  await db.update(assets)
    .set({ forSale: on, saleNote: saleNote.trim().slice(0, 500), listingToken: token })
    .where(eq(assets.id, assetId));
  await audit({
    actor: u.email, assetId, instrumentId: asset.instrumentId, entityType: "asset", entityId: assetId,
    action: on
      ? `listed ${assetLabel(asset)} for sale - the public listing shows its history and chosen files only`
      : `took ${assetLabel(asset)} off the market - its listing page is dead`,
    field: "for_sale", oldValue: String(asset.forSale), newValue: String(on),
  });
  revalidatePath(`/assets/${assetId}`);
  revalidatePath("/assets");
  return { token };
}

export async function setAttachmentListed(attachmentId: number, on: boolean): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [file] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  if (!file) return { error: "Not found" };
  // Curation follows whoever may sell the thing the file belongs to.
  if (file.instrumentId !== null) {
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, file.instrumentId));
    if (!inst) return { error: "Not found" };
    if (!canSell(u, inst)) {
      return { error: (await canSeeSystemSafe(u, file.instrumentId)) ? "Only the owner curates the listing" : "Not found" };
    }
  } else if (file.assetId !== null) {
    const [asset] = await db.select().from(assets).where(eq(assets.id, file.assetId));
    if (!asset) return { error: "Not found" };
    const seller = isHouse(u.role) || (asset.ownerOrgId !== null && asset.ownerOrgId === u.orgId && u.role === "client_editor");
    if (!seller) {
      const a = await assetAccess(u, file.assetId);
      return { error: a.see ? "Only the owner curates the listing" : "Not found" };
    }
  } else {
    return { error: "Not found" };
  }
  await db.update(attachments).set({ showOnListing: on }).where(eq(attachments.id, attachmentId));
  await audit({
    actor: u.email, instrumentId: file.instrumentId, assetId: file.assetId, entityType: "attachment", entityId: attachmentId,
    action: `${on ? "added" : "removed"} '${file.fileName}' ${on ? "to" : "from"} the public listing`,
  });
  if (file.instrumentId !== null) rev(file.instrumentId);
  if (file.assetId !== null) revalidatePath(`/assets/${file.assetId}`);
  return {};
}

// ---------------- Serial lookup & access requests ----------------
// The way in from outside: a provider matches an instrument by its exact
// serial number. If someone on the platform owns it, they knock (access
// request, decided by staff or the owning org's editors); if nobody does,
// they create it as an unclaimed system and start its service history.

/** Who decides on (and hears about) an access request: staff, plus the owning org's sign-in emails. */
async function ownerAudience(ownerOrgId: number | null, tenantOrgId?: number | null): Promise<string[]> {
  const staff = await houseEmails(tenantOrgId);
  if (ownerOrgId === null) return staff;
  const entries = await db.select().from(clientAllowlist).where(eq(clientAllowlist.orgId, ownerOrgId));
  // A @domain entry names no one in particular, so it can't be a recipient.
  const ownerEmails = entries.filter((e) => !e.entry.trim().startsWith("@")).map((e) => e.entry.toLowerCase());
  return [...new Set([...staff, ...ownerEmails])];
}

export async function requestAccess(serial: string, message: string, kind = "access"): Promise<{ error?: string; ok?: boolean }> {
  const u = await requireUser();
  if (u.orgId === null) return { error: "Staff already see every system" };
  // Any organization may own equipment - a service company owns its warehouse
  // stock - so any organization may claim it. The operator still rules on it.
  const want = kind === "claim" ? "claim" : "access";
  const norm = normalizeSerial(serial);
  if (norm.length < MIN_SERIAL_LOOKUP) return { error: "Serial number too short" };
  // Re-resolve the serial here: a request must come from a real match typed
  // into /lookup, never from a guessed system id.
  const rows = await db.select().from(assets).where(sql`lower(btrim(${assets.serial})) = ${norm}`);
  const target = rows.find((a) => a.instrumentId !== null);
  if (!target || target.instrumentId === null) return { error: "No system with that serial" };
  const instrumentId = target.instrumentId;
  if (await canSeeSystemSafe(u, instrumentId)) return { error: "You already have access to this system" };
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "No system with that serial" };
  const pending = await db.select().from(accessRequests).where(and(
    eq(accessRequests.instrumentId, instrumentId), eq(accessRequests.orgId, u.orgId), eq(accessRequests.status, "pending")));
  if (pending.length) return { ok: true }; // already asked; asking louder wouldn't help
  await db.insert(accessRequests).values({
    instrumentId, orgId: u.orgId, kind: want, requestedBy: u.email, message: message.trim().slice(0, 500),
  });
  await audit({
    actor: u.email, instrumentId, entityType: "access_request", entityId: inst.externalId,
    action: want === "claim"
      ? `${u.orgName || u.email} claimed ownership of ${inst.externalId} (matched serial ${target.serial}) - awaiting review`
      : `${u.orgName || u.email} requested access to ${inst.externalId} (matched serial ${target.serial})`,
  });
  await notifyAccessRequest({
    to: await ownerAudience(inst.ownerOrgId), actorName: u.name, orgName: u.orgName ?? "",
    externalId: inst.externalId, instrumentId,
    assetDesc: `${target.kind}${target.model ? ` ${target.model}` : ""} · SN ${target.serial}`,
    message: message.trim(), kind: want,
  });
  rev(instrumentId);
  return { ok: true };
}

/**
 * Who decides a request: the platform operator always, and for a plain access
 * request the owning organization's editors too. A claim is different - it
 * asserts ownership, so the current owner is the counterparty to it and cannot
 * rule on it. Only the operator can, which is also what makes a wrongly
 * granted claim fixable.
 */
async function assertRequestDecider(u: SessionUser, instrumentId: number, kind = "access") {
  if (isHouse(u.role)) return;
  if (kind === "claim") throw new Error("Not found");
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst || inst.ownerOrgId === null || inst.ownerOrgId !== u.orgId || u.role !== "client_editor") {
    throw new Error("Not found");
  }
}

export async function approveAccessRequest(requestId: number, access: string): Promise<{ error?: string }> {
  const u = await requireUser();
  const [req] = await db.select().from(accessRequests).where(eq(accessRequests.id, requestId));
  if (!req || req.status !== "pending") return { error: "Not found" };
  try { await assertRequestDecider(u, req.instrumentId, req.kind); } catch { return { error: "Not found" }; }
  const level = access === "edit" ? "edit" : "view";
  const [[org], [inst]] = await Promise.all([
    db.select().from(orgs).where(eq(orgs.id, req.orgId)),
    db.select().from(instruments).where(eq(instruments.id, req.instrumentId)),
  ]);
  if (!org || !inst) return { error: "Not found" };
  await db.insert(systemShares)
    .values({ instrumentId: req.instrumentId, orgId: req.orgId, access: level, addedBy: u.email })
    .onConflictDoUpdate({ target: [systemShares.instrumentId, systemShares.orgId], set: { access: level } });
  await db.update(accessRequests)
    .set({ status: "approved", decidedBy: u.email, decidedAt: new Date() })
    .where(eq(accessRequests.id, requestId));
  await audit({
    actor: u.email, instrumentId: req.instrumentId, entityType: "access_request", entityId: inst.externalId,
    action: req.kind === "claim"
      // Access without ownership: the third answer to a claim, when someone
      // should see the record but hasn't shown the instrument is theirs.
      ? `gave ${org.name} ${level} access to ${inst.externalId} without granting their ownership claim`
      : `approved ${org.name}'s access request for ${inst.externalId} (${level})`,
    field: "access", newValue: level,
  });
  rev(req.instrumentId);
  return {};
}

/**
 * Grant an ownership claim: the share and the owner seat in one action, so a
 * verified owner doesn't need a second trip through the sharing panel. Operator
 * only, and only a client organization can end up owning the system.
 */
export async function approveClaim(requestId: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [req] = await db.select().from(accessRequests).where(eq(accessRequests.id, requestId));
  if (!req || req.status !== "pending") return { error: "Not found" };
  const [[org], [inst]] = await Promise.all([
    db.select().from(orgs).where(eq(orgs.id, req.orgId)),
    db.select().from(instruments).where(eq(instruments.id, req.instrumentId)),
  ]);
  if (!org || !inst) return { error: "Not found" };
  const previous = inst.ownerOrgId;
  const [prevOrg] = previous === null ? [] : await db.select().from(orgs).where(eq(orgs.id, previous));
  // An owner must be able to work the system it owns, so the share is edit.
  await db.insert(systemShares)
    .values({ instrumentId: req.instrumentId, orgId: req.orgId, access: "edit", addedBy: u.email })
    .onConflictDoUpdate({ target: [systemShares.instrumentId, systemShares.orgId], set: { access: "edit" } });
  await db.update(instruments).set({ ownerOrgId: req.orgId }).where(eq(instruments.id, req.instrumentId));
  await db.update(accessRequests)
    .set({ status: "approved", decidedBy: u.email, decidedAt: new Date() })
    .where(eq(accessRequests.id, requestId));
  // The displaced owner keeps whatever share it had - taking a system away is a
  // separate, deliberate act in the operator console.
  await audit({
    actor: u.email, instrumentId: req.instrumentId, entityType: "instrument", entityId: inst.externalId,
    action: `granted ${org.name}'s ownership claim on ${inst.externalId}${prevOrg ? ` - taken over from ${prevOrg.name}, whose access was left in place` : ""}`,
    field: "owner", oldValue: prevOrg?.name ?? "", newValue: org.name,
  });
  rev(req.instrumentId);
  return {};
}

export async function denyAccessRequest(requestId: number): Promise<{ error?: string }> {
  const u = await requireUser();
  const [req] = await db.select().from(accessRequests).where(eq(accessRequests.id, requestId));
  if (!req || req.status !== "pending") return { error: "Not found" };
  try { await assertRequestDecider(u, req.instrumentId, req.kind); } catch { return { error: "Not found" }; }
  const [[org], [inst]] = await Promise.all([
    db.select().from(orgs).where(eq(orgs.id, req.orgId)),
    db.select().from(instruments).where(eq(instruments.id, req.instrumentId)),
  ]);
  await db.update(accessRequests)
    .set({ status: "denied", decidedBy: u.email, decidedAt: new Date() })
    .where(eq(accessRequests.id, requestId));
  await audit({
    actor: u.email, instrumentId: req.instrumentId, entityType: "access_request", entityId: inst?.externalId ?? "",
    action: `denied ${org?.name ?? "an organization"}'s access request for ${inst?.externalId ?? "a system"}`,
  });
  rev(req.instrumentId);
  return {};
}

/**
 * The no-match path on /lookup: create the instrument as a new system and put
 * the serial on it as its first asset. Created by a provider it stays
 * unclaimed (owner_org_id null, house-stewarded) until the real owner joins
 * the platform and staff hand it over.
 */
export async function createSystemFromSerial(data: {
  externalId: string; client: string; category: string;
  kind: string; model: string; manufacturer: string; serial: string;
}): Promise<{ error?: string; id?: number }> {
  await requireEditor();
  const ext = data.externalId.trim();
  if (!ext) return { error: "Give the system an ID" };
  const norm = normalizeSerial(data.serial);
  if (norm.length < MIN_SERIAL_LOOKUP) return { error: "Serial number too short" };
  const [dup] = await db.select().from(instruments).where(eq(instruments.externalId, ext));
  if (dup) return { error: `${ext} is already taken` };
  // Same instrument, two records helps no one - if the serial sits on a
  // system somewhere, the door is the access request, not a twin entry.
  const existing = await db.select().from(assets).where(sql`lower(btrim(${assets.serial})) = ${norm}`);
  if (existing.some((a) => a.instrumentId !== null)) {
    return { error: "That serial is already on a system here - request access instead" };
  }
  const id = await createInstrument({ externalId: ext, client: data.client, category: data.category, priority: 99 });
  const res = await createAsset(id, {
    kind: data.kind, model: data.model, serial: data.serial.trim(), manufacturer: data.manufacturer,
    owner: data.client, asFound: "", location: "", note: "",
  });
  if (res.error) return { error: res.error };
  return { id };
}

/**
 * Workspace appearance: an organization's editors paint their own workspace;
 * the platform owner may repaint any org (including the operator's, and
 * anything that came out unreadable). Color is validated server-side and the
 * logo must be a blob URL this app minted - no hot-linking arbitrary hosts
 * into every page header.
 */
export async function setOrgAppearance(
  data: { themeColor: string; logoUrl: string },
  orgId?: number,
): Promise<{ error?: string }> {
  const u = await requireEditor();
  let target: number;
  if (orgId !== undefined && orgId !== u.orgId) {
    if (u.role !== "owner") return { error: "Not found" };
    target = orgId;
  } else {
    if (u.orgId === null) return { error: "Pick an organization" }; // staff use the Settings controls
    target = u.orgId;
  }
  const color = data.themeColor.trim();
  if (color && !isValidHex(color)) return { error: "Color must be a hex value like #2E6B2E" };
  const logo = data.logoUrl.trim();
  if (logo && !/^https:\/\/[^/]+\.public\.blob\.vercel-storage\.com\//.test(logo)) {
    return { error: "Upload the logo here rather than linking one" };
  }
  const [org] = await db.select().from(orgs).where(eq(orgs.id, target));
  if (!org) return { error: "Not found" };
  await db.update(orgs).set({ themeColor: color, logoUrl: logo }).where(eq(orgs.id, target));
  await audit({
    actor: u.email, entityType: "org", entityId: target,
    action: `updated ${org.name}'s workspace appearance${color ? ` (${color})` : " (default look)"}${logo ? " with a logo" : ""}`,
  });
  revalidatePath("/", "layout");
  revalidatePath("/settings");
  return {};
}

export async function addOrg(name: string, kind: string): Promise<{ error?: string; id?: number }> {
  // Any operator's staff, for their own workspace. This is the verb that makes
  // the product sellable to another service company: their clients are theirs to
  // create, not something they file a request for.
  const u = await requireStaff();
  if (!mayCreateOrgs(tenantViewer(u))) return { error: "Not found" };
  const n = name.trim();
  if (!n || n.length > 60) return { error: "Name must be 1-60 characters" };
  const k = kind === "provider" ? "provider" : "client";
  const existing = await db.select().from(orgs);
  if (existing.some((o) => o.name.toLowerCase() === n.toLowerCase())) return { error: `${n} already exists` };
  const [row] = await db.insert(orgs).values({
    name: n, kind: k,
    // A client belongs to the workspace that created it; that parent is what
    // every tenancy rule reads afterwards.
    parentOrgId: myTenantOrgId(u),
  }).returning();
  await audit({
    actor: u.email, entityType: "org", entityId: row.id, tenantOrgId: myTenantOrgId(u),
    action: `created ${k} organization "${n}"`,
  });
  revalidatePath("/settings");
  return { id: row.id };
}

export async function removeOrg(orgId: number, reason: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const gate = await adminOrgGate(u, orgId);
  if ("error" in gate) return {};
  const { org } = gate;
  // Cascades take the shares and allowlist entries with it, which is the point:
  // their logins stop working and their access disappears in one step.
  await db.delete(orgs).where(eq(orgs.id, orgId));
  await audit({
    actor: u.email, entityType: "org", entityId: orgId,
    action: `removed organization "${org.name}" - its shares and sign-in entries went with it - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revalidatePath("/settings");
  rev();
  return {};
}

/**
 * What this instance calls itself. The portal is a product, so its name is data
 * rather than a string in the source - see lib/brand.ts.
 */
export async function setBranding(data: { name: string; tagline: string }): Promise<{ error?: string }> {
  const u = await requirePlatformOwner();
  const name = data.name.trim().slice(0, 60);
  const tagline = data.tagline.trim().slice(0, 80);
  if (!name) return { error: "Give the platform a name" };
  await db.insert(appSettings).values({ id: 1, platformName: name, platformTagline: tagline })
    .onConflictDoUpdate({ target: appSettings.id, set: { platformName: name, platformTagline: tagline } });
  await audit({
    actor: u.email, entityType: "settings", entityId: "branding",
    action: `renamed the platform to "${name}"${tagline ? ` (${tagline})` : ""}`,
    field: "platform_name", newValue: name,
  });
  revalidatePath("/", "layout");
  return {};
}

/**
 * Which organization is the service business running this instance. It is an
 * ordinary provider org - this only says whose name goes on the documents the
 * platform generates, and which org inherits systems the operator creates.
 */
export async function setOperatorOrg(orgId: number | null): Promise<{ error?: string }> {
  const u = await requirePlatformOwner();
  const [org] = orgId === null ? [] : await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (orgId !== null && !org) return { error: "Not found" };
  await db.update(appSettings).set({ operatorOrgId: orgId }).where(eq(appSettings.id, 1));
  await audit({
    actor: u.email, entityType: "settings", entityId: "operator_org",
    action: org ? `${org.name} now operates this instance` : "cleared the operating organization",
  });
  revalidatePath("/", "layout");
  revalidatePath("/settings");
  return {};
}

/** Optional modules, per instance. A fresh install ships with all of them off. */
const MODULES = {
  sheetSync: { col: "sheetSyncEnabled", label: "sheet tracker sync" },
  eod: { col: "eodEnabled", label: "EOD client report" },
  digest: { col: "digestEnabled", label: "daily digest" },
  remote: { col: "remoteEnabled", label: "remote support" },
  publicCatalog: { col: "publicCatalogEnabled", label: "public equipment library" },
} as const;

export async function setModule(
  moduleKey: keyof typeof MODULES, on: boolean,
): Promise<{ error?: string }> {
  const u = await requirePlatformOwner();
  const m = MODULES[moduleKey];
  if (!m) return { error: "Unknown module" };
  await db.update(appSettings).set({ [m.col]: on }).where(eq(appSettings.id, 1));
  const label = m.label;
  await audit({
    actor: u.email, entityType: "settings", entityId: `module_${moduleKey}`,
    action: `turned the ${label} ${on ? "on" : "off"}`,
  });
  revalidatePath("/", "layout");
  revalidatePath("/settings");
  return {};
}

export async function setSheetOrg(orgId: number | null) {
  const u = await requirePlatformOwner();
  const [org] = orgId === null ? [] : await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (orgId !== null && !org) return;
  await db.update(appSettings).set({ sheetOrgId: orgId }).where(eq(appSettings.id, 1));
  await audit({
    actor: u.email, entityType: "settings", entityId: "sheet_org",
    action: org ? `the tracker sheet and EOD report now cover ${org.name}` : "cleared the tracker/EOD organization",
  });
  revalidatePath("/settings");
  revalidatePath("/eod");
  return;
}

// ---------------- Vocabulary ----------------
// Categories and models defined ahead of use, so a checkout test can be
// scoped to a model the shop hasn't stocked yet. Pickers merge these with
// values already in use.

export async function addVocabTerm(
  kind: string, assetType: string, name: string, categories: string[] = [], manufacturer = "",
): Promise<{ error?: string }> {
  // The catalog is house-curated: the owner and their staff, never clients.
  const u = await requireStaff();
  if (kind !== "category" && kind !== "model" && kind !== "asset_type" && kind !== "maker") return { error: "Unknown vocabulary kind" };
  const at = kind === "model" ? assetType.trim() : "";
  if (kind === "model" && !at) return { error: "Pick which asset type the model belongs to" };
  const n = name.trim();
  if (!n || n.length > 60) return { error: "Name must be 1-60 characters" };
  const cats = kind === "model" ? [...new Set(categories.map((c) => c.trim()).filter(Boolean))] : [];
  const existing = await db.select().from(vocabTerms).where(eq(vocabTerms.kind, kind));
  const clash = existing.find((t) => t.assetType.toLowerCase() === at.toLowerCase() && t.name.toLowerCase() === n.toLowerCase());
  if (clash) {
    // One row per model: the same name under a second system type widens the
    // existing row rather than colliding with it.
    if (kind === "model" && cats.length && clash.categories.length) {
      const merged = [...new Set([...clash.categories, ...cats])];
      if (merged.length > clash.categories.length) {
        await db.update(vocabTerms).set({ categories: merged }).where(eq(vocabTerms.id, clash.id));
        await audit({
          actor: u.email, entityType: "vocab", entityId: clash.id,
          action: `model "${n}" (${at}) now also applies to ${cats.join(", ")}`,
          field: "categories", oldValue: clash.categories.join(", "), newValue: merged.join(", "),
        });
        revalidatePath("/settings/catalog");
        rev();
        return {};
      }
    }
    return { error: `${n} is already defined` };
  }
  const [row] = await db.insert(vocabTerms)
    .values({
      tenantOrgId: myTenantOrgId(u),
      kind, assetType: at, name: n, categories: cats, manufacturer: kind === "model" ? manufacturer.trim() : "",
    })
    .returning();
  await audit({
    actor: u.email, entityType: "vocab", entityId: row.id,
    action: kind === "category" ? `defined system category "${n}"`
      : kind === "asset_type" ? `defined asset type "${n}"`
      : kind === "maker" ? `added "${n}" to the manufacturer & vendor book`
      : `defined model "${n}"${manufacturer.trim() ? ` by ${manufacturer.trim()}` : ""} for ${at}${cats.length ? ` under ${cats.join(", ")}` : " (all system types)"}`,
  });
  revalidatePath("/settings/catalog");
  revalidatePath("/checkout");
  revalidatePath("/maintenance");
  rev();
  return {};
}

/**
 * Several catalog terms at once - the spreadsheet path, same shape as the asset
 * grid. Each row goes through the same validation as a single add, and a row
 * that fails is reported by index rather than aborting the batch: entering
 * thirty models and losing them all to one duplicate is the thing that makes
 * people stop using the catalog.
 */
export async function addVocabTerms(
  rows: { kind: string; assetType: string; name: string; categories?: string[]; manufacturer?: string }[],
): Promise<{ error?: string; created?: number; failures?: { row: number; name: string; error: string }[] }> {
  await requireStaff();
  const usable = rows.filter((r) => r.name.trim());
  if (!usable.length) return { error: "Nothing to save - every row needs a name" };
  if (usable.length > 300) return { error: "Save 300 rows at a time" };
  const failures: { row: number; name: string; error: string }[] = [];
  let created = 0;
  for (let i = 0; i < usable.length; i++) {
    const r = usable[i];
    const res = await addVocabTerm(r.kind, r.assetType, r.name, r.categories ?? [], r.manufacturer ?? "");
    if (res.error) failures.push({ row: i + 1, name: r.name.trim(), error: res.error });
    else created++;
  }
  return { created, failures };
}

// ── House members (owner / staff) ───────────────────────────────────────────
// Owner-only, and every path goes through memberGuard so the four ways an owner
// could lock themselves or the instance out are refused in one place rather
// than three. The first STAFF_EMAILS entry stays an un-revocable root owner:
// managing roles in a database means a mistake is possible, and this is the way
// back in when one happens.

const revHouse = () => {
  revalidatePath("/settings/admin");
  revalidatePath("/", "layout");
};

async function guardFor(actorEmail: string, subjectEmail: string, next: "owner" | "staff" | "revoke") {
  const members = await houseMemberRows();
  return { members, guard: memberGuard({ actorEmail, subjectEmail, next, envStaff: parseList(process.env.STAFF_EMAILS), members }) };
}



// ---------------- How I sign in ----------------
// Both of these are set by the person themselves, signed in, and that is what
// makes them safe: the address was proved by the email path before either
// existed, so neither is a way to GET an account - only a second way back into
// one when email stops arriving.

/** Set or change my own password. */
export async function setMyPassword(password: string): Promise<{ error?: string }> {
  const u = await requireUser();
  const res = await setPasswordFor(u.email, password);
  if (res.error) return res;
  await audit({
    actor: u.email, entityType: "auth", entityId: u.email,
    action: "set a sign-in password for their own account",
  });
  revalidatePath("/inbox");
  return {};
}

/** Forget it. Codes never stopped working, so this takes nothing away. */
export async function clearMyPassword(): Promise<{ error?: string }> {
  const u = await requireUser();
  await clearPasswordFor(u.email);
  await audit({
    actor: u.email, entityType: "auth", entityId: u.email,
    action: "removed the sign-in password from their own account",
  });
  revalidatePath("/inbox");
  return {};
}

/** Where to text my codes. Blank removes it. */
export async function setMyPhone(raw: string): Promise<{ error?: string }> {
  const u = await requireUser();
  const phone = raw.trim() ? normalizePhone(raw) : "";
  if (raw.trim() && !phone) return { error: "That doesn't look like a mobile number." };
  await db.update(users).set({ phone }).where(eq(users.email, u.email.toLowerCase()));
  await audit({
    actor: u.email, entityType: "auth", entityId: u.email,
    // The number itself is not written to the log: an audit line is read by more
    // people than a phone number should be.
    action: phone ? "added a mobile number for sign-in codes" : "removed their mobile number",
  });
  revalidatePath("/inbox");
  return {};
}

/**
 * What everybody else calls you.
 *
 * Theirs to set, not the owner's. Before this, a name was whatever somebody
 * typed when they added you - usually nothing - and the directory fell back to
 * guessing one out of your email address. It is the name on your task
 * assignments, your @mentions, your signatures and your hours, so it should be
 * the one you answer to.
 */
export async function setMyName(raw: string): Promise<{ error?: string }> {
  const u = await requireUser();
  const name = raw.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!name) return { error: "A name can't be blank." };
  if (name === u.name) return {};
  await db.update(users).set({ name }).where(eq(users.email, u.email.toLowerCase()));
  await audit({
    actor: u.email, entityType: "auth", entityId: u.email,
    action: `changed their display name to ${name}`,
    field: "name", oldValue: u.name, newValue: name,
  });
  // Their name is on assignee pickers and mention lists across the app, and the
  // session carries it - so everything, and it takes effect on the next load.
  revalidatePath("/", "layout");
  return {};
}

/**
 * Finish setting yourself up. Asked once, on a first sign-in.
 *
 * Everything here was already settable somewhere else, and that was the problem:
 * a new person's first sight of the portal called them by the front of their
 * email address, emailed them about everything, and left them with no way in if
 * mail ever stopped arriving - each fixable on a page they had no reason to open.
 *
 * The stamp is written LAST and only on success, so a form somebody abandoned
 * halfway leaves them exactly where they were: asked again next time.
 */
export async function completeWelcome(data: {
  name: string; password?: string; emailOff?: string[];
}): Promise<{ error?: string }> {
  const u = await requireUser();
  const email = u.email.toLowerCase();
  const name = data.name.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!name) return { error: "Tell us what to call you." };

  // Optional, and set through the same door as the account page - one place
  // decides what a usable password is. Done BEFORE the name is written, so a
  // rejected one does not leave half the form saved.
  const password = (data.password ?? "").trim();
  if (password) {
    const res = await setPasswordFor(email, password);
    if (res.error) return res;
  }

  await db.update(users).set({ name }).where(eq(users.email, email));

  // Only the opt-OUTS are stored - no row means email is on - so this writes the
  // boxes somebody unticked and nothing else. See lib/inbox.
  const off = (data.emailOff ?? []).filter(isNotifyKind);
  for (const kind of off) {
    await db.insert(notificationPrefs).values({ email, kind, emailOn: false })
      .onConflictDoUpdate({ target: [notificationPrefs.email, notificationPrefs.kind], set: { emailOn: false } });
  }

  await db.update(users).set({ onboardedAt: new Date() }).where(eq(users.email, email));
  await audit({
    actor: email, entityType: "auth", entityId: email,
    action: `set themselves up as ${name}`
      + (password ? " with a password" : "")
      + (off.length ? `, email off for ${off.length} kind${off.length === 1 ? "" : "s"}` : ""),
  });
  revalidatePath("/", "layout");
  return {};
}

// ---------------- Operators: a service company of their own ----------------

/**
 * Set a service company up with a workspace on this instance.
 *
 * Everything else in this file is about work inside a workspace; this is the one
 * action that makes a new one. It is the whole onboarding: an operator
 * organization, its first owner, and nothing else - their fleet, clients, catalog
 * and procedures are theirs to enter, and an empty workspace shows the built-in
 * stage vocabulary until they define their own (see lib/stageDefs), so it is
 * usable from the first sign-in rather than after a setup call.
 *
 * Platform-owner only. Handing out workspaces is the act of selling the product,
 * and a tenant creating tenants would be reselling it.
 */
export async function createOperator(
  name: string, ownerEmail: string,
): Promise<{ error?: string; orgId?: number }> {
  const u = await requirePlatformOwner();
  const n = name.trim();
  if (!n || n.length > 60) return { error: "Company name must be 1-60 characters" };
  const e = ownerEmail.trim().toLowerCase();
  if (!validHouseEmail(e)) return { error: "Give one exact email for their first owner - no @domain wildcards" };

  const existing = await db.select().from(orgs);
  if (existing.some((o) => o.name.toLowerCase() === n.toLowerCase())) return { error: `${n} already exists` };
  // One person is staff of one company (house_members is unique on email), so a
  // borrowed address would move them rather than adding them - say so instead.
  const [taken] = await db.select().from(houseMembers).where(eq(houseMembers.email, e));
  if (taken) return { error: `${e} is already staff somewhere on this instance` };

  const [org] = await db.insert(orgs).values({
    name: n, kind: "provider", isOperator: true, parentOrgId: null,
  }).returning();
  await db.insert(houseMembers).values({
    email: e, role: "owner", name: "", addedBy: u.email, orgId: org.id,
  });
  await audit({
    actor: u.email, entityType: "org", entityId: org.id, tenantOrgId: org.id,
    action: `opened a workspace for "${n}" with ${e} as its first owner`,
  });
  await notifyInvite({ to: e, inviterName: u.name, orgName: n });
  revalidatePath("/settings/tenants");
  revHouse();
  return { orgId: org.id };
}

/** Add somebody to the house, or change what they already are. */
export async function setHouseMember(
  email: string, role: string, name?: string,
): Promise<{ error?: string }> {
  const u = await requireOwner();
  const want = role === "owner" ? "owner" : "staff";
  const e = email.trim().toLowerCase();
  const { guard } = await guardFor(u.email, e, want);
  if (!guard.ok) return { error: guard.error };
  const [existing] = await db.select().from(houseMembers).where(eq(houseMembers.email, e));
  const label = (name ?? "").trim().slice(0, 80);
  if (existing) {
    if (existing.role === want && existing.name === label) return {};
    await db.update(houseMembers).set({ role: want, name: label || existing.name }).where(eq(houseMembers.id, existing.id));
    await audit({
      actor: u.email, entityType: "house", entityId: e,
      action: existing.role === want
        ? `renamed house member ${e}`
        : `changed ${e} from ${existing.role === "none" ? "revoked" : existing.role} to ${want}`,
      field: "role", oldValue: existing.role, newValue: want,
    });
  } else {
    await db.insert(houseMembers).values({
      email: e, role: want, name: label, addedBy: u.email,
      // Staff of the workspace that hired them, which is the one adding them here.
      orgId: myTenantOrgId(u),
    });
    await audit({
      actor: u.email, entityType: "house", entityId: e, tenantOrgId: myTenantOrgId(u),
      action: `granted ${e} ${want} access to the whole shop`,
      field: "role", newValue: want,
    });
  }
  // Their next session read picks the new role up (src/auth.ts) - no redeploy,
  // and no need for them to sign out and back in.
  revHouse();
  return {};
}

/**
 * Take house access away. Somebody added here is deleted outright; somebody the
 * environment still lists gets a 'none' row instead, because deleting nothing
 * would leave STAFF_EMAILS granting them staff on the next sign-in.
 */
export async function revokeHouseMember(email: string, reason: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const e = email.trim().toLowerCase();
  const { guard } = await guardFor(u.email, e, "revoke");
  if (!guard.ok) return { error: guard.error };
  const inEnv = parseList(process.env.STAFF_EMAILS).includes(e);
  const [existing] = await db.select().from(houseMembers).where(eq(houseMembers.email, e));
  if (inEnv) {
    if (existing) await db.update(houseMembers).set({ role: "none" }).where(eq(houseMembers.id, existing.id));
    else await db.insert(houseMembers).values({ email: e, role: "none", addedBy: u.email });
  } else if (existing) {
    await db.delete(houseMembers).where(eq(houseMembers.id, existing.id));
  } else {
    return {};
  }
  // Downgrade the stored role now rather than waiting for their next session
  // read, so an open session loses its powers at the next request.
  await db.update(users).set({ role: "client_viewer" }).where(eq(users.email, e));
  await audit({
    actor: u.email, entityType: "house", entityId: e,
    action: `revoked ${e}'s house access${inEnv ? " (still listed in STAFF_EMAILS - overridden here)" : ""} - reason: ${why}`,
    field: "role", oldValue: existing?.role ?? "staff", newValue: "none",
  });
  revHouse();
  return {};
}

/** The list for Settings, with each row's provenance and what may be done to it. */
export async function listHouseMembers(): Promise<{
  email: string; role: string; name: string; fromEnv: boolean; isRoot: boolean; locked: boolean;
}[]> {
  const u = await requireOwner();
  const env = parseList(process.env.STAFF_EMAILS);
  const members = await houseMemberRows();
  const root = rootOwner(env);
  const owners = ownerEmails(env, members);
  const rows = await db.select().from(houseMembers);
  const emails = [...new Set([...env, ...rows.map((r) => r.email.toLowerCase())])];
  return emails
    .map((email) => {
      const row = rows.find((r) => r.email.toLowerCase() === email);
      const isRoot = email === root;
      const role = isRoot ? "owner" : row ? row.role : "staff";
      return {
        email, role, name: row?.name ?? "", fromEnv: env.includes(email), isRoot,
        // The root is the environment's; nobody edits their own; the last owner
        // stays. Same three rules memberGuard enforces server-side.
        locked: isRoot || email === u.email.toLowerCase() || (owners.length === 1 && owners[0] === email),
      };
    })
    .filter((r) => r.role !== "none" || r.fromEnv)
    .sort((a, b) => Number(b.isRoot) - Number(a.isRoot) || a.email.localeCompare(b.email));
}

// ── Stock ───────────────────────────────────────────────────────────────────

/**
 * The single gate for one room, mirroring assetAccess: load the room, load the
 * viewer's share of it if any, and let lib/stock decide. Every stock mutation
 * goes through here so a new one can't forget the cross-org rules.
 */
async function roomAccess(u: SessionUser, stockroomId: number) {
  const [room] = await db.select().from(stockrooms).where(eq(stockrooms.id, stockroomId));
  if (!room) return { room: null, see: false, issue: false, manage: false };
  const [share] = u.orgId === null ? [] : await db.select({ access: stockroomShares.access })
    .from(stockroomShares).where(and(eq(stockroomShares.stockroomId, stockroomId), eq(stockroomShares.orgId, u.orgId)));
  return { room, ...stockAccess(u, room, share) };
}

const revStock = (id?: number) => {
  revalidatePath("/stock");
  if (id) revalidatePath(`/stock/${id}`);
};

export async function createStockroom(data: {
  name: string; kind: string; orgId: number | null; keeper?: string; location?: string; note?: string;
}): Promise<{ error?: string; id?: number }> {
  const u = await requireEditor();
  const name = data.name.trim().slice(0, 80);
  if (!name) return { error: "Name required" };
  const kind = (STOCK_KINDS as readonly string[]).includes(data.kind) ? data.kind : "shop";
  // An org's editors can create their own rooms; only the house can create a
  // room that belongs to somebody else (or to the house itself).
  const orgId = isHouse(u.role) ? data.orgId : u.orgId;
  if (!isHouse(u.role) && orgId === null) return { error: "Not found" };
  if (orgId !== null) {
    const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId));
    if (!org) return { error: "Unknown organization" };
  }
  const [room] = await db.insert(stockrooms).values({
    tenantOrgId: myTenantOrgId(u),
    name, kind, orgId, keeper: (data.keeper ?? "").trim().slice(0, 60),
    location: (data.location ?? "").trim().slice(0, 120), note: (data.note ?? "").trim().slice(0, 300),
    createdBy: u.email,
  }).returning();
  await audit({
    actor: u.email, entityType: "stockroom", entityId: room.id,
    action: `created ${KIND_LABEL[kind].toLowerCase()} "${name}"`,
  });
  revStock();
  return { id: room.id };
}

export async function updateStockroom(id: number, data: {
  name: string; keeper?: string; location?: string; note?: string;
}): Promise<{ error?: string }> {
  const u = await requireEditor();
  const acc = await roomAccess(u, id);
  if (!acc.room) return { error: "Not found" };
  if (!acc.manage) return { error: acc.see ? "You can't change someone else's stockroom" : "Not found" };
  const name = data.name.trim().slice(0, 80);
  if (!name) return { error: "Name required" };
  await db.update(stockrooms).set({
    name, keeper: (data.keeper ?? "").trim().slice(0, 60),
    location: (data.location ?? "").trim().slice(0, 120), note: (data.note ?? "").trim().slice(0, 300),
  }).where(eq(stockrooms.id, id));
  if (name !== acc.room.name) {
    await audit({
      actor: u.email, entityType: "stockroom", entityId: id,
      action: `renamed stockroom "${acc.room.name}" to "${name}"`, field: "name", oldValue: acc.room.name, newValue: name,
    });
  }
  revStock(id);
  return {};
}

/**
 * Archive rather than delete: the moves ledger is the history of who took what,
 * and dropping a room would take that with it.
 */
export async function archiveStockroom(id: number, reason: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const acc = await roomAccess(u, id);
  if (!acc.room) return { error: "Not found" };
  if (!acc.manage) return { error: acc.see ? "You can't change someone else's stockroom" : "Not found" };
  await db.update(stockrooms).set({ archived: true }).where(eq(stockrooms.id, id));
  await audit({
    actor: u.email, entityType: "stockroom", entityId: id,
    action: `archived stockroom "${acc.room.name}" - reason: ${why}`, field: "reason", newValue: why,
  });
  revStock(id);
  return {};
}

/** Let another organization see, or draw from, this room. */
export async function setStockroomShare(stockroomId: number, orgId: number, access: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  const acc = await roomAccess(u, stockroomId);
  if (!acc.room) return { error: "Not found" };
  if (!acc.manage) return { error: acc.see ? "Only the stockroom's own organization hands out access" : "Not found" };
  if (acc.room.orgId === orgId) return { error: "That's the organization the stockroom belongs to" };
  const level = access === "issue" ? "issue" : "view";
  const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Unknown organization" };
  await db.insert(stockroomShares)
    .values({ stockroomId, orgId, access: level, addedBy: u.email })
    .onConflictDoUpdate({ target: [stockroomShares.stockroomId, stockroomShares.orgId], set: { access: level } });
  await audit({
    actor: u.email, entityType: "stockroom", entityId: stockroomId,
    action: `gave ${org.name} ${level === "issue" ? "permission to draw parts from" : "read access to"} "${acc.room.name}"`,
    field: "access", newValue: level,
  });
  revStock(stockroomId);
  return {};
}

export async function removeStockroomShare(stockroomId: number, orgId: number): Promise<{ error?: string }> {
  const u = await requireEditor();
  const acc = await roomAccess(u, stockroomId);
  if (!acc.room) return { error: "Not found" };
  if (!acc.manage) return { error: acc.see ? "Only the stockroom's own organization hands out access" : "Not found" };
  const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId));
  await db.delete(stockroomShares)
    .where(and(eq(stockroomShares.stockroomId, stockroomId), eq(stockroomShares.orgId, orgId)));
  await audit({
    actor: u.email, entityType: "stockroom", entityId: stockroomId,
    action: `removed ${org?.name ?? "an organization"}'s access to "${acc.room.name}"`,
  });
  revStock(stockroomId);
  return {};
}

/** Find (or create) the on-hand line for a part number in a room. */
async function stockLineFor(stockroomId: number, partNumber: string, seed?: { name?: string }) {
  const pn = partNumber.trim().slice(0, 80);
  if (!pn) return null;
  const [existing] = await db.select().from(stockItems).where(and(
    eq(stockItems.stockroomId, stockroomId),
    sql`lower(${stockItems.partNumber}) = ${pn.toLowerCase()}`,
  ));
  if (existing) return existing;
  const [made] = await db.insert(stockItems)
    .values({ stockroomId, partNumber: pn, name: (seed?.name ?? "").trim().slice(0, 120), qty: 0 })
    .returning();
  return made;
}

/** Append to the ledger and move the count in one place. */
async function moveStock(opts: {
  item: typeof stockItems.$inferSelect; delta: number; kind: string; actor: string; reason?: string;
  counterpartyId?: number | null; instrumentId?: number | null; assetId?: number | null; partId?: number | null;
}) {
  await db.insert(stockMoves).values({
    stockroomId: opts.item.stockroomId, partNumber: opts.item.partNumber, delta: opts.delta, kind: opts.kind,
    counterpartyId: opts.counterpartyId ?? null, instrumentId: opts.instrumentId ?? null,
    assetId: opts.assetId ?? null, partId: opts.partId ?? null,
    reason: (opts.reason ?? "").slice(0, 200), actor: opts.actor,
  });
  await db.update(stockItems)
    .set({ qty: opts.item.qty + opts.delta, updatedAt: new Date() })
    .where(eq(stockItems.id, opts.item.id));
}

export type StockItemInput = { partNumber: string; name?: string; qty?: string; minQty?: string; bin?: string; note?: string };

const whole = (s: string | undefined, fallback = 0) => {
  const n = parseInt((s ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Spreadsheet entry for a room's shelf, same shape as the catalog grids. An
 * opening quantity counts as a receive so the ledger explains where the first
 * count came from; a part number already on the shelf has its floor and bin
 * updated instead of being duplicated.
 */
export async function addStockItems(
  stockroomId: number, rows: StockItemInput[],
): Promise<{ error?: string; created?: number; updated?: number; failures?: { row: number; name: string; error: string }[] }> {
  const u = await requireEditor();
  const acc = await roomAccess(u, stockroomId);
  if (!acc.room) return { error: "Not found" };
  if (!acc.manage) return { error: acc.see ? "You can't stock someone else's room" : "Not found" };
  const usable = rows.filter((r) => r.partNumber.trim());
  if (!usable.length) return { error: "Nothing to save - every row needs a part number" };
  if (usable.length > 300) return { error: "Save 300 rows at a time" };
  const failures: { row: number; name: string; error: string }[] = [];
  let created = 0, updated = 0;
  for (let i = 0; i < usable.length; i++) {
    const r = usable[i];
    const pn = r.partNumber.trim();
    const [before] = await db.select().from(stockItems).where(and(
      eq(stockItems.stockroomId, stockroomId),
      sql`lower(${stockItems.partNumber}) = ${pn.toLowerCase()}`,
    ));
    const line = await stockLineFor(stockroomId, pn, { name: r.name });
    if (!line) { failures.push({ row: i + 1, name: pn, error: "Part number required" }); continue; }
    const openingQty = whole(r.qty);
    await db.update(stockItems).set({
      name: (r.name ?? line.name).trim().slice(0, 120),
      minQty: whole(r.minQty, line.minQty),
      bin: (r.bin ?? line.bin).trim().slice(0, 40),
      note: (r.note ?? line.note).trim().slice(0, 200),
    }).where(eq(stockItems.id, line.id));
    if (before) {
      updated++;
    } else {
      created++;
      if (openingQty > 0) {
        await moveStock({ item: line, delta: openingQty, kind: "receive", actor: u.email, reason: "opening count" });
      }
    }
  }
  await audit({
    actor: u.email, entityType: "stockroom", entityId: stockroomId,
    action: `stocked "${acc.room.name}": ${created} new line${created === 1 ? "" : "s"}, ${updated} updated`,
  });
  revStock(stockroomId);
  return { created, updated, failures };
}

/**
 * A recount. The count is never edited in place - the difference is posted as a
 * correcting entry with a reason, so a shelf that keeps drifting shows up as a
 * pattern in the ledger instead of vanishing into an overwritten number.
 */
export async function recountStock(itemId: number, countedQty: number, reason: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  if (!Number.isInteger(countedQty) || countedQty < 0) return { error: "Count must be a whole number, zero or more" };
  const [item] = await db.select().from(stockItems).where(eq(stockItems.id, itemId));
  if (!item) return { error: "Not found" };
  const acc = await roomAccess(u, item.stockroomId);
  if (!acc.room) return { error: "Not found" };
  if (!acc.manage) return { error: acc.see ? "You can't recount someone else's shelf" : "Not found" };
  const delta = countedQty - item.qty;
  if (delta === 0) return {};
  await moveStock({ item, delta, kind: "adjust", actor: u.email, reason: why });
  await audit({
    actor: u.email, entityType: "stock", entityId: item.id,
    action: `recounted PN ${item.partNumber} in "${acc.room.name}": ${item.qty} -> ${countedQty} - reason: ${why}`,
    field: "qty", oldValue: String(item.qty), newValue: String(countedQty),
  });
  revStock(item.stockroomId);
  return {};
}

/**
 * Take parts off a shelf and onto a system or unit. The draw and the parts row
 * are one action: stock that left the shelf but never appeared on a work order
 * is how inventory stops being trusted. Unit cost comes from what the room
 * paid when that's known, else the price book's best offer - server-derived
 * either way, so the cost-strip rule for editors isn't in play.
 */
export async function issueStock(
  itemId: number, qty: number, target: WorkTarget, opts?: { install?: boolean; note?: string },
): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [item] = await db.select().from(stockItems).where(eq(stockItems.id, itemId));
  if (!item) return { error: "Not found" };
  const acc = await roomAccess(u, item.stockroomId);
  if (!acc.room) return { error: "Not found" };
  if (!acc.issue) return { error: acc.see ? "You can see this stockroom but not draw from it" : "Not found" };
  const check = canIssue(item.qty, qty);
  if (!check.ok) return { error: check.error };
  // The same write-auth gate every other work row goes through.
  const t0 = await resolveTarget(target);
  if ("error" in t0) return t0;

  const book = await db.select().from(partPrices);
  const best = bestPrice(book, item.partNumber);
  const unitCents = item.unitCostCents ?? best?.priceCents ?? null;
  const name = item.name || `PN ${item.partNumber}`;
  const status = opts?.install ? "Installed" : "Received";
  const stamps = partStamps({ status: "", receivedAt: "", installedAt: "", removedAt: "" }, status);
  const [p] = await db.insert(parts).values({
    instrumentId: t0.instrumentId, assetId: t0.assetId, name, partNumber: item.partNumber,
    qty: String(qty), status, ...stamps,
    ownerOrgId: await costOwnerOrg(t0),
    vendor: item.unitCostCents === null && best ? best.vendor : "",
    note: [`from stock: ${acc.room.name}`, (opts?.note ?? "").trim()].filter(Boolean).join(" - "),
    ...(unitCents !== null ? { cost: centsToInput(unitCents * qty), costCents: unitCents * qty } : {}),
  }).returning();
  await moveStock({
    item, delta: -qty, kind: "issue", actor: u.email, reason: (opts?.note ?? "").trim(),
    instrumentId: t0.instrumentId, assetId: t0.assetId, partId: p.id,
  });
  await audit({
    actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId, entityType: "part", entityId: p.id,
    // No price: activity feeds are shared with every org on the system.
    action: `issued ${qty} × ${name}${item.partNumber ? ` (PN ${item.partNumber})` : ""} from "${acc.room.name}"`
      + `${status === "Installed" ? " and installed it" : ""}`,
  });
  revStock(item.stockroomId);
  revWork(p);
  return {};
}

/** Move stock between rooms - a van restock, or spares going out to a client's cage. */
export async function transferStock(itemId: number, toStockroomId: number, qty: number, note?: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [item] = await db.select().from(stockItems).where(eq(stockItems.id, itemId));
  if (!item) return { error: "Not found" };
  if (toStockroomId === item.stockroomId) return { error: "That's the same stockroom" };
  const from = await roomAccess(u, item.stockroomId);
  const to = await roomAccess(u, toStockroomId);
  if (!from.room || !to.room) return { error: "Not found" };
  if (!from.issue) return { error: from.see ? "You can see this stockroom but not draw from it" : "Not found" };
  // Putting stock INTO a room is a write on that room, so it needs the same
  // standing there - otherwise a share could be used to dump inventory.
  if (!to.issue) return { error: to.see ? `You can't add stock to "${to.room.name}"` : "Not found" };
  const check = canIssue(item.qty, qty);
  if (!check.ok) return { error: check.error };
  const dest = await stockLineFor(toStockroomId, item.partNumber, { name: item.name });
  if (!dest) return { error: "Not found" };
  const why = (note ?? "").trim();
  await moveStock({ item, delta: -qty, kind: "transfer_out", actor: u.email, reason: why, counterpartyId: toStockroomId });
  await moveStock({ item: dest, delta: qty, kind: "transfer_in", actor: u.email, reason: why, counterpartyId: item.stockroomId });
  // Cost travels with the parts: a van restocked from the shop holds stock at
  // what the shop paid, not at whatever the price book says today.
  if (dest.unitCostCents === null && item.unitCostCents !== null) {
    await db.update(stockItems).set({ unitCostCents: item.unitCostCents }).where(eq(stockItems.id, dest.id));
  }
  await audit({
    actor: u.email, entityType: "stock", entityId: item.id,
    action: `transferred ${qty} × PN ${item.partNumber} from "${from.room.name}" to "${to.room.name}"${why ? ` - ${why}` : ""}`,
  });
  revStock(item.stockroomId);
  revStock(toStockroomId);
  return {};
}

/** Stock arriving without a purchase order - a hand-carried spare, a return. */
export async function receiveStock(itemId: number, qty: number, note?: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  if (!Number.isInteger(qty) || qty <= 0) return { error: "How many? Whole numbers above zero." };
  const [item] = await db.select().from(stockItems).where(eq(stockItems.id, itemId));
  if (!item) return { error: "Not found" };
  const acc = await roomAccess(u, item.stockroomId);
  if (!acc.room) return { error: "Not found" };
  if (!acc.issue) return { error: acc.see ? "You can see this stockroom but not stock it" : "Not found" };
  await moveStock({ item, delta: qty, kind: "receive", actor: u.email, reason: (note ?? "").trim() });
  await audit({
    actor: u.email, entityType: "stock", entityId: item.id,
    action: `received ${qty} × PN ${item.partNumber} into "${acc.room.name}"${(note ?? "").trim() ? ` - ${note!.trim()}` : ""}`,
  });
  revStock(item.stockroomId);
  return {};
}

// ── Purchase orders ─────────────────────────────────────────────────────────
// A PO is money and inventory, so it follows the destination room's access:
// whoever may stock a shelf may order for it. Editing stops once the vendor
// has the order; from then on the only writes are receipts against it.

const revPo = (id?: number) => {
  revalidatePath("/purchasing");
  if (id) revalidatePath(`/purchasing/${id}`);
  revalidatePath("/stock");
};

async function poAccess(u: SessionUser, poId: number) {
  const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId));
  if (!po) return { po: null, manage: false, see: false };
  // A PO with no room left (archived away) stays visible to the house only.
  if (po.stockroomId === null) return { po, manage: isHouse(u.role), see: isHouse(u.role) };
  const acc = await roomAccess(u, po.stockroomId);
  return { po, manage: acc.issue, see: acc.see };
}

export type PoLineInput = { partNumber: string; name?: string; qty?: string; price?: string; note?: string };

/**
 * Raise an order. Lines can come from the reorder suggestions (already priced
 * from the price book) or be typed; either way the number is allocated from the
 * highest ever used so a cancelled order's number is never handed out twice.
 */
export async function createPurchaseOrder(data: {
  vendor: string; stockroomId: number; reference?: string; note?: string; expectedAt?: string;
  lines: PoLineInput[];
}): Promise<{ error?: string; id?: number }> {
  const u = await requireEditor();
  const acc = await roomAccess(u, data.stockroomId);
  if (!acc.room) return { error: "Not found" };
  if (!acc.issue) return { error: acc.see ? "You can't order into someone else's stockroom" : "Not found" };
  const vendor = data.vendor.trim().slice(0, 80);
  if (!vendor) return { error: "Vendor required" };
  const usable = data.lines.filter((l) => l.partNumber.trim());
  if (!usable.length) return { error: "An order needs at least one line" };
  if (usable.length > 200) return { error: "200 lines at a time" };

  const existing = await db.select({ number: purchaseOrders.number }).from(purchaseOrders);
  const [po] = await db.insert(purchaseOrders).values({
    tenantOrgId: acc.room.tenantOrgId ?? myTenantOrgId(u),
    number: nextPoNumber(existing.map((r) => r.number)),
    vendor, stockroomId: data.stockroomId, orgId: acc.room.orgId,
    reference: (data.reference ?? "").trim().slice(0, 80),
    note: (data.note ?? "").trim().slice(0, 300),
    expectedAt: (data.expectedAt ?? "").trim().slice(0, 40),
    createdBy: u.email,
  }).returning();
  for (const l of usable) {
    const qty = parseInt((l.qty ?? "1").trim(), 10);
    await db.insert(poLines).values({
      poId: po.id, partNumber: l.partNumber.trim().slice(0, 80), name: (l.name ?? "").trim().slice(0, 120),
      qtyOrdered: Number.isFinite(qty) && qty > 0 ? qty : 1,
      unitCents: parseMoney(l.price ?? ""), note: (l.note ?? "").trim().slice(0, 200),
    });
  }
  await audit({
    actor: u.email, entityType: "po", entityId: po.id,
    action: `raised ${po.number} to ${vendor}: ${usable.length} line${usable.length === 1 ? "" : "s"} for "${acc.room.name}"`,
  });
  revPo();
  return { id: po.id };
}

export async function updatePurchaseOrder(id: number, data: {
  vendor: string; reference?: string; note?: string; expectedAt?: string;
}): Promise<{ error?: string }> {
  const u = await requireEditor();
  const { po, manage, see } = await poAccess(u, id);
  if (!po) return { error: "Not found" };
  if (!manage) return { error: see ? "You can't change this order" : "Not found" };
  if (!poEditable(po.status)) return { error: `${po.number} has already gone to the vendor` };
  const vendor = data.vendor.trim().slice(0, 80);
  if (!vendor) return { error: "Vendor required" };
  await db.update(purchaseOrders).set({
    vendor, reference: (data.reference ?? "").trim().slice(0, 80),
    note: (data.note ?? "").trim().slice(0, 300), expectedAt: (data.expectedAt ?? "").trim().slice(0, 40),
  }).where(eq(purchaseOrders.id, id));
  if (vendor !== po.vendor) {
    await audit({
      actor: u.email, entityType: "po", entityId: id,
      action: `${po.number} vendor: ${po.vendor} -> ${vendor}`, field: "vendor", oldValue: po.vendor, newValue: vendor,
    });
  }
  revPo(id);
  return {};
}

export async function setPoLine(lineId: number, data: { qty: string; price: string; note?: string }): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [line] = await db.select().from(poLines).where(eq(poLines.id, lineId));
  if (!line) return { error: "Not found" };
  const { po, manage, see } = await poAccess(u, line.poId);
  if (!po) return { error: "Not found" };
  if (!manage) return { error: see ? "You can't change this order" : "Not found" };
  if (!poEditable(po.status)) return { error: `${po.number} has already gone to the vendor` };
  const qty = parseInt(data.qty.trim(), 10);
  if (!Number.isFinite(qty) || qty <= 0) return { error: "Quantity must be a whole number above zero" };
  await db.update(poLines).set({
    qtyOrdered: qty, unitCents: parseMoney(data.price), note: (data.note ?? line.note).trim().slice(0, 200),
  }).where(eq(poLines.id, lineId));
  revPo(line.poId);
  return {};
}

export async function addPoLine(poId: number, line: PoLineInput): Promise<{ error?: string }> {
  const u = await requireEditor();
  const { po, manage, see } = await poAccess(u, poId);
  if (!po) return { error: "Not found" };
  if (!manage) return { error: see ? "You can't change this order" : "Not found" };
  if (!poEditable(po.status)) return { error: `${po.number} has already gone to the vendor` };
  const pn = line.partNumber.trim().slice(0, 80);
  if (!pn) return { error: "Part number required" };
  const qty = parseInt((line.qty ?? "1").trim(), 10);
  await db.insert(poLines).values({
    poId, partNumber: pn, name: (line.name ?? "").trim().slice(0, 120),
    qtyOrdered: Number.isFinite(qty) && qty > 0 ? qty : 1,
    unitCents: parseMoney(line.price ?? ""), note: (line.note ?? "").trim().slice(0, 200),
  });
  revPo(poId);
  return {};
}

export async function deletePoLine(lineId: number): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [line] = await db.select().from(poLines).where(eq(poLines.id, lineId));
  if (!line) return {};
  const { po, manage, see } = await poAccess(u, line.poId);
  if (!po) return { error: "Not found" };
  if (!manage) return { error: see ? "You can't change this order" : "Not found" };
  if (!poEditable(po.status)) return { error: `${po.number} has already gone to the vendor` };
  await db.delete(poLines).where(eq(poLines.id, lineId));
  revPo(line.poId);
  return {};
}

/**
 * Hand the order to the vendor. This is the point of no return for edits, so
 * it's a deliberate step rather than something a save button does by accident.
 */
export async function sendPurchaseOrder(id: number): Promise<{ error?: string }> {
  const u = await requireEditor();
  const { po, manage, see } = await poAccess(u, id);
  if (!po) return { error: "Not found" };
  if (!manage) return { error: see ? "You can't send this order" : "Not found" };
  if (po.status !== "draft") return { error: `${po.number} is already ${PO_LABEL[po.status].toLowerCase()}` };
  const lines = await db.select().from(poLines).where(eq(poLines.poId, id));
  if (!lines.length) return { error: "Nothing on this order yet" };
  const totals = poTotals(lines);
  await db.update(purchaseOrders).set({ status: "sent", sentAt: new Date() }).where(eq(purchaseOrders.id, id));
  await audit({
    actor: u.email, entityType: "po", entityId: id,
    action: `sent ${po.number} to ${po.vendor} - ${totals.ordered} unit${totals.ordered === 1 ? "" : "s"}`
      + `${totals.priced ? `, ${formatCents(totals.cents)}` : ""}`
      + `${totals.unpriced ? ` (${totals.unpriced} line${totals.unpriced === 1 ? "" : "s"} unpriced)` : ""}`,
    field: "status", oldValue: "draft", newValue: "sent",
  });
  revPo(id);
  return {};
}

/**
 * Book a delivery. Receiving is the ONLY thing that puts PO stock on a shelf,
 * so the count and the paperwork can never drift apart: the line's receipt, the
 * stock move and the on-hand bump are one action. A unit price on the line also
 * becomes the shelf's held cost, which is what later issues are valued at.
 */
export async function receivePoLine(lineId: number, qty: number, note?: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  if (!Number.isInteger(qty) || qty <= 0) return { error: "How many arrived? Whole numbers above zero." };
  const [line] = await db.select().from(poLines).where(eq(poLines.id, lineId));
  if (!line) return { error: "Not found" };
  const { po, manage, see } = await poAccess(u, line.poId);
  if (!po) return { error: "Not found" };
  if (!manage) return { error: see ? "You can't receive against this order" : "Not found" };
  if (!poReceivable(po.status)) {
    return { error: po.status === "draft" ? `${po.number} hasn't been sent yet` : `${po.number} is ${PO_LABEL[po.status].toLowerCase()}` };
  }
  if (po.stockroomId === null) return { error: "This order's stockroom is gone - receive it into a room instead" };
  const item = await stockLineFor(po.stockroomId, line.partNumber, { name: line.name });
  if (!item) return { error: "Not found" };

  await db.update(poLines).set({ qtyReceived: line.qtyReceived + qty }).where(eq(poLines.id, lineId));
  await moveStock({
    item, delta: qty, kind: "receive", actor: u.email,
    reason: [`${po.number} from ${po.vendor}`, (note ?? "").trim()].filter(Boolean).join(" - "),
  });
  // What we actually paid becomes the shelf's held cost - later issues are
  // valued at this rather than at whatever the price book says that week.
  if (line.unitCents !== null) {
    await db.update(stockItems).set({ unitCostCents: line.unitCents }).where(eq(stockItems.id, item.id));
  }
  // Any open request for this part on any work order is now satisfied - the
  // sticky-note gap between "ordered" and "it's here" is what this closes.
  // The order id goes on too: "where is the receipt for this part" then has an
  // answer that survives somebody's typing in the free-text PO field.
  const open = await db.select().from(parts).where(and(
    sql`lower(${parts.partNumber}) = ${line.partNumber.trim().toLowerCase()}`,
    inArray(parts.status, ["Needed", "Ordered", "In transit", "Backordered"]),
  ));
  for (const p of open) {
    await db.update(parts)
      .set({ status: "Received", receivedAt: shopToday(), poId: p.poId ?? po.id })
      .where(eq(parts.id, p.id));
    await audit({
      actor: u.email, instrumentId: p.instrumentId, assetId: p.assetId, entityType: "part", entityId: p.id,
      action: `'${p.name}' (PN ${p.partNumber}) arrived on ${po.number} - marked Received`,
      field: "status", oldValue: p.status, newValue: "Received",
    });
    revWork(p);
  }

  // Bought FOR a job, and nothing on that job was already waiting for it: the
  // part belongs on the client's system, not only on our shelf. Without this,
  // ordering a lamp for a client's repair left no trace on their record until
  // somebody remembered to type it in a second time - and their parts
  // allowance, which reads the parts on their systems, would never see it.
  if (po.workOrderId !== null && !open.length) {
    const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, po.workOrderId));
    if (wo && wo.instrumentId !== null) {
      const t0 = { instrumentId: wo.instrumentId, assetId: wo.assetId, asset: null };
      const [made] = await db.insert(parts).values({
        instrumentId: wo.instrumentId, assetId: null,
        name: (line.name || catalogName(
          await db.select().from(partCatalog).where(forTenant(partCatalog.tenantOrgId, po.tenantOrgId)),
          line.partNumber, line.partNumber,
        )).slice(0, 160),
        partNumber: line.partNumber, qty: String(qty), status: "Received",
        receivedAt: shopToday(), po: po.number, poId: po.id,
        cost: line.unitCents !== null ? centsToInput(line.unitCents * qty) : "",
        costCents: line.unitCents !== null ? line.unitCents * qty : null,
        // Whose money, stamped now for the same reason every other part is.
        ownerOrgId: await costOwnerOrg(t0),
        note: `Received on ${po.number} for ${wo.number}`,
      }).returning();
      await audit({
        actor: u.email, instrumentId: wo.instrumentId, entityType: "part", entityId: made.id,
        action: `${qty} × PN ${line.partNumber} received on ${po.number} and filed against ${wo.number}`,
      });
      revWork(made);
    }
  }

  const after = await db.select().from(poLines).where(eq(poLines.poId, line.poId));
  const next = statusAfterReceipt(after);
  if (next !== po.status) {
    await db.update(purchaseOrders)
      .set({ status: next, closedAt: next === "received" ? new Date() : null })
      .where(eq(purchaseOrders.id, line.poId));
  }
  await audit({
    actor: u.email, entityType: "po", entityId: line.poId,
    action: `received ${qty} × PN ${line.partNumber} on ${po.number}`
      + `${next === "received" ? " - order complete" : ""}`,
  });
  revPo(line.poId);
  return {};
}

/**
 * Draft a purchase order from parts a system says it needs.
 *
 * Purchasing only ever listened to the shelf: a stock item below its minimum
 * suggested an order, while a part somebody marked Needed on an instrument sat
 * on that instrument's page waiting for a human to retype it into a PO. These
 * are the same fact - something has to be bought - and the second one is the
 * more urgent, because a system is down for it.
 *
 * The parts are stamped with the PO as it is created, so the link exists going
 * forward instead of being guessed by part number at receipt.
 */
export async function orderNeededParts(
  partIds: number[], data: { vendor: string; stockroomId: number },
): Promise<{ error?: string; id?: number; number?: string; flag?: string }> {
  const u = await requireEditor();
  if (!partIds.length) return { error: "Pick at least one part" };
  const rows = await db.select().from(parts).where(inArray(parts.id, partIds));
  if (!rows.length) return { error: "Not found" };
  if (rows.some((r) => !partOpen(r.status))) return { error: "One of those is already received or fitted" };
  // Every part has to be on a record this person may work on.
  for (const r of rows) {
    if (r.instrumentId !== null) {
      try { await assertSystemEditable(u, r.instrumentId); } catch { return { error: "Not found" }; }
    } else if (r.assetId !== null && !(await assetAccess(u, r.assetId)).edit) {
      return { error: "Not found" };
    }
  }
  const res = await createPurchaseOrder({
    vendor: data.vendor, stockroomId: data.stockroomId, reference: "", note: "",
    expectedAt: "",
    // parts.qty is free text ("2", "1 box") - the number in it is the order
    // quantity, and anything unparseable is one.
    lines: rows.map((r) => ({
      partNumber: r.partNumber, name: r.name,
      qty: String(parseInt(r.qty) > 0 ? parseInt(r.qty) : 1),
      price: r.costCents != null ? String(r.costCents / 100) : "",
      note: "",
    })),
  });
  if (res.error || !res.id) return { error: res.error ?? "Could not draft the order" };
  const [po] = await db.select({ number: purchaseOrders.number }).from(purchaseOrders)
    .where(eq(purchaseOrders.id, res.id));

  for (const r of rows) {
    await db.update(parts).set({ poId: res.id, status: "Ordered" }).where(eq(parts.id, r.id));
    await audit({
      actor: u.email, instrumentId: r.instrumentId, assetId: r.assetId,
      entityType: "part", entityId: r.id,
      action: `added ${r.name}${r.partNumber ? ` (${r.partNumber})` : ""} to ${po?.number ?? "the order"}`,
      field: "status", oldValue: r.status, newValue: "Ordered",
    });
    revWork(r);
  }
  revalidatePath("/purchasing");
  // Whose money this order draws on: sum the committed cost per owning org and
  // ask each allowance whether it can absorb its share. Worst answer travels.
  let flag = "";
  try {
    const byOrg = new Map<number, { instrumentId: number | null; cents: number }>();
    for (const r of rows) {
      if (r.ownerOrgId === null) continue;
      const at = byOrg.get(r.ownerOrgId) ?? { instrumentId: r.instrumentId, cents: 0 };
      at.cents += r.costCents ?? 0;
      byOrg.set(r.ownerOrgId, at);
    }
    for (const [orgId, at] of byOrg) {
      const f = await partsFlag(orgId, at.instrumentId, at.cents > 0 ? at.cents : null);
      if (f) { flag = f; break; }
    }
  } catch { /* a failed check is no flag, never a failed order */ }
  return { id: res.id, number: po?.number ?? "", flag: flag || undefined };
}

/**
 * Hand a list of needed parts to the organization that buys its own.
 *
 * Some clients order for their own systems - their instruments, their money,
 * their vendor account - and what they need from us is the LIST, not an
 * invoice. Before this, "Needed" on such a system meant nobody was moving and
 * the record could not tell you whose move it was.
 *
 * The parts stay Needed, because they are: nothing has been ordered. What
 * changes is that the record now says who was asked and when, and the people
 * at that organization get the list.
 */
export async function sendPartsRequest(
  orgId: number, partIds: number[], note: string,
): Promise<{ error?: string; sent?: number }> {
  const u = await requireEditor();
  if (!partIds.length) return { error: "Pick at least one part" };
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };
  const rows = await db.select().from(parts).where(inArray(parts.id, partIds));
  if (!rows.length) return { error: "Not found" };
  if (rows.some((r) => !partOpen(r.status))) return { error: "One of those is already received or fitted" };
  for (const r of rows) {
    if (r.instrumentId !== null) {
      try { await assertSystemEditable(u, r.instrumentId); } catch { return { error: "Not found" }; }
    }
  }

  const now = new Date();
  for (const r of rows) {
    await db.update(parts).set({ requestedOrgId: orgId, requestedAt: now }).where(eq(parts.id, r.id));
  }
  // One audit line per record, so each system's own history says it was asked.
  for (const instrumentId of [...new Set(rows.map((r) => r.instrumentId))]) {
    const mine = rows.filter((r) => r.instrumentId === instrumentId);
    await audit({
      actor: u.email, instrumentId, assetId: mine[0].assetId, entityType: "part", entityId: mine[0].id,
      action: `asked ${org.name} to order ${mine.length} part${mine.length === 1 ? "" : "s"}: `
        + mine.map((r) => `${r.name}${r.partNumber ? ` (${r.partNumber})` : ""}`).join(", "),
    });
  }
  await notifyPartsRequested({
    to: await ownerAudience(orgId),
    orgName: org.name, actorName: u.name || u.email, note: note.trim(),
    parts: rows.map((r) => ({
      name: r.name, partNumber: r.partNumber,
      qty: parseInt(r.qty) > 0 ? parseInt(r.qty) : 1,
      instrumentId: r.instrumentId, assetId: r.assetId,
    })),
  });
  revalidatePath("/purchasing");
  return { sent: rows.length };
}

export async function cancelPurchaseOrder(id: number, reason: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const { po, manage, see } = await poAccess(u, id);
  if (!po) return { error: "Not found" };
  if (!manage) return { error: see ? "You can't cancel this order" : "Not found" };
  if (po.status === "received") return { error: `${po.number} is already fully received` };
  if (po.status === "cancelled") return {};
  // Received stock stays received: cancelling stops what's outstanding, it
  // doesn't un-deliver anything already booked onto the shelf.
  await db.update(purchaseOrders)
    .set({ status: "cancelled", cancelReason: why, closedAt: new Date() })
    .where(eq(purchaseOrders.id, id));
  await audit({
    actor: u.email, entityType: "po", entityId: id,
    action: `cancelled ${po.number} to ${po.vendor} - reason: ${why}`,
    field: "status", oldValue: po.status, newValue: "cancelled",
  });
  revPo(id);
  return {};
}

// ── Price book ──────────────────────────────────────────────────────────────

export type PartPriceInput = {
  partNumber: string; vendor: string; price: string; isOem?: boolean; url?: string; note?: string;
};

/** One row, validated and case-insensitively matched against what's on file. */
async function cleanPriceRow(r: PartPriceInput): Promise<
  | { ok: false; error: string }
  | { ok: true; pn: string; vendor: string; cents: number; isOem: boolean; url: string; note: string;
      existing: typeof partPrices.$inferSelect | undefined }
> {
  const pn = r.partNumber.trim().slice(0, 80);
  const vendor = r.vendor.trim().slice(0, 80);
  if (!pn || !vendor) return { ok: false, error: "Part number and vendor are both required" };
  const cents = parseMoney(r.price);
  if (cents === null) return { ok: false, error: `"${r.price.trim() || "(blank)"}" isn't a price - use a number like 129.95` };
  const [existing] = await db.select().from(partPrices).where(and(
    sql`lower(${partPrices.partNumber}) = ${pn.toLowerCase()}`,
    sql`lower(${partPrices.vendor}) = ${vendor.toLowerCase()}`,
  ));
  return { ok: true, pn, vendor, cents, isOem: !!r.isOem, url: (r.url ?? "").trim().slice(0, 300), note: (r.note ?? "").trim().slice(0, 200), existing };
}

/**
 * The price book's write path, spreadsheet-shaped like the rest of the
 * catalog. A (PN, vendor) pair that's already on file gets its price updated
 * rather than erroring - re-pasting last quarter's sheet with new numbers is
 * exactly how this will be maintained. Select-then-write rather than an
 * ON CONFLICT clause because the uniqueness lives in an expression index
 * (lower/lower) the ORM can't target; the index still backstops races.
 */
export async function addPartPrices(
  rows: PartPriceInput[],
): Promise<{ error?: string; created?: number; updated?: number; failures?: { row: number; name: string; error: string }[] }> {
  const u = await requireStaff();
  const usable = rows.filter((r) => r.partNumber.trim() || r.vendor.trim() || r.price.trim());
  if (!usable.length) return { error: "Nothing to save" };
  if (usable.length > 300) return { error: "Save 300 rows at a time" };
  const failures: { row: number; name: string; error: string }[] = [];
  let created = 0, updated = 0;
  for (let i = 0; i < usable.length; i++) {
    const row = await cleanPriceRow(usable[i]);
    if (!row.ok) { failures.push({ row: i + 1, name: usable[i].partNumber.trim() || "(no PN)", error: row.error }); continue; }
    const { pn, vendor, cents, isOem, url, note, existing } = row;
    if (existing) {
      await db.update(partPrices).set({ priceCents: cents, isOem, url, note, updatedBy: u.email, updatedAt: new Date() })
        .where(eq(partPrices.id, existing.id));
      if (existing.priceCents !== cents) {
        await audit({
          actor: u.email, entityType: "price", entityId: existing.id,
          action: `re-priced PN ${pn} at ${vendor}: ${formatCents(existing.priceCents)} -> ${formatCents(cents)}`,
          field: "price_cents", oldValue: String(existing.priceCents), newValue: String(cents),
        });
      }
      updated++;
    } else {
      const [p] = await db.insert(partPrices).values({
        tenantOrgId: myTenantOrgId(u),
        partNumber: pn, vendor, priceCents: cents, isOem, url, note, updatedBy: u.email,
      }).returning();
      await audit({
        actor: u.email, entityType: "price", entityId: p.id,
        action: `priced PN ${pn} at ${formatCents(cents)} from ${vendor}${isOem ? " (OEM)" : ""}`,
      });
      created++;
    }
  }
  revalidatePath("/settings/catalog");
  return { created, updated, failures };
}

export async function deletePartPrice(id: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [p] = await db.select().from(partPrices).where(eq(partPrices.id, id));
  if (!p) return {};
  await db.delete(partPrices).where(eq(partPrices.id, id));
  await audit({
    actor: u.email, entityType: "price", entityId: id,
    action: `removed ${p.vendor}'s price for PN ${p.partNumber} (${formatCents(p.priceCents)})`,
  });
  revalidatePath("/settings/catalog");
  return {};
}

/** Who makes a model. Blank is honest for kit whose maker nobody recorded. */
/**
 * What a catalog entry LOOKS like - a stock photo of the model, the module type
 * or the system type.
 *
 * This is the one photo in the app that is not an attachment, and the difference
 * is the whole point. A photo of an SPD-20A illustrates every SPD-20A anybody
 * ever files; making it an attachment would put it on one record, in that
 * client's files, in their gallery, and on their storage bill - and then again
 * for the next client, and the next. So the catalog row owns the blob, every
 * unit of that kind reads it, and nobody is charged for a picture of a model
 * number.
 *
 * Which also means it is never evidence, and the pages that show it say so.
 */
export async function setCatalogPhoto(
  termId: number, file: { fileName: string; url: string; size: number },
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [t] = await db.select().from(vocabTerms).where(eq(vocabTerms.id, termId));
  if (!t) return { error: "Not found" };
  if (readTenant(u) !== null && t.tenantOrgId !== readTenant(u)) return { error: "Not found" };
  const old = t.photoUrl;
  // A new photo replaces the old one outright: a catalog entry has one picture,
  // and keeping the previous one would be storage nobody can see or reach.
  await db.update(vocabTerms).set({ photoUrl: file.url, photoFraming: "" }).where(eq(vocabTerms.id, termId));
  if (old && old !== file.url) await deleteBlobs([old]);
  await audit({
    actor: u.email, entityType: "vocab", entityId: termId,
    action: `${old ? "replaced" : "added"} the catalog photo for ${t.kind === "model" ? `${t.assetType} ` : ""}"${t.name}"`,
  });
  revalidatePath("/settings/catalog");
  rev();
  return {};
}

export async function clearCatalogPhoto(termId: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [t] = await db.select().from(vocabTerms).where(eq(vocabTerms.id, termId));
  if (!t) return { error: "Not found" };
  if (readTenant(u) !== null && t.tenantOrgId !== readTenant(u)) return { error: "Not found" };
  if (!t.photoUrl) return {};
  await db.update(vocabTerms).set({ photoUrl: "", photoFraming: "" }).where(eq(vocabTerms.id, termId));
  await deleteBlobs([t.photoUrl]);
  await audit({
    actor: u.email, entityType: "vocab", entityId: termId,
    action: `removed the catalog photo for "${t.name}"`,
  });
  revalidatePath("/settings/catalog");
  rev();
  return {};
}

/** Frame a catalog photo, the same four numbers a record's photo carries. */
export async function setCatalogPhotoFraming(termId: number, framing: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [t] = await db.select().from(vocabTerms).where(eq(vocabTerms.id, termId));
  if (!t?.photoUrl) return { error: "Not found" };
  if (readTenant(u) !== null && t.tenantOrgId !== readTenant(u)) return { error: "Not found" };
  await db.update(vocabTerms)
    .set({ photoFraming: serializeFrame(parseFrame(framing)) })
    .where(eq(vocabTerms.id, termId));
  revalidatePath("/settings/catalog");
  rev();
  return {};
}

export async function setVocabManufacturer(termId: number, manufacturer: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [t] = await db.select().from(vocabTerms).where(eq(vocabTerms.id, termId));
  if (!t || t.kind !== "model") return { error: "Not found" };
  const mfr = manufacturer.trim().slice(0, 60);
  if (mfr === t.manufacturer) return {};
  await db.update(vocabTerms).set({ manufacturer: mfr }).where(eq(vocabTerms.id, termId));
  await audit({
    actor: u.email, entityType: "vocab", entityId: termId,
    action: `model "${t.name}" (${t.assetType}) is made by ${mfr || "nobody recorded"}`,
    field: "manufacturer", oldValue: t.manufacturer, newValue: mfr,
  });
  revalidatePath("/settings/catalog");
  rev();
  return {};
}

/**
 * Rename a manufacturer/vendor everywhere the name is typed.
 *
 * The name lives as a bare string in eight columns - model catalog, systems,
 * units, part book, part aliases, part rows, purchase orders, price book - and
 * renaming used to mean chasing each spelling down its own link. This is the
 * one operation the maker book exists for: case-insensitive match on the old
 * name, the new spelling written everywhere at once, and the book's own entry
 * kept in step (renamed, merged into an existing entry, or created so the new
 * spelling is defined from here on).
 *
 * Deliberately NOT reversible-per-row: the audit line carries both names and
 * the total, which is what makes an overreaching rename discoverable.
 */
export async function renameMaker(from: string, to: string): Promise<{ error?: string; changed?: number }> {
  const u = await requireStaff();
  const src = cleanMakerName(from);
  const next = cleanMakerName(to);
  if (!src) return { error: "Nothing to rename" };
  if (!next) return { error: "The new name can't be empty" };
  if (src === next) return {};
  const t = readTenant(u);
  const lower = src.toLowerCase();
  let changed = 0;

  changed += (await db.update(vocabTerms).set({ manufacturer: next })
    .where(and(eq(vocabTerms.kind, "model"), sql`lower(${vocabTerms.manufacturer}) = ${lower}`, forTenant(vocabTerms.tenantOrgId, t)))
    .returning({ id: vocabTerms.id })).length;
  changed += (await db.update(instruments).set({ manufacturer: next })
    .where(and(sql`lower(${instruments.manufacturer}) = ${lower}`, forTenant(instruments.tenantOrgId, t)))
    .returning({ id: instruments.id })).length;
  changed += (await db.update(assets).set({ manufacturer: next })
    .where(and(sql`lower(${assets.manufacturer}) = ${lower}`, forTenant(assets.tenantOrgId, t)))
    .returning({ id: assets.id })).length;
  changed += (await db.update(partCatalog).set({ manufacturer: next })
    .where(and(sql`lower(${partCatalog.manufacturer}) = ${lower}`, forTenant(partCatalog.tenantOrgId, t)))
    .returning({ id: partCatalog.id })).length;
  // Aliases carry no tenant stamp of their own; scope through their catalog entry.
  const catIds = await tenantCatalogIds(t);
  if (catIds === null || catIds.length) {
    changed += (await db.update(partNumbers).set({ manufacturer: next })
      .where(and(sql`lower(${partNumbers.manufacturer}) = ${lower}`,
        catIds === null ? undefined : inArray(partNumbers.catalogId, catIds)))
      .returning({ id: partNumbers.id })).length;
  }
  // parts carries no tenant stamp; a row belongs to the system or unit it sits
  // on, so a tenanted sweep reaches only rows on that tenant's records.
  if (t === null) {
    changed += (await db.update(parts).set({ vendor: next })
      .where(sql`lower(${parts.vendor}) = ${lower}`)
      .returning({ id: parts.id })).length;
  } else {
    const [instIds, assetIds] = await Promise.all([
      db.select({ id: instruments.id }).from(instruments).where(forTenant(instruments.tenantOrgId, t)),
      db.select({ id: assets.id }).from(assets).where(forTenant(assets.tenantOrgId, t)),
    ]);
    const onMine = or(
      instIds.length ? inArray(parts.instrumentId, instIds.map((r) => r.id)) : sql`false`,
      assetIds.length ? inArray(parts.assetId, assetIds.map((r) => r.id)) : sql`false`,
    );
    changed += (await db.update(parts).set({ vendor: next })
      .where(and(sql`lower(${parts.vendor}) = ${lower}`, onMine))
      .returning({ id: parts.id })).length;
  }
  changed += (await db.update(purchaseOrders).set({ vendor: next })
    .where(and(sql`lower(${purchaseOrders.vendor}) = ${lower}`, forTenant(purchaseOrders.tenantOrgId, t)))
    .returning({ id: purchaseOrders.id })).length;
  changed += (await db.update(partPrices).set({ vendor: next })
    .where(and(sql`lower(${partPrices.vendor}) = ${lower}`, forTenant(partPrices.tenantOrgId, t)))
    .returning({ id: partPrices.id })).length;

  // Keep the book itself in step: rename the entry, or fold it into one that
  // already carries the new spelling, or define the new spelling outright.
  const bookRows = await db.select().from(vocabTerms)
    .where(and(eq(vocabTerms.kind, "maker"), forTenant(vocabTerms.tenantOrgId, t)));
  const oldTerm = bookRows.find((m) => m.name.toLowerCase() === lower);
  const newTerm = bookRows.find((m) => m.name.toLowerCase() === next.toLowerCase());
  if (oldTerm && newTerm && oldTerm.id !== newTerm.id) {
    await db.delete(vocabTerms).where(eq(vocabTerms.id, oldTerm.id));
  } else if (oldTerm) {
    await db.update(vocabTerms).set({ name: next }).where(eq(vocabTerms.id, oldTerm.id));
  } else if (!newTerm) {
    await db.insert(vocabTerms).values({
      tenantOrgId: myTenantOrgId(u), kind: "maker", assetType: "", name: next, categories: [], manufacturer: "",
    });
  }

  await audit({
    actor: u.email, entityType: "vocab", entityId: `maker:${next}`,
    action: `renamed manufacturer/vendor "${src}" to "${next}" across ${changed} record${changed === 1 ? "" : "s"}`,
    field: "maker", oldValue: src, newValue: next,
  });
  revalidatePath("/settings/catalog");
  revalidatePath("/settings/parts");
  revalidatePath("/assets");
  rev();
  return { changed };
}

/**
 * Retag which system categories a model belongs to. Empty means every system
 * type, so clearing the tags widens a model rather than hiding it.
 */
export async function setVocabCategories(termId: number, categories: string[]): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [t] = await db.select().from(vocabTerms).where(eq(vocabTerms.id, termId));
  if (!t || t.kind !== "model") return { error: "Not found" };
  const cats = [...new Set(categories.map((c) => c.trim()).filter(Boolean))];
  if (cats.join("|") === t.categories.join("|")) return {};
  await db.update(vocabTerms).set({ categories: cats }).where(eq(vocabTerms.id, termId));
  await audit({
    actor: u.email, entityType: "vocab", entityId: termId,
    action: `model "${t.name}" (${t.assetType}) now applies to ${cats.length ? cats.join(", ") : "all system types"}`,
    field: "categories", oldValue: t.categories.join(", "), newValue: cats.join(", "),
  });
  revalidatePath("/settings/catalog");
  rev();
  return {};
}

/**
 * Fold a freehand model spelling into a catalog model: every unit recorded
 * under `from` becomes `to`. The review queue's "suggest a change" - the
 * other resolution besides accepting the new name into the book. Tenant-wide
 * and audited with the count, like renameMaker.
 */
export async function renameAssetModel(kind: string, from: string, to: string): Promise<{ error?: string; changed?: number }> {
  const u = await requireStaff();
  const src = from.trim(), next = to.trim();
  if (!src || !next) return { error: "Both names are needed" };
  if (src.toLowerCase() === next.toLowerCase()) return {};
  const changed = (await db.update(assets).set({ model: next })
    .where(and(
      sql`lower(${assets.kind}) = ${kind.trim().toLowerCase()}`,
      sql`lower(${assets.model}) = ${src.toLowerCase()}`,
      forTenant(assets.tenantOrgId, readTenant(u)),
    ))
    .returning({ id: assets.id })).length;
  await audit({
    actor: u.email, entityType: "vocab", entityId: `model:${next}`,
    action: `folded ${changed} unit${changed === 1 ? "" : "s"} recorded as "${src}" (${kind}) into "${next}"`,
    field: "model", oldValue: src, newValue: next,
  });
  revalidatePath("/settings/catalog");
  revalidatePath("/assets");
  return { changed };
}

export async function deleteVocabTerm(termId: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [t] = await db.select().from(vocabTerms).where(eq(vocabTerms.id, termId));
  if (!t) return {};
  // Removing a type that still has models would strand them behind no picker.
  if (t.kind === "asset_type") {
    const models = await db.select({ id: vocabTerms.id }).from(vocabTerms)
      .where(and(eq(vocabTerms.kind, "model"), eq(vocabTerms.assetType, t.name)));
    if (models.length) return { error: `Remove or move its ${models.length} model${models.length === 1 ? "" : "s"} first` };
  }
  await db.delete(vocabTerms).where(eq(vocabTerms.id, termId));
  await audit({
    actor: u.email, entityType: "vocab", entityId: termId,
    action: t.kind === "category"
      ? `removed system category "${t.name}" from the catalog (systems using it keep it)`
      : t.kind === "asset_type"
        ? `removed asset type "${t.name}" from the catalog (units recorded as it keep it)`
        : t.kind === "maker"
          ? `removed "${t.name}" from the manufacturer & vendor book (records keep the name)`
          : `removed model "${t.name}" (${t.assetType}) from the catalog`,
  });
  revalidatePath("/settings/catalog");
  revalidatePath("/settings/procedures");
  revalidatePath("/maintenance");
  rev();
  return {};
}

// ---------------- Settings ----------------

/**
 * The one master switch: whether clients can sign in at all. What each person
 * may DO once inside is per-membership now (`client_allowlist.can_edit`), so
 * the old global `clientCanEdit` column is retired - still in the schema for
 * compat, read by nothing.
 */
export async function updateSettings(data: { clientAccessEnabled: boolean }) {
  const u = await requirePlatformOwner();
  await db.insert(appSettings)
    .values({ id: 1, clientAccessEnabled: data.clientAccessEnabled })
    .onConflictDoUpdate({ target: appSettings.id, set: { clientAccessEnabled: data.clientAccessEnabled } });
  await audit({
    actor: u.email, entityType: "settings", entityId: 1,
    action: `client sign-in ${data.clientAccessEnabled ? "on" : "off"}`,
  });
  revalidatePath("/settings");
}

// ---------------- Sites and addresses ----------------
// Where a company is, and where its instruments actually are - two different
// facts, and conflating them is what makes a service business print the wrong
// thing on paper. Billing is a column on the organization; labs are rows,
// because a client can have three and a system lives at exactly one. See
// lib/sites.

/**
 * Who may set an organization's addresses and sites: the operator's staff (via
 * mayAdminOrg, which refuses another operator's client however the id arrives),
 * and the organization's OWN editors - a client should be able to correct their
 * own lab address without filing a ticket.
 */
async function assertOrgConfigurable(u: SessionUser, org: typeof orgs.$inferSelect) {
  if (mayAdminOrg(tenantViewer(u), org)) return;
  if (u.role === "client_editor" && u.orgId === org.id) return;
  throw new Error("Not found");
}

/** An org's own tenant: itself when it runs a workspace, its operator otherwise. */
const orgTenant = (org: { id: number; isOperator: boolean; parentOrgId: number | null }) =>
  (org.isOperator ? org.id : org.parentOrgId);

export async function setOrgBillingAddress(orgId: number, address: string): Promise<{ error?: string }> {
  const u = await requireUser();
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };
  try { await assertOrgConfigurable(u, org); } catch { return { error: "Not found" }; }
  const next = address.trim().slice(0, 600);
  if (next === org.billingAddress) return {};
  await db.update(orgs).set({ billingAddress: next }).where(eq(orgs.id, orgId));
  await audit({
    actor: u.email, entityType: "org", entityId: orgId, tenantOrgId: orgTenant(org),
    action: next ? `set ${org.name}'s billing address` : `cleared ${org.name}'s billing address`,
    field: "billingAddress", oldValue: org.billingAddress, newValue: next,
  });
  revalidatePath(`/settings/organizations/${orgId}`);
  return {};
}

export type SiteInput = {
  name: string; address: string; accessNotes: string; contactName: string; contactPhone: string;
};

const cleanSite = (d: SiteInput) => ({
  name: d.name.trim().slice(0, 80),
  address: d.address.trim().slice(0, 600),
  accessNotes: d.accessNotes.trim().slice(0, 1000),
  contactName: d.contactName.trim().slice(0, 80),
  contactPhone: d.contactPhone.trim().slice(0, 40),
});

export async function addOrgSite(orgId: number, data: SiteInput): Promise<{ error?: string; id?: number }> {
  const u = await requireUser();
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };
  try { await assertOrgConfigurable(u, org); } catch { return { error: "Not found" }; }
  const clean = cleanSite(data);
  // A site with no name AND no address is a row nobody can pick out of a list.
  if (!clean.name && !clean.address) return { error: "Give it a name or an address" };
  const [row] = await db.insert(orgSites).values({
    ...clean, orgId, tenantOrgId: orgTenant(org), createdBy: u.email,
  }).returning();
  await audit({
    actor: u.email, entityType: "site", entityId: row.id, tenantOrgId: orgTenant(org),
    action: `added site "${siteLabel(row)}" for ${org.name}`,
  });
  revalidatePath(`/settings/organizations/${orgId}`);
  rev();
  return { id: row.id };
}

export async function updateOrgSite(siteId: number, data: SiteInput): Promise<{ error?: string }> {
  const u = await requireUser();
  const [site] = await db.select().from(orgSites).where(eq(orgSites.id, siteId));
  if (!site) return { error: "Not found" };
  const [siteOrg] = await db.select().from(orgs).where(eq(orgs.id, site.orgId));
  if (!siteOrg) return { error: "Not found" };
  try { await assertOrgConfigurable(u, siteOrg); } catch { return { error: "Not found" }; }
  const clean = cleanSite(data);
  if (!clean.name && !clean.address) return { error: "Give it a name or an address" };
  await db.update(orgSites).set(clean).where(eq(orgSites.id, siteId));
  await audit({
    actor: u.email, entityType: "site", entityId: siteId, tenantOrgId: site.tenantOrgId,
    action: `edited site "${siteLabel({ ...site, ...clean })}"`,
  });
  revalidatePath(`/settings/organizations/${site.orgId}`);
  rev();
  return {};
}

/**
 * Close a site, or reopen it. Never a delete: a closed lab is still where an
 * instrument was, and the systems pointing at it are not wrong about their own
 * history.
 */
export async function archiveOrgSite(siteId: number, archived: boolean): Promise<{ error?: string }> {
  const u = await requireUser();
  const [site] = await db.select().from(orgSites).where(eq(orgSites.id, siteId));
  if (!site) return { error: "Not found" };
  const [siteOrg] = await db.select().from(orgs).where(eq(orgs.id, site.orgId));
  if (!siteOrg) return { error: "Not found" };
  try { await assertOrgConfigurable(u, siteOrg); } catch { return { error: "Not found" }; }
  await db.update(orgSites).set({ archived }).where(eq(orgSites.id, siteId));
  await audit({
    actor: u.email, entityType: "site", entityId: siteId, tenantOrgId: site.tenantOrgId,
    action: `${archived ? "closed" : "reopened"} site "${siteLabel(site)}"`,
  });
  revalidatePath(`/settings/organizations/${site.orgId}`);
  rev();
  return {};
}

/** Which of the owner's sites a system sits at. */
export async function setSystemSite(instrumentId: number, siteId: number | null): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  try { await assertSystemEditable(u, instrumentId); } catch { return { error: "Not found" }; }

  let label = "no site";
  if (siteId !== null) {
    const [site] = await db.select().from(orgSites).where(eq(orgSites.id, siteId));
    // The site has to belong to whoever owns the system. Without this check a
    // hand-edited id would file one client's instrument at another's address,
    // which is a data leak wearing a dropdown.
    if (!site || site.orgId !== inst.ownerOrgId) return { error: "That site isn't one of this system's owner's" };
    label = siteLabel(site);
  }
  await db.update(instruments).set({ siteId, updatedAt: new Date() }).where(eq(instruments.id, instrumentId));
  await audit({
    actor: u.email, instrumentId, entityType: "instrument", entityId: inst.externalId,
    action: siteId === null ? "cleared the site" : `set the site to ${label}`,
    field: "site", newValue: label,
  });
  rev(instrumentId);
  return {};
}

// ---------------- Part catalog ----------------
// What a part number IS - the spine the five tables that store part numbers as
// bare strings were missing. Deliberately not a foreign key from any of them: a
// part fitted at 2am must land in the record whether or not it is catalogued.
// See lib/partCatalog.

export type CatalogInput = {
  partNumber: string; name: string; manufacturer: string; mfrPartNumber: string;
  kind: string; assetTypes: string[]; models?: string[]; note: string;
  /** The part's OTHER numbers - ours and the makers'. See lib/partCatalog. */
  aliases?: PartAlias[];
};

/**
 * Why a number is refused, in words somebody can act on.
 *
 * A RETIRED entry still holds its numbers - reusing one would silently
 * re-point every old record at the new description - but it is filtered out of
 * the list on screen, so naming it without saying it is retired sends somebody
 * looking for an entry they cannot see.
 */
function clashMessage(clash: { number: string; entry: { partNumber: string; name: string; archived: boolean } }): string {
  const who = `${clash.entry.partNumber}${clash.entry.name ? ` - ${clash.entry.name}` : ""}`;
  return clash.entry.archived
    ? `${clash.number} belongs to ${who}, which is retired. Restore it, or give this one a different number.`
    : `${clash.number} already belongs to ${who}`;
}

/**
 * Attach each entry's other numbers, for a clash check that sees all of them.
 * One query for the whole book rather than one per row.
 */
async function loadAliases<T extends { id: number }>(rows: T[]): Promise<(T & { aliases: PartAlias[] })[]> {
  const ids = rows.map((r) => r.id);
  const alias = ids.length
    ? await db.select().from(partNumbers).where(inArray(partNumbers.catalogId, ids)).catch(() => [])
    : [];
  return rows.map((r) => ({
    ...r,
    aliases: alias.filter((a) => a.catalogId === r.id).map((a) => ({
      kind: a.kind, partNumber: a.partNumber, manufacturer: a.manufacturer, note: a.note,
    })),
  }));
}

/**
 * Replace an entry's other numbers wholesale.
 *
 * Same reasoning as setKitLines: this is a short list somebody edits as a block
 * in one sheet, and diffing it row by row would buy nothing but a chance to get
 * it wrong.
 */
async function writeAliases(catalogId: number, aliases: PartAlias[]) {
  await db.delete(partNumbers).where(eq(partNumbers.catalogId, catalogId));
  if (!aliases.length) return;
  await db.insert(partNumbers).values(aliases.map((a, i) => ({
    catalogId, kind: a.kind, partNumber: a.partNumber,
    manufacturer: a.manufacturer ?? "", note: a.note ?? "", sortOrder: i,
  })));
}

const cleanCatalog = (d: CatalogInput) => ({
  partNumber: d.partNumber.trim().slice(0, 80),
  name: d.name.trim().slice(0, 160),
  manufacturer: d.manufacturer.trim().slice(0, 80),
  mfrPartNumber: d.mfrPartNumber.trim().slice(0, 80),
  kind: (PART_KINDS as readonly string[]).includes(d.kind) ? d.kind : "part",
  assetTypes: [...new Set(d.assetTypes.map((t) => t.trim()).filter(Boolean))],
  models: [...new Set((d.models ?? []).map((m) => m.trim()).filter(Boolean))],
  note: d.note.trim().slice(0, 500),
});

// ── Catalog reference library ───────────────────────────────────────────────
// Manuals, links and field notes filed on a model or module type, surfacing on
// every unit with matching equipment. See lib/catalogRefs and db catalog_refs.

export type CatalogRefInput = {
  assetType: string; model: string; kind: string;
  title: string; url: string; body: string;
  /** Whose material this is - see lib/provenance. Asked at filing time. */
  provenance?: string;
};

/**
 * The shop's own files, for the catalog reference picker: the manuals already
 * on the shelf and the photos already on records. Pasting a URL was the wrong
 * ask - somebody with fifty manuals uploaded should point at one, not copy an
 * address for it.
 *
 * Read through storeFiles, the same primitive Documents and Gallery use, so
 * this offers exactly the files the viewer can already see and nothing else.
 */
export async function listStoreFilesForRef(): Promise<{
  files: { id: number; fileName: string; kind: string; description: string; size: number; isPhoto: boolean; where: string }[];
}> {
  const u = await requireStaff();
  const rows = await storeFiles(u.orgId ?? null, 500).catch(() => []);
  return {
    files: rows.map((r) => ({
      id: r.id, fileName: r.fileName, kind: r.kind, description: r.description, size: r.size,
      isPhoto: isPhotoFile(r),
      // Where it already lives, so two files with the same name are telling apart.
      where: r.externalId ?? r.assetLabel ?? "on the shelf",
    })),
  };
}

/**
 * Declare which gases a catalog entry needs. Applied to equipment created from
 * here on; existing records keep whatever somebody already set, because a gas
 * status is shop-floor truth and this is only the default.
 */
export async function setCatalogGases(termId: number, gases: string[]): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [term] = await db.select().from(vocabTerms).where(eq(vocabTerms.id, termId));
  if (!term) return { error: "Not found" };
  if (readTenant(u) !== null && term.tenantOrgId !== readTenant(u)) return { error: "Not found" };
  const clean = [...new Set(gases.map((g) => g.trim()).filter((g) => (GASES as readonly string[]).includes(g)))];
  await db.update(vocabTerms).set({ gases: clean }).where(eq(vocabTerms.id, termId));
  await audit({
    actor: u.email, entityType: "vocab", entityId: termId, tenantOrgId: term.tenantOrgId,
    action: clean.length
      ? `${term.name} needs ${clean.join(", ")}`
      : `${term.name} no longer declares a gas requirement`,
    field: "gases", oldValue: term.gases.join(", "), newValue: clean.join(", "),
  });
  revalidatePath("/settings/catalog");
  return {};
}

/**
 * Replace a model's specification sheet. Whole-sheet on purpose: the editor
 * works on the full list (add, remove, reorder by retyping, copy from a
 * sibling), and per-row actions would just be a chattier way to lose a race
 * with yourself. serializeSpecs drops blank rows and dedupes names, so what
 * is stored is exactly what renders back.
 */
export async function setModelSpecs(
  termId: number, specs: { name: string; value: string }[],
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [term] = await db.select().from(vocabTerms).where(eq(vocabTerms.id, termId));
  if (!term || term.kind !== "model") return { error: "Not found" };
  if (readTenant(u) !== null && term.tenantOrgId !== readTenant(u)) return { error: "Not found" };
  const next = serializeModelSpecs(specs);
  if (next === term.specs) return {};
  const before = parseModelSpecs(term.specs);
  const after = parseModelSpecs(next);
  await db.update(vocabTerms).set({ specs: next }).where(eq(vocabTerms.id, termId));
  await audit({
    actor: u.email, entityType: "vocab", entityId: termId, tenantOrgId: term.tenantOrgId,
    action: `updated ${term.name}'s spec sheet: ${after.length} row${after.length === 1 ? "" : "s"} (was ${before.length})`,
    field: "specs",
    oldValue: before.map((s) => `${s.name}: ${s.value}`).join("; ").slice(0, 500),
    newValue: after.map((s) => `${s.name}: ${s.value}`).join("; ").slice(0, 500),
  });
  revalidatePath("/settings/catalog");
  revalidatePath(`/catalog/${termId}`);
  return {};
}

/**
 * The public summary: the paragraph that makes a model's public page worth
 * indexing, because it is the only part of it that exists nowhere else.
 * Saved separately from publishing, so it can be drafted before anyone
 * decides the page goes out.
 */
export async function setModelSummary(termId: number, summary: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [term] = await db.select().from(vocabTerms).where(eq(vocabTerms.id, termId));
  if (!term || term.kind !== "model") return { error: "Not found" };
  if (readTenant(u) !== null && term.tenantOrgId !== readTenant(u)) return { error: "Not found" };
  const next = summary.replace(/[ \t]+/g, " ").trim().slice(0, MAX_SUMMARY);
  if (next === term.publicSummary) return {};
  await db.update(vocabTerms).set({ publicSummary: next }).where(eq(vocabTerms.id, termId));
  await audit({
    actor: u.email, entityType: "vocab", entityId: termId, tenantOrgId: term.tenantOrgId,
    action: next ? `wrote the public summary for ${term.name}` : `cleared ${term.name}'s public summary`,
    field: "public_summary", oldValue: term.publicSummary.slice(0, 300), newValue: next.slice(0, 300),
  });
  revalidatePath(`/catalog/${termId}`);
  if (term.published && term.publicSlug) revalidatePath(`/equipment/${term.publicSlug}`);
  return {};
}

/**
 * Put a model's page on the public web, or take it back off.
 *
 * Publishing is refused unless the page has something to say (publishBlockers):
 * a maker, a real summary, and specs. That refusal is the whole point - a
 * catalog dumped into an index as hundreds of near-identical stubs is what
 * search engines punish, and one shop's reputation with them is not worth a
 * few extra URLs.
 *
 * The slug is minted once and then kept, even through a rename: a page that
 * has earned its place in an index must not lose it because somebody fixed a
 * capital letter.
 */
export async function setModelPublished(termId: number, published: boolean): Promise<{ error?: string; slug?: string }> {
  const u = await requireStaff();
  const [term] = await db.select().from(vocabTerms).where(eq(vocabTerms.id, termId));
  if (!term || term.kind !== "model") return { error: "Not found" };
  if (readTenant(u) !== null && term.tenantOrgId !== readTenant(u)) return { error: "Not found" };

  if (!published) {
    if (!term.published) return {};
    await db.update(vocabTerms).set({ published: false }).where(eq(vocabTerms.id, termId));
    await audit({
      actor: u.email, entityType: "vocab", entityId: termId, tenantOrgId: term.tenantOrgId,
      action: `took ${term.name}'s public page down`,
      field: "published", oldValue: "true", newValue: "false",
    });
    revalidatePath(`/catalog/${termId}`);
    revalidatePath("/equipment");
    if (term.publicSlug) revalidatePath(`/equipment/${term.publicSlug}`);
    return {};
  }

  const blockers = publishBlockers({
    manufacturer: term.manufacturer, name: term.name, summary: term.publicSummary,
    specs: parseModelSpecs(term.specs), hasPhoto: !!term.photoUrl,
  });
  if (blockers.length) return { error: blockers[0] };

  // Only the operator's own library is published: one canonical page per model,
  // rather than a race between two tenants' versions of the same pump.
  const brand = await getBrand();
  if (brand.operatorOrgId !== null && term.tenantOrgId !== null && term.tenantOrgId !== brand.operatorOrgId) {
    return { error: "Only the operator's own catalog is published publicly" };
  }

  let slug = term.publicSlug;
  if (!slug) {
    const taken = await db.select({ slug: vocabTerms.publicSlug }).from(vocabTerms)
      .where(ne(vocabTerms.publicSlug, ""));
    slug = uniqueSlug(modelSlug(term.manufacturer, term.name), taken.map((r) => r.slug));
  }
  await db.update(vocabTerms).set({ published: true, publicSlug: slug }).where(eq(vocabTerms.id, termId));
  await audit({
    actor: u.email, entityType: "vocab", entityId: termId, tenantOrgId: term.tenantOrgId,
    action: `published ${term.name} to the public catalog at /equipment/${slug}`,
    field: "published", oldValue: "false", newValue: "true",
  });
  revalidatePath(`/catalog/${termId}`);
  revalidatePath("/equipment");
  revalidatePath(`/equipment/${slug}`);
  return { slug };
}

export async function addCatalogRef(data: CatalogRefInput): Promise<{ error?: string; id?: number }> {
  const u = await requireStaff();
  const assetType = data.assetType.trim().slice(0, 60);
  if (!assetType) return { error: "Pick which equipment this is about" };
  const kind = data.kind === "note" ? "note" : "link";
  const title = data.title.trim().slice(0, 160);
  const url = data.url.trim().slice(0, 1000);
  const body = data.body.trim().slice(0, 4000);
  // http(s) for an outside manual, or one of our own authorized file routes -
  // that is how a photo already in the record gets filed by reference rather
  // than copied, so it costs no storage and stays access-checked.
  if (url && !/^https?:\/\//i.test(url) && !/^\/api\/(files|catalog)\//.test(url)) {
    return { error: "A link should start with http:// or https://" };
  }
  if (kind === "link" && !url) return { error: "A link needs a URL" };
  if (kind === "note" && !body && !url) return { error: "A note needs some text (or at least a picture)" };
  const [row] = await db.insert(catalogRefs).values({
    tenantOrgId: myTenantOrgId(u),
    assetType, model: data.model.trim().slice(0, 120), kind, title, url, body,
    provenance: cleanProvenance(data.provenance),
    createdBy: u.name || u.email,
  }).returning();
  await audit({
    actor: u.email, entityType: "catalog_ref", entityId: row.id, tenantOrgId: row.tenantOrgId,
    action: `filed ${kind} "${title || url || body.slice(0, 40)}" under ${row.model || `any ${assetType}`}`,
  });
  revalidatePath("/settings/catalog");
  return { id: row.id };
}

/**
 * Classify where a piece of reference material came from.
 *
 * One action for both libraries, because the question and the consequence are
 * identical: a procedure and a filed note are equally licensable or equally
 * not, and two near-identical actions is how the two drift apart.
 *
 * The audit line names the old and new class - reclassifying something as ours
 * is exactly the move that would need explaining later, so it leaves a trail
 * with a name on it.
 */
export async function setProvenance(
  what: "ref" | "procedure", id: number, provenance: string,
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const next = cleanProvenance(provenance);
  const t = readTenant(u);
  if (what === "ref") {
    const [row] = await db.select().from(catalogRefs).where(eq(catalogRefs.id, id));
    if (!row) return { error: "Not found" };
    if (t !== null && row.tenantOrgId !== t) return { error: "Not found" };
    if (row.provenance === next) return {};
    await db.update(catalogRefs).set({ provenance: next }).where(eq(catalogRefs.id, id));
    await audit({
      actor: u.email, entityType: "catalog_ref", entityId: id, tenantOrgId: row.tenantOrgId,
      action: `marked "${row.title || row.url || row.body.slice(0, 40)}" as ${PROVENANCE_LABEL[next].toLowerCase()}`,
      field: "provenance", oldValue: row.provenance, newValue: next,
    });
  } else {
    const [row] = await db.select().from(procedures).where(eq(procedures.id, id));
    if (!row) return { error: "Not found" };
    if (t !== null && row.tenantOrgId !== t) return { error: "Not found" };
    if (row.provenance === next) return {};
    await db.update(procedures).set({ provenance: next }).where(eq(procedures.id, id));
    await audit({
      actor: u.email, entityType: "procedure", entityId: id, tenantOrgId: row.tenantOrgId,
      action: `marked procedure "${row.name}" as ${PROVENANCE_LABEL[next].toLowerCase()}`,
      field: "provenance", oldValue: row.provenance, newValue: next,
    });
  }
  revalidatePath("/settings/catalog");
  revalidatePath("/settings/procedures");
  return {};
}

export async function removeCatalogRef(id: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [row] = await db.select().from(catalogRefs).where(eq(catalogRefs.id, id));
  if (!row) return {};
  if (readTenant(u) !== null && row.tenantOrgId !== readTenant(u)) return { error: "Not found" };
  await db.delete(catalogRefs).where(eq(catalogRefs.id, id));
  await audit({
    actor: u.email, entityType: "catalog_ref", entityId: id, tenantOrgId: row.tenantOrgId,
    action: `removed ${row.kind} "${row.title || row.url || row.body.slice(0, 40)}" from ${row.model || `any ${row.assetType}`}`,
  });
  revalidatePath("/settings/catalog");
  return {};
}

/**
 * The parts book, for pickers that need to name a part rather than have one
 * typed - the contract's included kits, most of all. Kits lead, because that
 * is what a PM contract entitles somebody to.
 */
export async function listCatalogPartsForPicker(): Promise<{
  parts: { partNumber: string; name: string; kind: string }[];
}> {
  const u = await requireStaff();
  const rows = await db.select({
    partNumber: partCatalog.partNumber, name: partCatalog.name, kind: partCatalog.kind,
  }).from(partCatalog)
    .where(and(forTenant(partCatalog.tenantOrgId, readTenant(u)), eq(partCatalog.archived, false)))
    .orderBy(asc(partCatalog.partNumber))
    .catch(() => []);
  const rank = (k: string) => (k === "kit" ? 0 : 1);
  return { parts: [...rows].sort((a, b) => rank(a.kind) - rank(b.kind)) };
}

/**
 * The parts book as a part-number field needs it: every live entry with its
 * other numbers and its cover photo.
 *
 * Fetched once per field on first use and filtered in the browser rather than
 * round-tripping every keystroke - a shop's book is hundreds of rows, matching
 * is pure (lib/partCatalog), and a dropdown that lags behind typing is a
 * dropdown people stop reading. Capped so it stays that way if a book ever runs
 * to thousands.
 */
export async function catalogForLookup(): Promise<{
  parts: {
    id: number; partNumber: string; name: string; manufacturer: string; mfrPartNumber: string;
    kind: string; archived: boolean; aliases: PartAlias[]; photoUrl: string;
    /** Best known offer, staff only - see the redaction note below. */
    vendor: string; priceCents: number | null; isOem: boolean;
  }[];
}> {
  const u = await requireUser();
  const rows = await db.select().from(partCatalog)
    .where(and(forTenant(partCatalog.tenantOrgId, readTenant(u)), eq(partCatalog.archived, false)))
    .orderBy(asc(partCatalog.partNumber))
    .limit(2000)
    .catch(() => []);
  if (!rows.length) return { parts: [] };
  const ids = rows.map((r) => r.id);
  // The price book rides along so a pick can fill cost and vendor, not just the
  // number and its name - but ONLY for staff. This is a new way to read the
  // shop's buying prices, and lib/redact's rule has to hold on it exactly as it
  // holds on a part row: what a thing cost is the buyer's business. A client
  // signing in gets the numbers and the names and no money at all.
  const staff = isStaffRole(u.role);
  const [alias, photos, book] = await Promise.all([
    db.select().from(partNumbers).where(inArray(partNumbers.catalogId, ids)).catch(() => []),
    db.select().from(partPhotos).where(inArray(partPhotos.catalogId, ids))
      .orderBy(asc(partPhotos.sortOrder), asc(partPhotos.id)).catch(() => []),
    staff ? db.select().from(partPrices)
      .where(forTenant(partPrices.tenantOrgId, readTenant(u))).catch(() => []) : [],
  ]);
  return {
    parts: rows.map((r) => {
      const aliases = alias.filter((a) => a.catalogId === r.id).map((a) => ({
        kind: a.kind, partNumber: a.partNumber, manufacturer: a.manufacturer, note: a.note,
      }));
      // Priced across ALL of the part's numbers, cheapest first: the price book
      // is keyed by the string somebody typed when they entered a price, and
      // that is as often the maker's number as ours. Looking only under the
      // primary is how a part with a price reads as unpriced.
      const best = allNumbers({ ...r, aliases })
        .map((pn) => bestPrice(book, pn))
        .filter((o): o is NonNullable<typeof o> => o !== null)
        .sort((a, b) => a.priceCents - b.priceCents || Number(b.isOem) - Number(a.isOem))[0] ?? null;
      return {
        id: r.id, partNumber: r.partNumber, name: r.name, manufacturer: r.manufacturer,
        mfrPartNumber: r.mfrPartNumber, kind: r.kind, archived: r.archived,
        aliases,
        photoUrl: photos.find((ph) => ph.catalogId === r.id)?.url ?? "",
        vendor: best?.vendor ?? "", priceCents: best?.priceCents ?? null, isOem: best?.isOem ?? false,
      };
    }),
  };
}

export async function addCatalogPart(data: CatalogInput): Promise<{ error?: string; id?: number }> {
  const u = await requireStaff();
  const clean = cleanCatalog(data);
  if (!clean.partNumber) return { error: "A part number is the one thing this needs" };
  const tenant = myTenantOrgId(u);
  const mine = await db.select().from(partCatalog).where(forTenant(partCatalog.tenantOrgId, tenant));
  // Checked here so the answer is a sentence rather than a unique-violation
  // page; the index in schema-sync is what makes it true under a race.
  //
  // Against EVERY number on both sides, not just the primaries: two entries
  // answering to one number would resolve to whichever came first, so the same
  // box would describe itself differently depending on the screen.
  const aliases = cleanAliases(data.aliases ?? [], clean);
  const withAliases = await loadAliases(mine);
  const clash = numberClash(withAliases, { ...clean, aliases });
  if (clash) return { error: clashMessage(clash) };
  const [row] = await db.insert(partCatalog).values({
    ...clean, tenantOrgId: tenant, createdBy: u.email,
  }).returning();
  await writeAliases(row.id, aliases);
  await audit({
    actor: u.email, entityType: "part_catalog", entityId: row.id, tenantOrgId: tenant,
    action: `catalogued ${clean.partNumber}${clean.name ? ` - ${clean.name}` : ""} (${PART_KIND_LABEL[clean.kind].toLowerCase()})`,
  });
  revalidatePath("/settings/parts");
  return { id: row.id };
}

export async function updateCatalogPart(id: number, data: CatalogInput): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [before] = await db.select().from(partCatalog).where(eq(partCatalog.id, id));
  if (!before) return { error: "Not found" };
  if (readTenant(u) !== null && before.tenantOrgId !== readTenant(u)) return { error: "Not found" };
  const clean = cleanCatalog(data);
  if (!clean.partNumber) return { error: "A part number is the one thing this needs" };
  const mine = await db.select().from(partCatalog).where(forTenant(partCatalog.tenantOrgId, before.tenantOrgId));
  const aliases = cleanAliases(data.aliases ?? [], clean);
  const others = await loadAliases(mine.filter((c) => c.id !== id));
  const clash = numberClash(others, { ...clean, aliases });
  if (clash) return { error: clashMessage(clash) };
  await db.update(partCatalog).set(clean).where(eq(partCatalog.id, id));
  await writeAliases(id, aliases);
  await audit({
    actor: u.email, entityType: "part_catalog", entityId: id, tenantOrgId: before.tenantOrgId,
    action: `edited catalog entry ${clean.partNumber}${clean.name ? ` - ${clean.name}` : ""}`,
    field: "part", oldValue: `${before.partNumber} ${before.name}`, newValue: `${clean.partNumber} ${clean.name}`,
  });
  revalidatePath("/settings/parts");
  return {};
}

/**
 * What a part looks like.
 *
 * Same reasoning as a model's stock photo: one photo of a check valve is a
 * photo of every check valve of that number, so it lives on the catalog row
 * rather than on any record - it shows wherever the number does, and lands on
 * nobody's file list and nobody's storage bill. Several per part, because the
 * useful set is "the thing", "its label", and "where it goes".
 */
export async function addPartPhotos(
  catalogId: number, files: { url: string; caption?: string }[],
): Promise<{ error?: string }> {
  const u = await requireStaff();
  if (!files.length) return {};
  const [row] = await db.select().from(partCatalog).where(eq(partCatalog.id, catalogId));
  if (!row) return { error: "Not found" };
  if (readTenant(u) !== null && row.tenantOrgId !== readTenant(u)) return { error: "Not found" };
  const have = await db.select({ sortOrder: partPhotos.sortOrder }).from(partPhotos)
    .where(eq(partPhotos.catalogId, catalogId));
  if (have.length + files.length > MAX_PART_PHOTOS) {
    return { error: `A part keeps up to ${MAX_PART_PHOTOS} photos - remove one first` };
  }
  const from = Math.max(0, ...have.map((h) => h.sortOrder)) + 1;
  await db.insert(partPhotos).values(files.map((f, i) => ({
    catalogId, url: f.url, caption: (f.caption ?? "").trim().slice(0, 120),
    sortOrder: from + i, uploadedBy: u.name,
  })));
  await audit({
    actor: u.email, entityType: "part_catalog", entityId: catalogId, tenantOrgId: row.tenantOrgId,
    action: `added ${files.length} photo${files.length === 1 ? "" : "s"} to ${row.partNumber}`,
  });
  revalidatePath("/settings/parts");
  return {};
}


export async function removePartPhoto(photoId: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [photo] = await db.select().from(partPhotos).where(eq(partPhotos.id, photoId));
  if (!photo) return { error: "Not found" };
  const [row] = await db.select().from(partCatalog).where(eq(partCatalog.id, photo.catalogId));
  if (!row) return { error: "Not found" };
  if (readTenant(u) !== null && row.tenantOrgId !== readTenant(u)) return { error: "Not found" };
  await db.delete(partPhotos).where(eq(partPhotos.id, photoId));
  // Blob-owned, not an attachment: nothing else points at these bytes, so
  // leaving them would be storage nobody can see or reach.
  await deleteBlobs([photo.url]);
  await audit({
    actor: u.email, entityType: "part_catalog", entityId: photo.catalogId, tenantOrgId: row.tenantOrgId,
    action: `removed a photo from ${row.partNumber}`,
  });
  revalidatePath("/settings/parts");
  return {};
}

/** The caption is what tells three photos of one part apart. */
export async function setPartPhotoCaption(photoId: number, caption: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [photo] = await db.select().from(partPhotos).where(eq(partPhotos.id, photoId));
  if (!photo) return { error: "Not found" };
  const [row] = await db.select().from(partCatalog).where(eq(partCatalog.id, photo.catalogId));
  if (!row) return { error: "Not found" };
  if (readTenant(u) !== null && row.tenantOrgId !== readTenant(u)) return { error: "Not found" };
  await db.update(partPhotos).set({ caption: caption.trim().slice(0, 120) }).where(eq(partPhotos.id, photoId));
  revalidatePath("/settings/parts");
  return {};
}

/**
 * Make one photo the cover - the one shown beside the number everywhere else.
 * Ordering rather than a flag: "first" is already what cover means here, and a
 * flag would be a second source of truth for the same fact.
 */
export async function makePartPhotoCover(photoId: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [photo] = await db.select().from(partPhotos).where(eq(partPhotos.id, photoId));
  if (!photo) return { error: "Not found" };
  const [row] = await db.select().from(partCatalog).where(eq(partCatalog.id, photo.catalogId));
  if (!row) return { error: "Not found" };
  if (readTenant(u) !== null && row.tenantOrgId !== readTenant(u)) return { error: "Not found" };
  const rest = await db.select({ id: partPhotos.id }).from(partPhotos)
    .where(and(eq(partPhotos.catalogId, photo.catalogId), ne(partPhotos.id, photoId)))
    .orderBy(asc(partPhotos.sortOrder), asc(partPhotos.id));
  await db.update(partPhotos).set({ sortOrder: 0 }).where(eq(partPhotos.id, photoId));
  for (let i = 0; i < rest.length; i++) {
    await db.update(partPhotos).set({ sortOrder: i + 1 }).where(eq(partPhotos.id, rest[i].id));
  }
  revalidatePath("/settings/parts");
  return {};
}

/**
 * Retire a catalog entry, or bring it back.
 *
 * Never a delete while anything still refers to the number - and something
 * always does, because the references are text and cannot be found reliably.
 * Archiving keeps history readable: a part retired last year is still what was
 * fitted in March.
 */
export async function archiveCatalogPart(id: number, archived: boolean): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [row] = await db.select().from(partCatalog).where(eq(partCatalog.id, id));
  if (!row) return { error: "Not found" };
  if (readTenant(u) !== null && row.tenantOrgId !== readTenant(u)) return { error: "Not found" };
  await db.update(partCatalog).set({ archived }).where(eq(partCatalog.id, id));
  await audit({
    actor: u.email, entityType: "part_catalog", entityId: id, tenantOrgId: row.tenantOrgId,
    action: `${archived ? "retired" : "un-retired"} ${row.partNumber}${row.name ? ` - ${row.name}` : ""}`,
  });
  revalidatePath("/settings/parts");
  return {};
}

/**
 * What is in a kit. Replaces the whole list in one go, because that is how the
 * editor works - a kit is a short list somebody edits as a block, and diffing
 * it line by line would buy nothing.
 */
export async function setKitLines(
  kitId: number, lines: { partNumber: string; name: string; qty: number }[],
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [kit] = await db.select().from(partCatalog).where(eq(partCatalog.id, kitId));
  if (!kit) return { error: "Not found" };
  if (readTenant(u) !== null && kit.tenantOrgId !== readTenant(u)) return { error: "Not found" };
  if (kit.kind !== "kit") return { error: "Only a kit has contents - change its type first" };
  const usable = lines
    .map((l, i) => ({
      partNumber: l.partNumber.trim().slice(0, 80),
      name: l.name.trim().slice(0, 160),
      qty: Number.isFinite(l.qty) && l.qty > 0 ? Math.floor(l.qty) : 1,
      sortOrder: i,
    }))
    .filter((l) => l.partNumber || l.name)
    .slice(0, 200);

  await db.delete(partKitLines).where(eq(partKitLines.kitId, kitId));
  if (usable.length) {
    await db.insert(partKitLines).values(usable.map((l) => ({ ...l, kitId })));
  }
  await audit({
    actor: u.email, entityType: "part_catalog", entityId: kitId, tenantOrgId: kit.tenantOrgId,
    action: `set ${kit.partNumber} contents: ${usable.length} line${usable.length === 1 ? "" : "s"}`,
  });
  revalidatePath("/settings/parts");
  return {};
}

// ---------------- Service agreements ----------------
// The contract and what it entitles somebody to. What has been DRAWN DOWN is
// never written here - it is summed from the work in lib/agreementUsage - so
// the answer is always what the ledger actually says rather than a second copy
// of it that is free to disagree. See lib/agreements.

export type AgreementInput = {
  kind: string; number: string; title: string; status: string;
  startsOn: string; endsOn: string; renewNoticeDays: number | string;
  visitsIncluded: number | string; partsAllowance: string; laborIncludedHours: string;
  visitsUnlimited?: boolean; partsUnlimited?: boolean; pmPartsIncluded?: boolean;
  includedKits?: IncludedKit[];
  hourlyRate?: string;
  instrumentIds?: number[];
  value: string; note: string;
};

function cleanAgreement(d: AgreementInput): { error: string } | {
  kind: string; number: string; title: string; status: string;
  startsOn: string; endsOn: string; renewNoticeDays: number;
  visitsIncluded: number; partsAllowanceCents: number; laborIncludedMinutes: number;
  visitsUnlimited: boolean; partsUnlimited: boolean; pmPartsIncluded: boolean;
  includedKits: string;
  hourlyRateCents: number | null; instrumentIds: number[];
  valueCents: number | null; note: string;
} {
  const kind = (AGREEMENT_KINDS as readonly string[]).includes(d.kind) ? d.kind : "contract";
  const status = (AGREEMENT_STATES as readonly string[]).includes(d.status) ? d.status : "active";
  const startsOn = d.startsOn.trim();
  const endsOn = d.endsOn.trim();
  if (startsOn && !isIsoDay(startsOn)) return { error: "Start date should look like 2026-01-01" };
  if (endsOn && !isIsoDay(endsOn)) return { error: "End date should look like 2026-12-31" };
  // Caught here rather than left to produce an agreement that is expired the
  // day it is written and reads as somebody else's mistake later.
  if (startsOn && endsOn && endsOn < startsOn) return { error: "It can't end before it starts" };
  const whole = (v: number | string, max: number) => {
    const n = typeof v === "number" ? v : parseInt(v.trim() || "0", 10);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : 0;
  };
  return {
    kind, status,
    number: d.number.trim().slice(0, 60),
    title: d.title.trim().slice(0, 160),
    startsOn, endsOn,
    renewNoticeDays: whole(d.renewNoticeDays, 3650),
    // Unlimited beats a cap: the number is zeroed so nothing reads it as one.
    visitsIncluded: d.visitsUnlimited ? 0 : whole(d.visitsIncluded, 10_000),
    // parseMoney returns null for "not money-shaped"; an allowance nobody typed
    // is 0, which lib/agreements reads as "not part of this agreement".
    partsAllowanceCents: d.partsUnlimited ? 0 : parseMoney(d.partsAllowance) ?? 0,
    laborIncludedMinutes: Math.round((parseFloat(d.laborIncludedHours.trim()) || 0) * 60),
    visitsUnlimited: d.visitsUnlimited ?? false,
    partsUnlimited: d.partsUnlimited ?? false,
    pmPartsIncluded: d.pmPartsIncluded ?? false,
    includedKits: serializeKits(d.includedKits ?? []),
    hourlyRateCents: parseMoney(d.hourlyRate ?? ""),
    // Which of the client's systems this paper covers; [] = all of them.
    // Ownership is validated by usage-time scoping, not here - a system that
    // changes hands stops counting by itself.
    instrumentIds: [...new Set((d.instrumentIds ?? []).filter((n) => Number.isInteger(n)))],
    valueCents: parseMoney(d.value),
    note: d.note.trim().slice(0, 2000),
  };
}

const agreementName = (a: { kind: string; number: string; title: string }) =>
  [a.number, a.title].filter(Boolean).join(" ") || AGREEMENT_KIND_LABEL[a.kind] || "agreement";

export async function addAgreement(orgId: number, data: AgreementInput): Promise<{ error?: string; id?: number }> {
  const u = await requireStaff();
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };
  // Staff of the operator the organization belongs to, and nobody else's. A
  // contract is the commercial relationship; another operator has no business
  // writing one against this client.
  if (!mayAdminOrg(tenantViewer(u), org)) return { error: "Not found" };
  const clean = cleanAgreement(data);
  if ("error" in clean) return clean;
  const [row] = await db.insert(agreements).values({
    ...clean, orgId, tenantOrgId: orgTenant(org) ?? myTenantOrgId(u), createdBy: u.email,
  }).returning();
  await audit({
    actor: u.email, entityType: "agreement", entityId: row.id, tenantOrgId: row.tenantOrgId,
    action: `added ${(AGREEMENT_KIND_LABEL[clean.kind] ?? "agreement").toLowerCase()} ${agreementName(clean)} for ${org.name}`
      + `${clean.endsOn ? ` (to ${clean.endsOn})` : ""}`,
  });
  revalidatePath(`/settings/organizations/${orgId}`);
  revalidatePath("/agreements");
  return { id: row.id };
}

export async function updateAgreement(id: number, data: AgreementInput): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [before] = await db.select().from(agreements).where(eq(agreements.id, id));
  if (!before) return { error: "Not found" };
  const [org] = await db.select().from(orgs).where(eq(orgs.id, before.orgId));
  if (!org || !mayAdminOrg(tenantViewer(u), org)) return { error: "Not found" };
  const clean = cleanAgreement(data);
  if ("error" in clean) return clean;
  await db.update(agreements).set(clean).where(eq(agreements.id, id));
  await audit({
    actor: u.email, entityType: "agreement", entityId: id, tenantOrgId: before.tenantOrgId,
    action: `edited ${agreementName(clean)} for ${org.name}`,
    field: "agreement",
    oldValue: `${before.status} | ${before.startsOn}-${before.endsOn} | ${before.partsAllowanceCents}`,
    newValue: `${clean.status} | ${clean.startsOn}-${clean.endsOn} | ${clean.partsAllowanceCents}`,
  });
  revalidatePath(`/settings/organizations/${before.orgId}`);
  revalidatePath("/agreements");
  return {};
}

/**
 * Remove an agreement. Deliberately a real delete rather than an archive,
 * because "cancelled" is already a status and a piece of paper entered in error
 * should leave no trace - unlike a cancelled contract, which is history.
 * Documents filed against it go with it (the attachment cascade).
 */
export async function removeAgreement(id: number, reason: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [row] = await db.select().from(agreements).where(eq(agreements.id, id));
  if (!row) return {};
  const [org] = await db.select().from(orgs).where(eq(orgs.id, row.orgId));
  if (!org || !mayAdminOrg(tenantViewer(u), org)) return { error: "Not found" };
  await db.delete(agreements).where(eq(agreements.id, id));
  await audit({
    actor: u.email, entityType: "agreement", entityId: id, tenantOrgId: row.tenantOrgId,
    action: `removed ${agreementName(row)} from ${org.name} - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revalidatePath(`/settings/organizations/${row.orgId}`);
  revalidatePath("/agreements");
  return {};
}

// ---------------- Buying for a job ----------------
// A PO could only ever be raised against a stockroom, so "why did we buy this"
// was unrecorded. Pointing one at a work order is what makes a client's parts
// allowance defensible: every dollar drawn down has a receipt behind it.

/**
 * File an order against the job it was bought for, or unfile it.
 *
 * Both records have to be reachable by this person - the order through the room
 * it draws on, the job through the system it is on - because linking them makes
 * each visible from the other.
 */
export async function setPoWorkOrder(poId: number, workOrderId: number | null): Promise<{ error?: string }> {
  const u = await requireEditor();
  const { po, manage, see } = await poAccess(u, poId);
  if (!po) return { error: "Not found" };
  if (!manage) return { error: see ? "You can't change this order" : "Not found" };

  if (workOrderId === null) {
    await db.update(purchaseOrders).set({ workOrderId: null }).where(eq(purchaseOrders.id, poId));
    await audit({
      actor: u.email, entityType: "po", entityId: poId, tenantOrgId: po.tenantOrgId,
      action: `${po.number} is no longer against a work order - it is stock`,
    });
    revPo(poId);
    return {};
  }

  const found = await loadWorkOrder(u, workOrderId);
  if ("error" in found) return found;
  const { wo } = found;
  if (!woAcceptsWork(wo.state)) return { error: `${wo.number} is ${WO_LABEL[wo.state].toLowerCase()}.` };
  await db.update(purchaseOrders).set({ workOrderId: wo.id }).where(eq(purchaseOrders.id, poId));
  await audit({
    actor: u.email, instrumentId: wo.instrumentId, assetId: wo.assetId,
    entityType: "po", entityId: poId, tenantOrgId: po.tenantOrgId,
    action: `${po.number} is against ${wo.number} - ${wo.title}`,
  });
  revPo(poId);
  revWo(wo);
  return {};
}
