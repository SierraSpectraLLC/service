"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { eq, and, asc, desc, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { redirect } from "next/navigation";
import {
  instruments, instrumentGases, tasks, checklistItems, itemNotes, taskNotes, parts, attachments,
  sheetDiffs, appSettings, eodUpdates, clientAllowlist, users, sessions, stageDefs,
  stageEvents, discussionPosts, assets, serviceVisits, assetEvents, discussionReads, vocabTerms, systemShares, orgs, timeEntries, trailEvents,
  engagementRecords, accessRequests, assetShares, pmSchedules, procedures, signoffs, partPrices,
  notifications, notificationPrefs, stockrooms, stockroomShares, stockItems, stockMoves,
  purchaseOrders, poLines, custodyEvents, queueEvents, houseMembers, uiLayouts, remoteDevices,
  workOrders, workOrderNotes, orgSites, partCatalog, partKitLines, partNumbers, partPhotos, agreements,
  catalogRefs, taskResults, folders, dropLinks, shareLinks, shareLinkFiles,
  validationDocs, validationSignatures, messageThreads, threadMembers, messages,
  driveCache, expenses, expenseReports, expenseCategories, invoices, invoiceLines, payments, invoiceFees, promises, disputes,
  dunningEvents, creditOverrides, quotes, quoteLines, payroll,
} from "@/db/schema";
import { siteLabel } from "@/lib/sites";
import {
  allNumbers, catalogEntry, catalogName, cleanAliases, currentNumber, MAX_PART_PHOTOS,
  numberClash, PART_KINDS, PART_KIND_LABEL, type PartAlias,
} from "@/lib/partCatalog";
import { checkRows, type PartImportRow, type RowProblem } from "@/lib/partImport";
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
import { completionBlocked, evaluateResult, needsResult, parseAcceptance, resultIsRecorded, serializeAcceptance, type Acceptance } from "@/lib/testResult";
import { TIME_CATEGORIES } from "@/lib/rates";
import { sellPrice, EXPENSE_KINDS, LINE_KINDS, linesTotal } from "@/lib/billing";
import {
  INVOICE_OUTCOMES, QUOTE_OUTCOMES, invoiceProblem, openingStatus, quoteProblem,
} from "@/lib/backfill";
import {
  asStatementRow, billingContext, creditFor, depositOffsetsFor, draftSourceFor, dueFor, invoiceById, invoiceForOrg,
  invoicesForOrg, quoteForOrg,
} from "@/lib/invoiceData";
import {
  addMonths, billCadenceLabel, dueCycles, openingCursor, recurring,
} from "@/lib/recurring";
import { editableReport, reimbursementPool, reportTotalCents } from "@/lib/expenseReports";
import { invoiceView, isOpen, METHOD_LABEL, PAYMENT_METHODS } from "@/lib/statement";
import { feeFor, isReferred, nextAction, promiseBroken } from "@/lib/dunning";
import { answerable, depositCents, quoteStanding } from "@/lib/quotes";
import { feeClause, resolvePolicy } from "@/lib/billingPolicy";
import { linkState } from "@/lib/dropShare";
import type { BillingPolicy } from "@/lib/billingPolicy";
import { depositToClear, holdRefusal, type HeldAction } from "@/lib/credit";
import { brandForTenant } from "@/lib/brand";
import { btn, EMAIL, emailShell, esc } from "@/lib/emailTheme";
import { mailHost, threadHeaders, threadRootId } from "@/lib/emailThread";
import { appUrl } from "@/lib/appUrl";
import { payAmount, stripeConfigured, stripeMode } from "@/lib/stripe";
import { accountReady, checkoutSession, createConnectAccount, onboardingLink } from "@/lib/stripeApi";
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
import { storeFiles, storeQuota, storeTenantFor, storeUsedBytes } from "@/lib/storeUsage";
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
import { DEFAULT_STOPS, clampHeight, serializeStops, type Stop } from "@/lib/appearance";
import { serializeDigestDays } from "@/lib/digestDays";
import { digestRecipientList, sendDigestEdition } from "@/lib/digest";
import { pushValueToSheet, fetchTrackerRows, appendInstrumentToSheet } from "@/lib/sheetSync";
import {
  GASES, GAS_STATES, ATTACH_KINDS, MODULE_KINDS, ASSET_STATES, BLOCKED_STAGE,
  autoFg, cleanBlockReason, isBlocking, partOpen, stageChange, validBlockReason,
} from "@/lib/stages";
import { systemParties, systemPartiesFor } from "@/lib/partyData";
import { VIEW_LABEL, isViewPref, viewAllowed, type ViewMode } from "@/lib/viewMode";
import { gasesForSystemWithUnits, gasesForUnit, missingGases } from "@/lib/catalogGas";
import { shopToday, shopTodayMDY } from "@/lib/shopday";
import { composeEodEmail, isOffSystem } from "@/lib/eodEmail";
import { resolveExpensePolicy } from "@/lib/expensePolicy";
import { categoryKey, cleanCategoryName, missingStarters } from "@/lib/expenseCategories";
import { drivingRoute, geocode } from "@/lib/geo";
import { getBrand } from "@/lib/brand";
import { parseSpecs, serializeSpecs } from "@/lib/partSpecs";
import { parseMoney, centsToInput, formatCents } from "@/lib/money";
import { bestPrice, normalizePn } from "@/lib/priceBook";
import { NOTIFY_KINDS, isNotifyKind, mayReceiveKind } from "@/lib/inbox";
import { KIND_LABEL, STOCK_KINDS, canIssue, stockAccess } from "@/lib/stock";
import { PO_LABEL, nextPoNumber, poEditable, poReceivable, poTotals, statusAfterReceipt } from "@/lib/po";
import { canKick } from "@/lib/queue";
import { assetDupeKey, duplicateIds, importPlanner } from "@/lib/assetDupe";
import { houseEmails, houseMemberRows } from "@/lib/house";
import { pmHandoff } from "@/lib/pmQueue";
import { isPmPosture } from "@/lib/pmPosture";
import { canDeleteNote, canEditNote, isAuthor } from "@/lib/notes";
import { readersOf } from "@/lib/mentionAudience";
import { clearPasswordFor, setPasswordFor } from "@/lib/passwordAuth";
import { makeTempPassword, tempExpiry, TEMP_DAYS_DEFAULT } from "@/lib/tempPassword";
import { isPanelMode, type PanelMode } from "@/lib/panelMode";
import {
  maySeePayroll, mayEditPayroll, visibleRows, type PayRow, type PayrollViewer,
} from "@/lib/payroll";
import { normalizePhone } from "@/lib/sms";
import { isPlatformStaff, isStaffRole, mayAdminOrg, mayCreateOrgs } from "@/lib/tenants";
import { personaCookie } from "@/lib/viewAs";
import { signInIdentity } from "@/auth";
import { maySeeTrail } from "@/lib/trail";
import { pruneTrail, recordTrail } from "@/lib/trailData";
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
import { replyToAddress, reportFrom, sendEmail } from "@/lib/email";

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

/**
 * The target of a job that has no record behind it: the client it is for, and
 * the workspace it belongs to.
 *
 * `null` is a real answer - the shop's own job, on nothing of anybody's - and
 * staff only, because "no client" from a client's login is a job filed into
 * somebody else's shop. A named client must be one this person can see AND
 * one inside their own workspace: visibleOrgs shows every operator in the
 * directory, which is how cross-company work gets named, but it is not a list
 * of people you may open jobs against.
 */
async function resolveClientJobTarget(
  u: SessionUser, orgId: number | null,
): Promise<{ error: string } | {
  instrumentId: null; assetId: null; externalId: string;
  asset: null; workOrderId: null; settledWo: null; tenantOrgId: number | null;
}> {
  const empty = {
    instrumentId: null as null, assetId: null as null, externalId: "",
    asset: null as null, workOrderId: null as null, settledWo: null as null,
  };
  if (orgId === null) {
    if (!isStaffRole(u.role)) return { error: "Pick the client this job is for" };
    return { ...empty, tenantOrgId: myTenantOrgId(u) };
  }
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };
  if (!isStaffRole(u.role)) {
    // A client may raise their own job and nobody else's.
    if (u.orgId !== orgId) return { error: "Not found" };
    return { ...empty, tenantOrgId: await tenantOfOrg(orgId) };
  }
  const t = myTenantOrgId(u);
  const theirs = org.isOperator ? org.id : org.parentOrgId;
  if (t !== null && theirs !== t) return { error: "Not found" };
  return { ...empty, tenantOrgId: t };
}

/**
 * May this person write onto a job that has no record behind it - a client
 * job? The order answers for itself: house staff of the workspace that owns
 * it, or somebody at the client it was opened for. Everybody else is told
 * "Not found", which is what they would hear about a system they cannot see.
 */
async function canWriteClientJob(
  u: SessionUser, wo: { tenantOrgId: number | null; orgId: number | null },
): Promise<boolean> {
  if (isStaffRole(u.role)) {
    const t = readTenant(u);
    return t === null || wo.tenantOrgId === t;
  }
  return u.orgId !== null && wo.orgId === u.orgId;
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
  // A job can belong to a CLIENT rather than to a box on the bench: a move, a
  // site survey, a phone call that arrives before anybody knows which
  // instrument it is about. Work filed onto one of those carries the order and
  // nothing else, so the order is what access is decided against - there is no
  // record to ask. Without an order in hand, a target of nothing is still
  // nothing.
  const clientJob = t.instrumentId === null && !asset;
  if (clientJob && !t.workOrderId) return { error: "Not found" };

  // A work order tag is only valid if the order is on THIS record and still
  // taking work. Both halves matter: the first stops an id from another client's
  // job being posted from a hand-edited form, the second stops today's hours
  // landing on a job that closed in March.
  let workOrderId: number | null = null;
  let settledWo: { number: string; state: string; closedAt: Date | null } | null = null;
  if (t.workOrderId) {
    const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, t.workOrderId));
    if (!wo) return { error: "Not found" };
    const onThis = clientJob
      ? wo.instrumentId === null && wo.assetId === null
      : t.instrumentId !== null
        ? wo.instrumentId === t.instrumentId
        : wo.assetId === (asset?.id ?? null);
    if (!onThis) return { error: "That work order is not on this record" };
    if (clientJob) {
      if (!(await canWriteClientJob(u, wo))) return { error: "Not found" };
      // The workspace is the ORDER's, for the same reason a record's is: one
      // job's rows must not scatter across two workspaces.
      tenantOrgId = wo.tenantOrgId;
    }
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

/**
 * Add or remove a stage. `reason` is required for exactly one move: blocking.
 *
 * Enforced HERE rather than only in the panel that asks for it, because the
 * rule is about the record, not about a form - and `needsReason` comes back so
 * a caller that forgot can ask rather than showing a validation error for
 * something the person was never given a box to fill in.
 */
export async function toggleStage(
  instrumentId: number, stage: string, reason = "", blockedOrgId: number | null = null,
): Promise<{ error?: string; needsReason?: boolean }> {
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
  // Blocking is the one move that owes an explanation. Unblocking clears it,
  // so the field never outlives the state it describes.
  const blocking = isBlocking(inst.stages, stage);
  const why = cleanBlockReason(reason);
  if (blocking && !validBlockReason(why)) {
    return { error: "Say why it's blocked and what would clear it", needsReason: true };
  }
  /* Whose block it is, chosen rather than inferred. Defaulting to the
     blocker's own organization is the rule stated plainly: if we are working
     on a system and block it, it is blocked with us - and it stays with us
     when the reason says "waiting on LabZen", because the machine is on our
     bench and the chase is ours. See lib/blocks. */
  let heldBy: number | null = null;
  if (blocking) {
    const parties = await systemParties(inst, u.orgId);
    // "Us" means something different depending on who is asking: for the shop
    // it is the workspace the system lives in, for a client editor working
    // their own machine it is their own company. Both are always in `parties`
    // - the tenant by construction, a client because only a share got them
    // the right to block it at all.
    const mine = isStaffRole(u.role) ? inst.tenantOrgId : u.orgId;
    heldBy = blockedOrgId ?? mine;
    if (heldBy !== null && !parties.some((p) => p.id === heldBy)) {
      return { error: "That organization has nothing to do with this system" };
    }
  }
  const blockFields = blocking
    ? { blockedReason: why, blockedSince: new Date(), blockedBy: u.email, blockedOrgId: heldBy }
    : stage === BLOCKED_STAGE && has
      ? { blockedReason: "", blockedSince: null, blockedBy: "", blockedOrgId: null }
      : {};
  await db.update(instruments).set({ stages: next, updatedAt: new Date(), ...blockFields })
    .where(eq(instruments.id, instrumentId));
  await db.insert(stageEvents).values({ instrumentId, stage, kind: has ? "removed" : "added" });
  await audit({
    actor: u.email, instrumentId, entityType: "instrument", entityId: inst.externalId,
    action: `${has ? "removed" : "added"} stage: ${stage}${blocking ? ` - ${why}` : ""}`, field: "stages",
    oldValue: inst.stages.join(", "), newValue: next.join(", "),
  });
  rev(instrumentId);
  return {};
}

/**
 * Rewrite why a system is blocked without unblocking it - the reason changes
 * as the wait does ("waiting on the quote" becomes "quote approved, waiting on
 * the part"), and making somebody unblock and re-block to say so would lose
 * the date it has been stuck since.
 */
export async function setBlockedReason(
  instrumentId: number, reason: string, blockedOrgId: number | null = null,
): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  await assertSystemEditable(u, instrumentId);
  if (!inst.stages.includes(BLOCKED_STAGE)) return { error: "That system isn't blocked" };
  const why = cleanBlockReason(reason);
  if (!validBlockReason(why)) return { error: "Say why it's blocked and what would clear it" };
  /* The holder is re-pointable for the same reason the reason is re-wordable:
     a wait that started on our bench can genuinely become theirs when the unit
     goes back to them, and making somebody unblock and re-block to say so
     would lose the date it has been stuck since. Null leaves it where it is -
     the caller is only rewording. */
  let heldBy: number | null | undefined = undefined;
  if (blockedOrgId !== null) {
    const parties = await systemParties(inst, u.orgId);
    if (!parties.some((p) => p.id === blockedOrgId)) {
      return { error: "That organization has nothing to do with this system" };
    }
    heldBy = blockedOrgId;
  }
  await db.update(instruments).set({
    blockedReason: why, blockedBy: u.email,
    ...(heldBy === undefined ? {} : { blockedOrgId: heldBy }),
    // Keep blockedSince: it is how long the system has been stuck, which
    // rewording the reason does not reset. Backfill it only if it is missing,
    // which is every row blocked before a reason was demanded.
    ...(inst.blockedSince ? {} : { blockedSince: new Date() }),
    updatedAt: new Date(),
  }).where(eq(instruments.id, instrumentId));
  await audit({
    actor: u.email, instrumentId, entityType: "instrument", entityId: inst.externalId,
    action: `blocked reason: ${why}`, field: "blockedReason",
    oldValue: inst.blockedReason, newValue: why,
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
    // Created by staff: share it with THEIR service organization, so its
    // engineers - who sign in as that org, not as platform staff - can work
    // the system. app_settings.operator_org_id is the company that runs the
    // INSTANCE, which stops being the right answer the moment a second
    // operator creates a system: theirs would be shared with the landlord.
    const mine = myTenantOrgId(u);
    if (mine != null) {
      await db.insert(systemShares)
        .values({ instrumentId: row.id, orgId: mine, access: "edit", addedBy: u.email })
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
      tenantOrgId: myTenantOrgId(u),
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
  const u = await requireEditor();
  const usable = rows.filter((r) => r.kind.trim() && (r.model.trim() || r.serial.trim()));
  if (!usable.length) return { error: "Nothing to save - each row needs a type and either a model or a serial" };
  if (usable.length > 200) return { error: "Save 200 rows at a time" };
  // A serial is one physical unit, so a serial already on file is a mistake -
  // reported per row rather than silently skipped, because this is deliberate
  // entry and the person needs to know their paste overlapped. Serial-LESS rows
  // are left alone: three identical seal-less pumps are three real pumps.
  // This workspace's serials. Unscoped, "already on file as a Turbo HiPace 80"
  // answered a question about another operator's shelf - paste a serial, learn
  // whether they have it and what it is.
  const taken = new Map((await db.select({ serial: assets.serial, kind: assets.kind, model: assets.model })
    .from(assets).where(forTenant(assets.tenantOrgId, readTenant(u)))).filter((a) => a.serial.trim())
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
      tenantOrgId: myTenantOrgId(u),
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
  // Taking a unit out of service is house work, and the house is the RECORD's
  // workspace. requireStaff() admits every operator's people.
  if (!houseOf(u, a.tenantOrgId)) return;
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
  // Same words a missing row gets: this is a hard delete and the id came from
  // the caller, so whose it is has to be settled before anything cascades.
  if (!houseOf(u, a.tenantOrgId)) return {};
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
  // Scoped at the fetch, so the loop below can only ever see this workspace.
  // Asset ids are one sequence across the instance, so unscoped this walked
  // another operator's inventory 200 rows at a time - rows deleted, events
  // cascaded, tags nulled on their systems. Ids that fall out are reported
  // rather than silently skipped, by the failures pass just below.
  const rows = await db.select().from(assets)
    .where(and(inArray(assets.id, ids), forTenant(assets.tenantOrgId, readTenant(u))));
  const failures: { id: number; error: string }[] = [];
  // An id the fetch did not return is gone or is not this workspace's, and the
  // caller is told the same thing either way. Reported rather than dropped: a
  // batch that silently deletes fewer rows than it was given is how somebody
  // concludes the job is done.
  const found = new Set(rows.map((r) => r.id));
  for (const id of ids) if (!found.has(id)) failures.push({ id, error: "Not found" });
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
  data: {
    title: string; body: string; assignee: string; dueDate?: string; resultType?: string;
    /**
     * Start from this catalog procedure: its checklist is stamped on, and its
     * test spec (pass/fail, target, tolerance) rides along via the id - the
     * same way intake and PM tasks carry theirs. Title/body still come from
     * the form, pre-filled client-side, so the engineer can sharpen the ask.
     */
    procedureId?: number | null;
  },
): Promise<{ error?: string }> {
  const u = await requireEditor();
  if (!data.title.trim()) return { error: "Title required" };
  // What "done" means: '' = tick it, otherwise an outcome must be recorded
  // (lib/testResult). Unknown strings are refused rather than stored - a typo
  // here would gate the task on a result nobody can enter.
  const resultType = (data.resultType ?? "").trim();
  if (!["", "pass_fail", "measured", "note"].includes(resultType)) return { error: "Not a result type" };
  const t0 = await resolveTarget(target);
  if ("error" in t0) return t0;
  // Only a procedure this workspace can see - a stale id from another tenant's
  // catalog must not put their checklist on our job.
  const [proc] = data.procedureId
    ? await db.select().from(procedures).where(and(
        eq(procedures.id, data.procedureId), forTenant(procedures.tenantOrgId, readTenant(u))))
    : [];
  if (data.procedureId && !proc) return { error: "That procedure isn't in the catalog" };
  const [t] = await db.insert(tasks).values({
    tenantOrgId: t0.tenantOrgId,
    instrumentId: t0.instrumentId, assetId: t0.assetId,
    title: data.title.trim(), body: data.body.trim(), assignee: data.assignee.trim(),
    dueDate: (data.dueDate ?? "").trim(),
    resultType,
    procedureId: proc?.id ?? null,
    workOrderId: t0.workOrderId,
  }).returning();
  if (proc) await stampChecklist(t.id, proc.checklist);
  await audit({
    actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId, entityType: "task", entityId: t.id,
    action: `created task '${t.title}'${proc ? ` from procedure '${proc.name}'` : ""}${t0.asset ? ` [${assetLabel(t0.asset)}]` : ""}${t.assignee ? ` (assigned ${t.assignee})` : ""}${t.dueDate ? ` due ${t.dueDate}` : ""}`,
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
async function testSpecFor(t: { procedureId: number | null; resultType?: string }) {
  if (t.procedureId !== null) {
    const [p] = await db.select({
      kind: procedures.kind, resultType: procedures.resultType,
      target: procedures.target, tolerancePct: procedures.tolerancePct,
      acceptance: procedures.acceptance,
    }).from(procedures).where(eq(procedures.id, t.procedureId));
    if (p && needsResult(p.kind, p.resultType)) return p;
  }
  // A hand-made task demanding an outcome (tasks.result_type). kind "test"
  // because that is the word the gate understands; no target, no band.
  if (t.resultType) return { kind: "test", resultType: t.resultType, target: null, tolerancePct: null, acceptance: "" };
  return null;
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
    acceptance: spec.acceptance ?? "",
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
      // The appointment is spent: the visit happened (or the work did, which
      // is better). The next cycle books itself fresh if the client asks.
      await db.update(pmSchedules).set({ lastDone: today, nextDue, bookedOn: "", bookedNote: "" })
        .where(eq(pmSchedules.id, s.id));
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
  data: { assignee: string; everyDays: number | string; nextDue: string; lastDone?: string },
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
  // "We know when it was last done" is a fact worth holding on its own - the
  // date off a sticker on the panel, or the seller's word at intake. Unlike
  // logPastPm it files nothing: a known date is not a record of who did what.
  // Blank leaves the stored value alone rather than erasing it.
  const lastDone = (data.lastDone ?? "").trim();
  if (lastDone && !isIsoDay(lastDone)) return { error: "Pick a real last-done date" };
  const lastChanged = !!lastDone && lastDone !== s.lastDone;
  if (s.everyDays === cadence.days && s.nextDue === nextDue && s.assignee === assignee && !lastChanged) return {};
  await db.update(pmSchedules).set({
    everyDays: cadence.days, nextDue, assignee,
    ...(lastChanged ? { lastDone } : {}),
  }).where(eq(pmSchedules.id, id));
  await audit({
    actor: u.email, instrumentId: s.instrumentId, assetId: s.assetId, entityType: "pm", entityId: id,
    action: `rescheduled maintenance '${s.title}': ${cadenceLabel(cadence.days)}, next due ${nextDue}${lastChanged ? `, last done ${lastDone}` : ""}${assignee !== s.assignee ? `, assigned ${assignee || "nobody"}` : ""}`,
    field: "nextDue", oldValue: `${s.nextDue} (${cadenceLabel(s.everyDays)})`, newValue: `${nextDue} (${cadenceLabel(cadence.days)})`,
  });
  await generateDuePmTasks(shopToday(), u.email);
  revWork(s);
  return {};
}

/**
 * Scheduled or advisory maintenance for one system, toggled any time.
 *
 * '' hands the answer back to the owning org's default (lib/pmPosture) rather
 * than being a third posture, so "clear the override" survives the system
 * being sold to a different kind of company. Existing open tasks stay - they
 * are real work somebody may be mid-way through; the toggle governs what the
 * generator does from now on.
 */
export async function setPmPosture(instrumentId: number, posture: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  if (!isPmPosture(posture)) return { error: "Not a maintenance posture" };
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  if (!houseOf(u, inst.tenantOrgId)) return { error: "Not yours to change" };
  if (inst.pmPosture === posture) return {};
  await db.update(instruments).set({ pmPosture: posture }).where(eq(instruments.id, instrumentId));
  await audit({
    actor: u.email, instrumentId, entityType: "instrument", entityId: instrumentId,
    action: posture === ""
      ? "maintenance posture follows the owner again"
      : `maintenance is ${posture === "advisory" ? "advisory now - schedules stay as reference, nothing comes due" : "on a schedule now - due work turns into tasks"}`,
    field: "pmPosture", oldValue: inst.pmPosture, newValue: posture,
  });
  // Flipping to scheduled makes anything already past its date due today.
  if (posture !== "advisory") await generateDuePmTasks(shopToday(), u.email);
  revalidatePath(`/instruments/${instrumentId}`);
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
/**
 * Book the visit for the day the client asked for.
 *
 * This is the answer to "maintenance is due but they want us on the 12th"
 * that does not involve lying to the calendar: nextDue stays where it fell,
 * the appointment is its own fact, and the nag goes quiet until the day -
 * lib/pm.pmStanding renders "booked 9/12" instead of "overdue". The task is
 * materialized now (or its date moved if it already exists), dated for the
 * appointment, so the dashboard's overdue count clears too and the engineer
 * sees the day they are actually expected.
 */
export async function schedulePmVisit(
  scheduleId: number, data: { date: string; note: string },
): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [sched] = await db.select().from(pmSchedules).where(eq(pmSchedules.id, scheduleId));
  if (!sched) return { error: "Not found" };
  const onSystem = sched.instrumentId ?? (sched.assetId === null
    ? null
    : (await db.select({ instrumentId: assets.instrumentId }).from(assets).where(eq(assets.id, sched.assetId)))[0]?.instrumentId ?? null);
  if (onSystem !== null) {
    try { await assertSystemEditable(u, onSystem); } catch { return { error: "Not found" }; }
  }
  const date = data.date.trim();
  if (!isIsoDay(date)) return { error: "Pick the day" };
  if (date < shopToday()) return { error: "That day has passed - book a real one, or log the work as done" };
  const note = data.note.trim().slice(0, 200);

  await db.update(pmSchedules).set({ bookedOn: date, bookedNote: note }).where(eq(pmSchedules.id, scheduleId));
  const [open] = await db.select().from(tasks)
    .where(and(eq(tasks.pmScheduleId, scheduleId), ne(tasks.state, "Done"))).limit(1);
  if (open) {
    await db.update(tasks).set({ dueDate: date }).where(eq(tasks.id, open.id));
  } else {
    await createPmTask(sched, onSystem, date,
      u.email, `booked '${sched.title}' for ${date}${note ? ` (${note})` : ""}`);
  }
  await audit({
    actor: u.email, instrumentId: sched.instrumentId, assetId: sched.assetId,
    entityType: "pm", entityId: scheduleId,
    action: `booked '${sched.title}' for ${date}${note ? ` - ${note}` : ""}`
      + (sched.nextDue < date ? ` (cycle fell due ${sched.nextDue})` : ""),
    field: "bookedOn", oldValue: sched.bookedOn, newValue: date,
  });
  if (sched.instrumentId !== null) rev(sched.instrumentId);
  else if (sched.assetId !== null) revalidatePath(`/assets/${sched.assetId}`);
  revalidatePath("/maintenance");
  return {};
}

/** Call the appointment off. The task and its nag go back to the cycle date. */
export async function unschedulePmVisit(scheduleId: number): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [sched] = await db.select().from(pmSchedules).where(eq(pmSchedules.id, scheduleId));
  if (!sched) return { error: "Not found" };
  if (!sched.bookedOn) return {};
  await db.update(pmSchedules).set({ bookedOn: "", bookedNote: "" }).where(eq(pmSchedules.id, scheduleId));
  const [open] = await db.select().from(tasks)
    .where(and(eq(tasks.pmScheduleId, scheduleId), ne(tasks.state, "Done"))).limit(1);
  if (open && open.dueDate === sched.bookedOn) {
    await db.update(tasks).set({ dueDate: sched.nextDue }).where(eq(tasks.id, open.id));
  }
  await audit({
    actor: u.email, instrumentId: sched.instrumentId, assetId: sched.assetId,
    entityType: "pm", entityId: scheduleId,
    action: `called off the ${sched.bookedOn} visit for '${sched.title}'`,
    field: "bookedOn", oldValue: sched.bookedOn, newValue: "",
  });
  if (sched.instrumentId !== null) rev(sched.instrumentId);
  else if (sched.assetId !== null) revalidatePath(`/assets/${sched.assetId}`);
  revalidatePath("/maintenance");
  return {};
}

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
  // The SCHEDULE's workspace, not the instance's. A price book read across the
  // tenant line lets another operator's vendor offer win bestPrice and land on
  // this shop's part row as its cost and its supplier.
  const book = await db.select().from(partPrices)
    .where(forTenant(partPrices.tenantOrgId, s.tenantOrgId));
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
  // lib/mentionAudience, so the dropdown a name is picked from and the list
  // this notifies are the same list. They used to be two, and the system half
  // forgot owners - a client could read a note on the instrument it owns and
  // never be mentionable on it.
  return [...(await readersOf(t))];
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

/**
 * A comment on the job itself - context above any one task. Editors only, but
 * that includes the client's own editors: "it worked over the weekend" is
 * exactly what the engineer needs to read before driving out.
 */
export async function addWorkOrderNote(workOrderId: number, text: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  const body = text.trim();
  if (!body) return {};
  const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, workOrderId));
  if (!wo) return { error: "Not found" };
  await assertWorkEditable(u, wo);
  await db.insert(workOrderNotes).values({ workOrderId, author: u.name, authorEmail: u.email.toLowerCase(), text: body });
  await audit({
    actor: u.email, instrumentId: wo.instrumentId, assetId: wo.assetId, entityType: "wo_note", entityId: workOrderId,
    action: `commented on ${wo.number}: "${body}"`,
  });
  await notifyMention({
    actorEmail: u.email, actorName: u.name, body,
    where: `${wo.number} '${wo.title}'`, href: `/work/${wo.id}`,
    allowedEmails: await taskMentionAudience(wo),
  });
  revalidatePath(`/work/${wo.id}`);
  return {};
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
  /** "Pump", "Autosampler"... - what this becomes on arrival. Blank = a part. */
  moduleKind?: string;
  vendor: string; po: string; cost: string;
  carrier: string; tracking: string; orderedAt: string; eta: string; status: string; note: string;
  /**
   * Who is fabricating it, on the made lane. Undefined leaves whatever is
   * stored alone; null is us. NEVER derived from requestedOrgId - who was
   * asked to buy a thing is not who is at the printer. See lib/stages.
   */
  makerOrgId?: number | null;
  // The day it actually went in or came out, YYYY-MM-DD. Blank leaves whatever
  // is stored alone rather than clearing it: a service date is a fact about the
  // machine, and an unrelated edit to the note must not quietly erase one.
  installedAt?: string; removedAt?: string;
  /** Recording a KIT: also write the parts it contains beneath it. */
  expandKit?: boolean;
  /**
   * The maintenance job this part belongs to. A PM's own parts are part of the
   * PM, so on a contract that says so they are reported but never drawn from
   * the parts allowance (lib/agreementUsage) - which only worked for parts the
   * schedule itself requested. A part fitted by hand during that same PM was
   * billed against the allowance, and this is what lets somebody say otherwise.
   */
  pmScheduleId?: number | null;
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
    kind: data.kind === "consumable" || data.kind === "kit" ? data.kind : "part",
    // Open vocabulary like the asset form's own kind field - trimmed, capped,
    // and only ever meaningful on a "part" row (a consumable is never a unit).
    moduleKind: data.kind === "part" ? (data.moduleKind ?? "").trim().slice(0, 40) : "",
    pmScheduleId: data.pmScheduleId ?? null,
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
  before: { status: string; receivedAt: string; madeAt?: string; installedAt: string; removedAt: string },
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

/**
 * The moment a purchase becomes a machine.
 *
 * The part row carried the whole request-and-order life: somebody said the
 * system needs a new pump, purchasing ordered it, the carrier tracked it,
 * Received landed it on the dock. What no amount of parts machinery could do
 * is put the UNIT on the system's asset list - that is a different kind of
 * record with its own serial, status and lifecycle. This is the bridge, and
 * it is one action so the two records can never half-exist: the asset is
 * born attached and In service, the part row closes as Installed and points
 * at the unit it became (so "where is the receipt for this pump" has an
 * answer), and the unit it replaces - the reason anybody ordered one - is
 * decommissioned in the same breath, with events on both sides saying why.
 */
export async function intakeModule(
  partId: number,
  data: AssetInput & { replacesAssetId?: number | null },
): Promise<{ error?: string; assetId?: number }> {
  const u = await requireEditor();
  const [part] = await db.select().from(parts).where(eq(parts.id, partId));
  if (!part) return { error: "Not found" };
  if (!part.moduleKind) return { error: "This line is a part, not a unit - nothing to intake" };
  if (part.assetId !== null) return { error: "Already intaken - the unit is on the asset list" };
  if (part.instrumentId === null) return { error: "No system to attach the unit to" };
  if (part.status !== "Received" && part.status !== "Installed") {
    return { error: "Intake happens when the box has arrived - mark it Received first" };
  }
  const created = await createAsset(part.instrumentId, data);
  if (created.error || !created.id) return { error: created.error ?? "Could not create the asset" };
  await logAssetEvent(created.id, "installed", part.instrumentId,
    `intaken from ${part.name}${part.po ? ` on ${part.po}` : ""}`, u.name);
  await db.update(parts).set({
    assetId: created.id, status: "Installed",
    installedAt: part.installedAt || shopToday(),
  }).where(eq(parts.id, partId));
  if (data.replacesAssetId != null) {
    const [old] = await db.select().from(assets).where(eq(assets.id, data.replacesAssetId));
    // Only a unit on the same system: a stale id from an open tab must not
    // decommission a machine across the shop.
    if (old && old.instrumentId === part.instrumentId && old.id !== created.id) {
      await setAssetStatus(old.id, "Decommissioned");
      await logAssetEvent(old.id, "removed", part.instrumentId,
        `replaced by the new ${data.kind.trim() || part.moduleKind}`, u.name);
    }
  }
  await audit({
    actor: u.email, instrumentId: part.instrumentId, entityType: "part", entityId: partId,
    action: `intook '${part.name}' as a ${part.moduleKind} on the asset list`,
  });
  rev(part.instrumentId);
  return { assetId: created.id };
}

/**
 * Who is making this part, checked against the parties that actually have a
 * hold on the machine it is for.
 *
 * `undefined` leaves the stored value alone - an edit to a note must not clear
 * an attribution nobody touched. `null` is us. Anything else has to be on the
 * same list the picker was built from (lib/partyData), so an id from a stale
 * tab, or a guess, cannot park a print job on a company with no connection to
 * the system.
 *
 * A part with no system behind it - a loose asset, a client's move job - has
 * no party list to check against, so the only answers there are us and the
 * asker's own organization. That is the whole truthful set in that case.
 */
async function resolveMaker(
  given: number | null | undefined,
  instrumentId: number | null,
  u: { orgId: number | null },
): Promise<{ makerOrgId: number | null } | { error: string }> {
  if (given === undefined) return { makerOrgId: null };
  if (given === null) return { makerOrgId: null };
  if (instrumentId === null) {
    return u.orgId !== null && given === u.orgId
      ? { makerOrgId: given }
      : { error: "That organization has nothing to do with this part" };
  }
  const parties = await systemPartiesFor(instrumentId, u.orgId);
  return parties.some((x) => x.id === given)
    ? { makerOrgId: given }
    : { error: "That organization has nothing to do with this part" };
}

const partStatusVerb = (status: string) =>
  status === "Installed" ? "installed" : status === "Removed" ? "pulled"
    : status === "Suggested" ? "suggested"
      : status === "Being made" ? "started making"
        : status === "Made" ? "finished making" : null;

export async function createPart(target: WorkTarget, raw: PartInput): Promise<{ error?: string; flag?: string; expanded?: number }> {
  const u = await requireEditor();
  const data = cleanPartInput(raw);
  if (!data.name.trim()) return { error: "Name required" };
  // Spread, not rebuild: from a work order's page the target carries the job,
  // and dropping it here is how a "potential part" would vanish from the job
  // that needs it (the same slip the task form had).
  const t0 = await resolveTarget({ ...target, assetId: raw.assetId ?? target.assetId ?? null });
  if ("error" in t0) return t0;
  const [payer, tenant] = await Promise.all([costOwnerOrg(t0), tenantOfWork(t0)]);
  // Staff of the tenant see prices; a partner from another workspace does not,
  // however senior they are at their own company.
  if (!canSeeCosts(u, payer, tenant)) { data.cost = ""; data.po = ""; }
  const stamps = partStamps({ status: "", receivedAt: "", madeAt: "", installedAt: "", removedAt: "" }, data.status,
    { installedAt: raw.installedAt, removedAt: raw.removedAt });
  const maker = await resolveMaker(raw.makerOrgId, t0.instrumentId, u);
  if ("error" in maker) return maker;
  const taggedAsset = t0.asset;
  // Only a schedule that actually belongs to this record - a stale id from an
  // open tab must not attribute somebody's part to another system's PM.
  const pmId = data.pmScheduleId ?? null;
  const pmOk = pmId === null ? null : (await db.select({ id: pmSchedules.id }).from(pmSchedules).where(and(
    eq(pmSchedules.id, pmId),
    t0.instrumentId !== null ? eq(pmSchedules.instrumentId, t0.instrumentId) : eq(pmSchedules.assetId, t0.assetId!),
  )))[0]?.id ?? null;
  const [p] = await db.insert(parts).values({
    ...data, ...stamps, ...maker, pmScheduleId: pmOk, assetId: t0.assetId, name: data.name.trim(), note: data.note.trim(), instrumentId: t0.instrumentId,
    workOrderId: t0.workOrderId,
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
  // A kit is a box of parts, and the box is not the record anybody needs a year
  // later - "when did we last change the plunger seals" is. So the contents go
  // in beneath it, at ZERO cost: the kit line holds the money, and charging
  // both would bill one box twice against an allowance. Same dates, same unit,
  // same status, so they read as one act of work.
  let expanded = 0;
  if (p.kind === "kit" && raw.expandKit !== false && p.partNumber.trim()) {
    const [kit] = await db.select({ id: partCatalog.id }).from(partCatalog).where(and(
      sql`lower(${partCatalog.partNumber}) = ${p.partNumber.trim().toLowerCase()}`,
      forTenant(partCatalog.tenantOrgId, t0.tenantOrgId),
    ));
    const lines = kit
      ? await db.select().from(partKitLines).where(eq(partKitLines.kitId, kit.id))
          .orderBy(asc(partKitLines.sortOrder), asc(partKitLines.id))
      : [];
    for (const l of lines) {
      await db.insert(parts).values({
        instrumentId: p.instrumentId, assetId: p.assetId,
        kind: "part", parentPartId: p.id,
        name: l.name || l.partNumber, partNumber: l.partNumber,
        qty: l.qty > 1 ? String(l.qty) : "",
        status: p.status, installedAt: p.installedAt, removedAt: p.removedAt,
        // The kit carries the cost. Not null - null means "nobody priced it",
        // and these are priced, at nothing, on purpose.
        costCents: 0, ownerOrgId: payer, pmScheduleId: p.pmScheduleId, workOrderId: p.workOrderId,
        note: `from ${p.name}`,
      });
      expanded++;
    }
    if (expanded) {
      await audit({
        actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId, entityType: "part", entityId: p.id,
        action: `recorded the ${expanded} part${expanded === 1 ? "" : "s"} inside '${p.name}'`,
      });
    }
  }
  revWork(p);
  // Same posture as the visit flag on a work order: warn about the allowance
  // at the moment of commitment, never refuse the record.
  // A suggestion is not a commitment: the allowance warning waits for the
  // moment somebody marks it Needed or beyond (see PART_STATES).
  const flag = p.status === "Suggested" ? ""
    : await partsFlag(payer, t0.instrumentId, p.costCents, p.pmScheduleId !== null).catch(() => "");
  return { flag: flag || undefined, expanded: expanded || undefined };
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
  // Same guard as on create: the schedule has to belong to the record this
  // part sits on. `undefined` from a caller that doesn't know about maintenance
  // leaves whatever is there alone.
  const pmNext = raw.pmScheduleId === undefined ? before.pmScheduleId
    : raw.pmScheduleId === null ? null
    : (await db.select({ id: pmSchedules.id }).from(pmSchedules).where(and(
        eq(pmSchedules.id, raw.pmScheduleId),
        before.instrumentId !== null ? eq(pmSchedules.instrumentId, before.instrumentId)
          : eq(pmSchedules.assetId, before.assetId!),
      )))[0]?.id ?? null;
  /* Undefined leaves the stored maker alone: a caller that knows nothing about
     fabrication - the intake dialog, an older form - must not clear an
     attribution by saving a note. */
  const maker = raw.makerOrgId === undefined
    ? {}
    : await resolveMaker(raw.makerOrgId, before.instrumentId, u);
  if ("error" in maker) return maker;
  await db.update(parts).set({
    ...data, ...stamps, ...maker, assetId, name: data.name.trim(), note: data.note.trim(),
    costCents: parseMoney(data.cost), pmScheduleId: pmNext,
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
  // A kit's contents came in with it and go out with it - left behind they
  // would read as loose parts somebody fitted, which is a worse record than
  // no record. No cascade in the column: the parent is a plain id, so the
  // sweep is here where the reason is written.
  const inside = p.kind === "kit"
    ? await db.select({ id: parts.id }).from(parts).where(eq(parts.parentPartId, partId))
    : [];
  if (inside.length) await db.delete(parts).where(eq(parts.parentPartId, partId));
  await db.delete(parts).where(eq(parts.id, partId));
  await audit({
    actor: u.email, instrumentId: p.instrumentId, assetId: p.assetId, entityType: "part", entityId: partId,
    action: `deleted part record '${p.name}'${inside.length ? ` and the ${inside.length} part${inside.length === 1 ? "" : "s"} inside it` : ""} - reason: ${why}`,
    field: "reason", newValue: why,
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
  const owner = await storeOwnerForTarget(t0);
  const guard = await guardStorage(owner, await storeTenantFor(owner, u), files.reduce((n, f) => n + (f.size || 0), 0));
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
  const owner = await storeOwnerForTarget(t0);
  const guard = await guardStorage(owner, await storeTenantFor(owner, u), files.reduce((n, f) => n + (f.size || 0), 0));
  if (guard) return guard;

  const rows = await db.insert(attachments).values(files.map((f) => ({
    tenantOrgId: t0.tenantOrgId,
    instrumentId: t0.instrumentId, assetId: t0.instrumentId === null ? t0.assetId : null,
    // The job, when shot from one - the before/after pictures belong to the
    // repair as much as to the system (the same tag tasks and parts carry).
    workOrderId: t0.workOrderId,
    fileName: f.fileName.slice(0, 200), kind: "Photo", url: f.url, size: f.size,
    uploadedBy: u.name, description: onSystem ? "System photo" : "Module photo",
  }))).returning();

  // Uploading a photo does not choose the cover, even the first one. The
  // catalog's stock picture of the model is a deliberate default - it is what
  // the equipment looks like - and a shot of a cable run or a serial plate
  // taken on the way past should not replace it because it happened to be
  // first. Somebody makes it the cover on purpose, or nobody does; a record
  // with no chosen cover keeps falling back to the stock photo (lib/photos
  // livingCover, and the pages' stockSrc behind it).
  const twin = await photoTwin(t0);
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
/**
 * Put the cover back to the default - the catalog's stock picture of the model.
 * The counterpart to choosing one: a cover is an override, and an override
 * nobody can undo is a decision, not a preference.
 */
export async function clearCoverPhoto(target: WorkTarget): Promise<{ error?: string }> {
  const u = await requireEditor();
  const t0 = await resolveTarget(target);
  if ("error" in t0) return t0;
  const me = photoRecord(t0);
  const twin = await photoTwin(t0);
  await setCoverRow(me.instrumentId !== null, me, null);
  if (twin) await setCoverRow(twin.instrumentId !== null, twin, null);
  await audit({
    actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId,
    entityType: "attachment", entityId: 0,
    action: "cleared the cover photo - back to the catalog's picture",
  });
  if (twin) revWork(twin);
  revWork({ instrumentId: t0.instrumentId, assetId: t0.assetId });
  return {};
}

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
async function folderStoreGate(
  u: Awaited<ReturnType<typeof requireEditor>>, orgId: number | null,
  // The row's own workspace, where the caller holds one. The org test below
  // cannot separate two house shelves - org_id is NULL on every workspace's -
  // so a caller that arrived with a row (revokeDropLink, the folder mutations)
  // passes its stamp and the answer stops being "is this person staff".
  rowTenant?: number | null,
) {
  if (orgId === null) {
    const mine = readTenant(u);
    if (rowTenant !== undefined && mine !== null && rowTenant !== mine) return { error: "Not found" };
    // The operator's own store. House staff only.
    return isStaffRole(u.role) ? {} : { error: "Not found" };
  }
  if (u.orgId === orgId) return {};
  if (!isStaffRole(u.role)) return { error: "Not found" };
  const gate = await adminOrgGate(u, orgId);
  return "error" in gate ? gate : {};
}

/**
 * Every folder in one store, for the rules in lib/folders to reason over.
 *
 * The tenant is load-bearing and not a belt-and-braces extra: EVERY workspace's
 * house shelf has org_id NULL, so `isNull(folders.orgId)` alone matches all of
 * them at once. A NULL is not a scope; the stamp is.
 */
async function storeFolders(orgId: number | null, tenant: number | null) {
  return db.select().from(folders)
    .where(and(
      orgId === null ? isNull(folders.orgId) : eq(folders.orgId, orgId),
      forTenant(folders.tenantOrgId, tenant),
    ))
    .catch(() => []);
}

/**
 * One folder by id, or undefined when it is gone OR belongs to another
 * workspace. The id arrives from a URL, so on its own it authorizes nothing -
 * and every caller below pairs it with folderStoreGate, which answers for the
 * store but cannot answer for the house shelf, where org_id is NULL on all of
 * them.
 */
async function folderById(u: SessionUser, id: number) {
  const [row] = await db.select().from(folders).where(eq(folders.id, id));
  if (!row) return undefined;
  const tenant = readTenant(u);
  if (tenant !== null && row.tenantOrgId !== tenant) return undefined;
  return row;
}

export async function createFolder(
  orgId: number | null, parentId: number | null, name: string,
): Promise<{ error?: string; id?: number }> {
  const u = await requireEditor();
  const gate = await folderStoreGate(u, orgId);
  if ("error" in gate) return gate;
  const clean = cleanFolderName(name);
  if ("error" in clean) return clean;
  const all = await storeFolders(orgId, readTenant(u));
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
  const row = await folderById(u, id);
  if (!row) return { error: "Not found" };
  const gate = await folderStoreGate(u, row.orgId);
  if ("error" in gate) return gate;
  const clean = cleanFolderName(name);
  if ("error" in clean) return clean;
  const all = await storeFolders(row.orgId, readTenant(u));
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
  const row = await folderById(u, id);
  if (!row) return { error: "Not found" };
  const gate = await folderStoreGate(u, row.orgId);
  if ("error" in gate) return gate;
  if (row.parentId === intoId) return {};
  const all = await storeFolders(row.orgId, readTenant(u));
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
  const row = await folderById(u, id);
  if (!row) return { error: "Not found" };
  const gate = await folderStoreGate(u, row.orgId);
  if ("error" in gate) return gate;
  const all = await storeFolders(row.orgId, readTenant(u));
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
    dest = await folderById(u, folderId);
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
    const all = await storeFolders(orgId, readTenant(u));
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
  // A link into a workspace's own shelf carries orgId NULL in EVERY workspace,
  // so the gate's org test matched all of them: this walked ids and revoked
  // other operators' links, killing uploads from technicians at air-gapped
  // instruments - and the audit line landed with a null tenant, so the company
  // it happened to got no trail naming anybody.
  const gate = await folderStoreGate(u, row.orgId, row.tenantOrgId);
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
  const guard = await guardStorage(u.orgId, await storeTenantFor(u.orgId, u), files.reduce((n, f) => n + (f.size || 0), 0));
  if (guard) return guard;
  // Dropped into an open folder, they belong in it. Checked rather than
  // trusted: the id comes from a URL, and a folder in somebody else's store
  // would file this person's upload somewhere they cannot see it.
  let dest: number | null = null;
  if (folderId !== null) {
    const f = await folderById(u, folderId);
    if (f && (f.orgId ?? null) === (u.orgId ?? null)) dest = f.id;
  }
  // Stamped with the same answer the READER resolves - storeTenantFor - or the
  // file lands in a store nobody can open. myTenantOrgId is u.operatorOrgId ??
  // u.rootOperatorOrgId, and a client carries no operator (auth.ts sets it from
  // the house_members row, which a client has none of), so a client of a second
  // operator had their uploads stamped with the ROOT operator while the shelf
  // they were filed on resolves to their own. The file uploaded, the audit line
  // was written, and the page came back empty.
  const stamp = await storeTenantFor(u.orgId, u);
  const rows = await db.insert(attachments)
    .values(files.map((f) => ({
      ...f, description: f.description.trim(), kind: "Report", tenantOrgId: stamp,
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
  /*
   * "One of yours" has to test the WORKSPACE as well as the organization,
   * because for staff u.orgId is null and so is the org on every house shelf
   * file - in every workspace. The org test alone therefore passed any other
   * operator's private shelf, and this function then copies that file's bytes
   * onto the caller's record. Platform staff (readTenant null) keep the reach
   * they have everywhere else.
   */
  if ((src.orgId ?? null) !== u.orgId) return { error: "Not found" };
  const myTenant = readTenant(u);
  if (myTenant !== null && src.tenantOrgId !== myTenant) return { error: "Not found" };
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
  const guard = await guardStorage(u.orgId, await storeTenantFor(u.orgId, u), files.reduce((n, f) => n + (f.size || 0), 0));
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
      // Staff carry orgId null, and so does every house shelf on the instance,
      // so the line above alone listed every operator's private library.
      forTenant(attachments.tenantOrgId, readTenant(u)),
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

async function guardStorage(
  orgId: number | null, tenant: number | null, addBytes: number,
): Promise<{ error: string } | undefined> {
  if (addBytes <= 0) return undefined;
  const q = await storeQuota(orgId, tenant);
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
/**
 * The three things an EOD line can be. A system or an asset is addressed by
 * what it is ABOUT; off-system work has nothing behind it, so it is addressed
 * by the row's own id - which is why every one of these actions takes a target
 * rather than a pair of foreign keys.
 */
export type EodTarget = { instrumentId: number | null; assetId: number | null; eodId?: number | null };

/**
 * Load an off-system row for writing, refusing one from another workspace.
 * Same posture as resolveTarget: the id in the payload buys nothing on its own.
 */
async function eodRowFor(actor: Awaited<ReturnType<typeof requireStaff>>, eodId: number) {
  const [row] = await db.select().from(eodUpdates).where(eq(eodUpdates.id, eodId));
  if (!row) throw new Error("Not found");
  const t = readTenant(actor);
  if (t !== null && row.tenantOrgId !== t) throw new Error("Not found");
  return row;
}

export async function saveEodUpdate(
  target: EodTarget,
  data: { systemUpdate: string; actionItem: string },
) {
  const u = await requireStaff();
  const date = shopToday();
  const systemUpdate = data.systemUpdate.trim();
  const actionItem = data.actionItem.trim();
  if (target.eodId != null) {
    await eodRowFor(u, target.eodId);
    await db.update(eodUpdates).set({ systemUpdate, actionItem, updatedBy: u.name, updatedAt: new Date() })
      .where(eq(eodUpdates.id, target.eodId));
    return;
  }
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
 * Log work that happened off the board.
 *
 * The gap this fills: every other EOD line hangs off a system or an asset,
 * so an engineer ringing up and being talked through a problem had nowhere to
 * be written down. It was real work, often for a named client, and it left no
 * trace - which meant it never reached their report and never reached ours.
 *
 * `orgId` is whose report it lands on, stamped now and never re-read, exactly
 * like every other line: who this was FOR does not change because the client
 * roster does later. Null is the operator's own group.
 */
export async function logOffSystemWork(
  orgId: number | null,
  data: { title: string; person: string; minutes: number; systemUpdate: string; actionItem: string },
): Promise<{ error?: string; id?: number }> {
  const u = await requireStaff();
  const title = data.title.trim().slice(0, 160);
  if (!title) return { error: "Say what the work was" };
  // The picker is a convenience; this is the rule. A name typed past the
  // dropdown is a person who does not exist, and it would sit on a client's
  // report looking exactly like one who does.
  const person = data.person.trim();
  if (person && !(await assignableNames(u)).has(person)) return { error: "Unknown person" };
  // Only a client this workspace actually runs, and never another tenant's.
  const tenant = readTenant(u);
  if (orgId !== null) {
    const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
    if (!org) return { error: "Not found" };
    if (tenant !== null && org.id !== tenant && org.parentOrgId !== tenant) return { error: "Not found" };
  }
  const [row] = await db.insert(eodUpdates).values({
    tenantOrgId: tenant,
    instrumentId: null, assetId: null,
    date: shopToday(), ownerOrgId: orgId,
    title, person,
    minutes: Math.max(0, Math.min(24 * 60, Math.round(data.minutes || 0))),
    systemUpdate: data.systemUpdate.trim(), actionItem: data.actionItem.trim(),
    updatedBy: u.name, updatedAt: new Date(),
  }).returning({ id: eodUpdates.id });
  await audit({
    actor: u.email, entityType: "eod", entityId: `offsystem:${row.id}`, tenantOrgId: tenant,
    action: `logged off-system work: ${title}`,
  });
  revalidatePath("/eod");
  return { id: row.id };
}

/** Fix what an off-system line says it was, who did it, or how long it took. */
export async function editOffSystemWork(
  eodId: number, data: { title: string; person: string; minutes: number },
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const row = await eodRowFor(u, eodId);
  if (!isOffSystem(row)) return { error: "Not found" };
  const title = data.title.trim().slice(0, 160);
  if (!title) return { error: "Say what the work was" };
  const person = data.person.trim();
  if (person && !(await assignableNames(u)).has(person)) return { error: "Unknown person" };
  await db.update(eodUpdates).set({
    title, person,
    minutes: Math.max(0, Math.min(24 * 60, Math.round(data.minutes || 0))),
    updatedBy: u.name, updatedAt: new Date(),
  }).where(eq(eodUpdates.id, eodId));
  revalidatePath("/eod");
  return {};
}

/**
 * Remove an off-system line. Delete rather than skip because there is no
 * record underneath: a line logged against the wrong client, or by mistake,
 * has nothing to fall back to and would otherwise sit on the day forever.
 */
export async function deleteOffSystemWork(eodId: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const row = await eodRowFor(u, eodId);
  if (!isOffSystem(row)) return { error: "Not found" };
  await db.delete(eodUpdates).where(eq(eodUpdates.id, eodId));
  await audit({
    actor: u.email, entityType: "eod", entityId: `offsystem:${eodId}`, tenantOrgId: row.tenantOrgId,
    action: `removed off-system work: ${row.title}`,
  });
  revalidatePath("/eod");
  return {};
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
    // "Our own work" means the sender's own workspace. Read off the instance's
    // operator this sent one company's day to another company's recipients.
    const mine = myTenantOrgId(u);
    const [op] = mine === null ? [] : await db.select().from(orgs).where(eq(orgs.id, mine));
    recipients = op?.eodRecipients ?? "";
    who = op?.name ?? (await getBrand()).name;
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
    // Same sender and same reply-to as the digest, because this is the same
    // kind of mail: a daily report to a client's team. One address for both
    // means a client can filter them together, and a report somebody marks as
    // spam cannot cost anyone the ability to sign in.
    //
    // The reply-to is not decoration. This goes to a whole team on one
    // message, somebody hits reply all, and the From is on a send-only
    // subdomain that will not receive it - so without this the answer bounces
    // for everybody who sent it.
    await sendEmail(to, subject, html, { from: reportFrom(), replyTo: replyToAddress() });
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

/**
 * Mark today's line as written for our own bench rather than for the client.
 * The text is kept and still shows on the system and in the internal digest;
 * the client's report and the partner digest simply never carry it.
 */
export async function setEodInternal(
  target: EodTarget, internal: boolean,
) {
  const u = await requireStaff();
  const date = shopToday();
  if (target.eodId != null) {
    await eodRowFor(u, target.eodId);
    await db.update(eodUpdates).set({ internal, updatedBy: u.name, updatedAt: new Date() })
      .where(eq(eodUpdates.id, target.eodId));
    revalidatePath("/eod");
    return;
  }
  if (target.instrumentId !== null) {
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, target.instrumentId));
    if (!inst) throw new Error("Not found");
    await db.insert(eodUpdates)
      .values({ tenantOrgId: inst.tenantOrgId, instrumentId: target.instrumentId, date, ownerOrgId: inst.ownerOrgId, internal, updatedBy: u.name, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [eodUpdates.instrumentId, eodUpdates.date],
        set: { internal, updatedBy: u.name, updatedAt: new Date() },
      });
  } else if (target.assetId !== null) {
    const [a] = await db.select().from(assets).where(eq(assets.id, target.assetId));
    if (!a) throw new Error("Not found");
    await db.insert(eodUpdates)
      .values({ tenantOrgId: a.tenantOrgId, assetId: target.assetId, date, ownerOrgId: a.ownerOrgId, internal, updatedBy: u.name, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [eodUpdates.assetId, eodUpdates.date],
        set: { internal, updatedBy: u.name, updatedAt: new Date() },
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
  // The owner counts, not only the orgs it was shared WITH: a client that owns
  // the system can open it, so a post there reaches them. Leaving them out is
  // how a discussion notification went missing on a client's own instrument.
  const [inst] = await db.select({ ownerOrgId: instruments.ownerOrgId })
    .from(instruments).where(eq(instruments.id, p.instrumentId));
  const shares = await db.select({ orgId: systemShares.orgId }).from(systemShares)
    .where(eq(systemShares.instrumentId, p.instrumentId));
  const orgIds = [...new Set([
    ...(inst?.ownerOrgId != null ? [inst.ownerOrgId] : []),
    ...shares.map((s) => s.orgId),
  ])];
  if (!orgIds.length) return staff;
  return [...new Set([...staff, ...orgIds.flatMap(emailsFor)])];
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

/**
 * Views whose arrangement is saveable. Anything else is rejected outright.
 *
 * "workorder" was missing while the work order page was already passing it,
 * so every rearrangement there was refused and silently dropped - the caller
 * catches a rejected promise, and this returns a resolved error nobody read.
 */
const PANEL_VIEWS = ["system", "asset", "workorder"] as const;

/**
 * How one person arranged one record page - and, now, which SHAPE of page they
 * want. Bands lay every panel down one scroll with a jump bar; the rail shows
 * one working context at a time. Absent means "the page's default for this
 * view", which is deliberately not the same answer everywhere: see
 * lib/panelMode.
 */
export type PanelArrangement = {
  order: string[]; right: string[]; hidden: string[];
  mode?: PanelMode;
};

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
  const clean: PanelArrangement = {
    order: keys(data?.order), right: keys(data?.right), hidden: keys(data?.hidden),
    // Sanitised like every other field: one of the two literals, or absent.
    // An unknown string would otherwise persist forever and read as neither.
    ...(isPanelMode(data?.mode) ? { mode: data.mode } : {}),
  };
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
  /* And not one this person can never receive. Hiding the switch is what the
     inbox does; this is the door behind it, so a hand-made call cannot leave a
     client holding a preference row for the operator's usage report. Absent
     rather than forbidden: naming the kind back would confirm it exists. */
  if (!mayReceiveKind(kind, isStaffRole(u.role))) return { error: "Unknown notification kind" };
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
  /** The structured spec (criteria, units, hints) - see lib/testResult. */
  acceptance?: Acceptance;
  requiresNote: boolean; consumesPart: boolean;
  runsAtIntake: boolean; intervalDays: number | string | null;
  /**
   * Usage-based cadence ("every 2000 injections") - display and intake only,
   * never scheduled by the calendar cron. Null/absent = none.
   */
  usage?: { every: number | string; unit: string } | null;
  required?: boolean;
  /** Tests only: a report must be filed on the result before sign-off. */
  needsReport?: boolean;
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
  acceptance: string;
  requiresNote: boolean; consumesPart: boolean;
  runsAtIntake: boolean; intervalDays: number | null;
  usageEvery: number | null; usageUnit: string;
  required: boolean; needsReport: boolean;
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
  // Structured acceptance, tests only. Serialization re-validates the rows
  // (op, finite value, unit; center for pm), so half-filled criteria degrade
  // to absent rather than storing garbage - but a measured test that CLAIMS
  // criteria and provides none valid is refused, not silently unfenced.
  let acceptance = "";
  if (isTest && data.acceptance) {
    acceptance = serializeAcceptance(data.acceptance);
    const given = data.acceptance.criteria?.length ?? 0;
    const kept = parseAcceptance(acceptance).criteria?.length ?? 0;
    if (resultType === "measured" && given > 0 && kept < given) {
      return { error: "Each pass limit needs an operator, a number and a unit" };
    }
  }
  let intervalDays: number | null = null;
  if (data.intervalDays !== null && String(data.intervalDays).trim() !== "") {
    const cadence = parseCadence(data.intervalDays);
    if ("error" in cadence) return cadence;
    intervalDays = cadence.days;
  }
  // Usage cadence: valid only in its two units, whole and positive. It rides
  // on the procedure and its intake tasks; the calendar cron never sees it.
  let usageEvery: number | null = null;
  let usageUnit = "";
  if (data.usage && (data.usage.unit === "injections" || data.usage.unit === "hours")) {
    const n = parseInt(String(data.usage.every), 10);
    if (!Number.isInteger(n) || n <= 0) return { error: "Usage cadence must be a whole number above zero" };
    usageEvery = n;
    usageUnit = data.usage.unit;
  }
  // A procedure that never fires is an orphan - refuse it at the source.
  if (!data.runsAtIntake && intervalDays === null && usageEvery === null) {
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
    resultType, target, tolerancePct, acceptance,
    requiresNote: !isTest && data.requiresNote, consumesPart: !isTest && data.consumesPart,
    runsAtIntake: data.runsAtIntake, intervalDays,
    usageEvery, usageUnit,
    // Persisted since the sheet grew the checkbox - it used to be silently
    // dropped here, so "Required for sign-off" never actually saved.
    required: data.required ?? false,
    needsReport: isTest && (data.needsReport ?? false),
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
 * Copy one model's procedures onto another - the G6117A/G6117B case.
 *
 * Two sibling models are usually 90% the same job with three differences, and
 * writing the 90% out a second time by hand is how a second model ends up with
 * a thinner book than the first. So: duplicate, don't widen. Each copy is
 * scoped to the destination model alone and is free to be edited from the
 * moment it lands, which is the whole point - widening the original's scope
 * would mean every later edit hit the fork prompt instead.
 *
 * Two things are deliberately skipped rather than copied. A procedure with NO
 * model scope already covers the destination (it covers every model of the
 * type), so copying it would create a duplicate that fires twice on the same
 * unit. And a name already used on the destination is left alone - somebody
 * has written that one already, and overwriting their words is not a copy.
 */
export async function copyProceduresToModel(
  assetType: string, fromModel: string, toModel: string,
): Promise<{ error?: string; copied?: number; skipped?: number; applied?: number }> {
  const u = await requireStaff();
  const from = fromModel.trim(), to = toModel.trim();
  if (!from || !to) return { error: "Pick a model to copy from" };
  if (from.toLowerCase() === to.toLowerCase()) return { error: "That's the same model" };
  const t = readTenant(u);
  const rows = await db.select().from(procedures)
    .where(and(eq(procedures.assetType, assetType), forTenant(procedures.tenantOrgId, t)));

  const covers = (p: typeof rows[number], m: string) =>
    p.modelScope.length === 0 || p.modelScope.some((x) => x.trim().toLowerCase() === m.toLowerCase());
  const source = rows.filter((p) => covers(p, from));
  const takenNames = new Set(rows.filter((p) => covers(p, to))
    .map((p) => `${p.kind}|${p.name.trim().toLowerCase()}`));

  let copied = 0, skipped = 0, position = Math.max(0, ...rows.map((p) => p.position));
  let anyRecurring = false;
  for (const p of source) {
    // Already the destination's, one way or another.
    if (covers(p, to) || takenNames.has(`${p.kind}|${p.name.trim().toLowerCase()}`)) { skipped++; continue; }
    position++;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _id, createdAt: _createdAt, tenantOrgId: _t, ...rest } = p;
    await db.insert(procedures).values({
      ...rest, modelScope: [to], position,
      // Explicit, not inherited through the spread: the copy belongs to the
      // workspace the original does, and a stamp that rides on a destructure
      // is one refactor away from being silently dropped.
      tenantOrgId: p.tenantOrgId,
    });
    if (p.intervalDays !== null) anyRecurring = true;
    copied++;
  }
  if (!copied) {
    return { copied: 0, skipped, error: skipped ? `${to} already has all of ${from}'s procedures` : `Nothing on ${from} to copy` };
  }
  // Recurring work reaches the fleet the same way a hand-written one does.
  const applied = anyRecurring
    ? await backfillProcedure(assetType, shopToday(), u.email, myTenantOrgId(u))
    : 0;
  await audit({
    actor: u.email, entityType: "procedure", entityId: `${assetType}:${to}`,
    action: `copied ${copied} procedure${copied === 1 ? "" : "s"} from ${from} to ${to}`
      + `${skipped ? ` (${skipped} already covered)` : ""}${applied ? `; scheduled on ${applied} unit${applied === 1 ? "" : "s"}` : ""}`,
    field: "modelScope", oldValue: from, newValue: to,
  });
  revalidatePath("/settings/procedures");
  revalidatePath("/maintenance");
  return { copied, skipped, applied };
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
    ? await db.select({ id: procedures.id, kind: procedures.kind, required: procedures.required, needsReport: procedures.needsReport })
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
    ? await db.select({ taskId: taskResults.taskId, passed: taskResults.passed })
        .from(taskResults).where(inArray(taskResults.taskId, taskIds))
    : [];
  const failedTasks = new Set<number>();
  for (const r of resultRows) {
    reportsByTask.set(r.taskId, (reportsByTask.get(r.taskId) ?? 0) + 1);
    if (r.passed === false) failedTasks.add(r.taskId);
  }
  return signoffGate(
    taskRows.map((t) => {
      const p = procRows.find((x) => x.id === t.procedureId);
      return {
        id: t.id, title: t.title, state: t.state,
        required: p?.required ?? false, kind: p?.kind ?? "task",
        needsReport: p?.needsReport,
        failed: failedTasks.has(t.id),
      };
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

/**
 * A stage definition belongs to one workspace's board. `requireOwner` answers
 * "an owner of some service company", so without this the id in the call was
 * enough to recolor, rename or delete another company's stage - and the rename
 * and delete paths then rewrote that company's instruments to match.
 */
const ownStage = (u: SessionUser, s: { tenantOrgId: number | null }): boolean => {
  const mine = readTenant(u);
  return mine === null || s.tenantOrgId === mine;
};

export async function addStage(name: string, bg: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const n = name.trim();
  if (!n || n.length > 40) return { error: "Stage name must be 1-40 characters" };
  if (!HEX.test(bg)) return { error: "Pick a color" };
  // Per workspace. Unscoped, "already exists" was a report on somebody else's
  // stage list - and the sort order below jumped to clear their rows.
  const existing = await db.select().from(stageDefs)
    .where(forTenant(stageDefs.tenantOrgId, myTenantOrgId(u)));
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
  if (!s || !ownStage(u, s)) return;
  if (s.bg === bg.toUpperCase()) return;
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
  if (!s || !ownStage(u, s)) return {};
  if (s.name === n) return {};
  if (s.builtin) return { error: "Built-in stages can't be renamed - sync and reports key on their names" };
  const existing = await db.select().from(stageDefs)
    .where(forTenant(stageDefs.tenantOrgId, s.tenantOrgId));
  if (existing.some((x) => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) return { error: `"${n}" already exists` };
  await db.update(stageDefs).set({ name: n }).where(eq(stageDefs.id, id));
  // Carry the rename onto every instrument tagged with the old name - in the
  // STAGE'S workspace. This loop writes, and unscoped it rewrote the stage tags
  // on every other operator's fleet because one owner renamed a column on their
  // own board.
  const insts = await db.select().from(instruments)
    .where(forTenant(instruments.tenantOrgId, s.tenantOrgId));
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
  if (!s || !ownStage(u, s)) return {};
  if (s.builtin) return { error: "Built-in stages can't be deleted - sync and reports key on their names" };
  await db.delete(stageDefs).where(eq(stageDefs.id, id));
  // Strip it from any instruments; keep the at-least-one-stage invariant. Same
  // workspace as the stage - see renameStage. Unscoped this reset other
  // operators' systems to "Intake" and filed stage events against them.
  const insts = await db.select().from(instruments)
    .where(forTenant(instruments.tenantOrgId, s.tenantOrgId));
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
  const row = await deviceWithOrg(deviceId, readTenant(u));
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
  } else if (!(await canWriteClientJob(u, wo))) {
    // Nothing behind it to check access against, so the order does it itself.
    // Without this the record-less job would be the one kind of work order
    // anybody signed in could load, which is exactly backwards.
    return { error: "Not found" };
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
 * Refuse the two moves that commit somebody to a drive, while the client is on
 * credit hold and nobody has overridden it.
 *
 * ENFORCED HERE, not in the form. The panel on the work order and the column
 * in the queue are courtesies; this is the authority. An override written by
 * an owner - with its reason - is what clears it, which is what makes the
 * reason worth demanding in the first place.
 *
 * Failure to compute is not a refusal: if the credit check itself throws, the
 * work goes ahead. A billing lookup that falls over must not become the reason
 * a down instrument goes unattended.
 */
async function creditRefusal(
  orgId: number | null, action: HeldAction,
): Promise<string> {
  if (orgId === null) return "";
  const standing = await creditFor(orgId, shopToday()).catch(() => null);
  if (!standing) return "";
  const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId));
  return holdRefusal(standing, action, org?.name ?? "this client");
}

/**
 * Somebody at the shop opens a job. The other way in is a client asking - see
 * reportIssue and requestPm, which land in the same place.
 *
 * The target is a system, a standalone unit, or - when neither is named - a
 * CLIENT: the move, the site survey, the phone call that arrives before
 * anybody knows which instrument it is about. `orgId` names the client; on a
 * system it is ignored in favour of the record's own owner, except that it may
 * be given for a house-owned system to say whose job the shop is doing.
 */
export async function openWorkOrder(
  target: WorkTarget & { orgId?: number | null },
  data: { title: string; body: string; severity: string; assignee?: string },
): Promise<{ error?: string; id?: number; number?: string; flag?: string; hold?: string }> {
  const u = await requireEditor();
  const title = data.title.trim().slice(0, 160);
  if (!title) return { error: "Say briefly what the job is" };
  const picked = target.orgId ?? null;
  const clientJob = target.instrumentId === null && target.assetId === null;
  const t0 = clientJob
    ? await resolveClientJobTarget(u, picked)
    : await resolveTarget({ instrumentId: target.instrumentId, assetId: target.assetId });
  if ("error" in t0) return t0;

  // Whose job it is: the record's owner, not whoever typed it. An engineer
  // opening an order on a client's instrument is opening the CLIENT's job.
  // A house-owned system has no owner to speak for it, so there a named
  // client stands - that is the refurb the shop is doing FOR somebody.
  const owner = clientJob ? picked
    : t0.instrumentId !== null
      ? (await db.select({ o: instruments.ownerOrgId }).from(instruments)
          .where(eq(instruments.id, t0.instrumentId)))[0]?.o ?? null
      : t0.asset?.ownerOrgId ?? null;
  if (!clientJob && picked !== null && owner !== null && picked !== owner) {
    const [o] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, owner));
    return { error: `That system belongs to ${o?.name ?? "another client"} - open the job on them, or pick one of this client's systems.` };
  }
  const orgId = owner ?? picked;

  // Dispatching at intake is a dispatch like any other. The job itself is
  // never refused - the instrument is down either way - so a held client's
  // order is filed unassigned and says why.
  if ((data.assignee ?? "").trim()) {
    const refusal = await creditRefusal(orgId, "dispatch");
    if (refusal) return { error: refusal };
  }

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
  // Same posture for the credit check, and for a stronger reason: a client's
  // instrument is DOWN. Refusing to record that because their AP is slow is a
  // worse failure than the debt. The job opens ON HOLD - said here, drawn on
  // the record, and read by whoever is deciding whether to load the van.
  const credit = await creditFor(orgId, shopToday()).catch(() => null);
  return {
    id: wo.id, number: wo.number,
    flag: flag || undefined,
    hold: credit?.onHold ? credit.line : undefined,
  };
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
  // Naming an engineer is the moment a van and a day get committed. Only the
  // change is gated: an order that already has somebody on it can still have
  // its title fixed while the account is held.
  if (next.assignee && next.assignee !== wo.assignee) {
    const refusal = await creditRefusal(wo.orgId, "dispatch");
    if (refusal) return { error: refusal };
  }
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
 * Point a client's job at the system it turned out to be about.
 *
 * The call comes in before anybody knows which instrument it is - "the LC in
 * the back room is doing it again" - and the job is opened on the client. Two
 * days later the engineer is standing in front of T-002. Without this the
 * history splits: the hours are on a job nobody can find from the system, and
 * the system's page says that week was quiet.
 *
 * So the job's own rows follow it across. Only rows that have no record of
 * their own move - a row already filed against something else was filed
 * deliberately, and this is not the place to overrule that.
 *
 * One way only: a job that has a record keeps it. Moving work off a system
 * would take that week out of its history, which is the failure this exists
 * to prevent, pointed the other way.
 */
export async function attachWorkOrderSystem(
  woId: number, instrumentId: number,
): Promise<{ error?: string; externalId?: string }> {
  const u = await requireStaff();
  const found = await loadWorkOrder(u, woId);
  if ("error" in found) return found;
  const { wo, mover } = found;
  if (mover !== "house") return { error: "That is the service team's to change." };
  if (wo.instrumentId !== null || wo.assetId !== null) {
    return { error: `${wo.number} is already on a record.` };
  }
  if (!woAcceptsWork(wo.state)) {
    return { error: `${wo.number} is ${WO_LABEL[wo.state]?.toLowerCase() ?? "finished"} - reopen it first.` };
  }
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  if (!(await canEditSystem(u, instrumentId))) return { error: "Not found" };
  if (inst.tenantOrgId !== wo.tenantOrgId) return { error: "That system is in another workspace." };
  // A job filed for one client cannot be moved onto another's instrument: that
  // is somebody else's hours on somebody else's bill. The shop's own bench has
  // no owner to disagree, so it takes the job as it stands.
  if (wo.orgId !== null && inst.ownerOrgId !== null && inst.ownerOrgId !== wo.orgId) {
    const [o] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, inst.ownerOrgId));
    return { error: `${inst.externalId} belongs to ${o?.name ?? "another client"}, not to this job's client.` };
  }

  await db.update(workOrders)
    .set({ instrumentId, orgId: wo.orgId ?? inst.ownerOrgId })
    .where(eq(workOrders.id, woId));
  for (const table of [tasks, timeEntries, parts, attachments]) {
    await db.update(table).set({ instrumentId })
      .where(and(eq(table.workOrderId, woId), isNull(table.instrumentId)));
  }
  await audit({
    actor: u.email, instrumentId, entityType: "work_order", entityId: wo.id,
    action: `put ${wo.number} on ${inst.externalId}, with the work already filed on it`,
    field: "instrument", oldValue: "(no system)", newValue: inst.externalId,
  });
  revWo({ ...wo, instrumentId });
  return { externalId: inst.externalId };
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

  // Starting is the other commitment. Every other move stays open on a held
  // account - a job still has to be able to wait, resolve, close and be
  // cancelled, and blocking those would corrupt the record rather than
  // protect the money.
  if (move.next === "active" && wo.state !== "active") {
    const refusal = await creditRefusal(wo.orgId, "start");
    if (refusal) return { error: refusal };
  }

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
  // Resolved means the work is done, and the job's own list is the record of
  // the work - so a job cannot claim done over open tasks, the same way a test
  // cannot close without its result. Finish them or delete them; either is one
  // click on tasks that turned out not to apply.
  const stillOpen = doneRows.filter((t) => t.state !== "Done").length;
  if (stillOpen) {
    return { error: `${stillOpen} task${stillOpen === 1 ? " on this job is" : "s on this job are"} still open - finish or remove ${stillOpen === 1 ? "it" : "them"} first.` };
  }

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

/** The actor as lib/notes wants them. isHouse decides moderation, not editing. */
const noteActor = (u: SessionUser) => ({ email: u.email, name: u.name, isHouse: isHouse(u.role) });

/**
 * Fix a comment you posted. Yours alone - see lib/notes for why the house is
 * deliberately not given this. The old text goes to the audit log and the row
 * is stamped edited, so a client-visible sentence never changes in silence.
 */
export async function updateWorkOrderNote(noteId: number, text: string): Promise<{ error?: string }> {
  const u = await requireEditor();
  const body = text.trim();
  if (!body) return { error: "Say something, or delete it instead." };
  const [n] = await db.select().from(workOrderNotes).where(eq(workOrderNotes.id, noteId));
  if (!n) return { error: "Not found" };
  const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, n.workOrderId));
  if (!wo) return { error: "Not found" };
  await assertWorkEditable(u, wo);
  if (!canEditNote(n, noteActor(u))) return { error: "Only whoever wrote a comment can change it." };
  if (n.text === body) return {};
  await db.update(workOrderNotes).set({ text: body, editedAt: new Date() }).where(eq(workOrderNotes.id, noteId));
  await audit({
    actor: u.email, instrumentId: wo.instrumentId, assetId: wo.assetId,
    entityType: "wo_note", entityId: noteId,
    action: `edited their comment on ${wo.number}`, field: "text", oldValue: n.text, newValue: body,
  });
  revalidatePath(`/work/${wo.id}`);
  return {};
}

/**
 * Withdraw a comment - your own, or, for the house, anyone's on a record it is
 * accountable for. The text survives in the audit log either way: the point is
 * that it stops standing on the job, not that it never happened.
 */
export async function deleteWorkOrderNote(noteId: number): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [n] = await db.select().from(workOrderNotes).where(eq(workOrderNotes.id, noteId));
  if (!n) return {};
  const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, n.workOrderId));
  if (!wo) return { error: "Not found" };
  await assertWorkEditable(u, wo);
  if (!canDeleteNote(n, noteActor(u))) return { error: "That comment isn't yours to remove." };
  await db.delete(workOrderNotes).where(eq(workOrderNotes.id, noteId));
  await audit({
    actor: u.email, instrumentId: wo.instrumentId, assetId: wo.assetId,
    entityType: "wo_note", entityId: noteId,
    action: `deleted ${isAuthor(n, noteActor(u)) ? "their" : `${n.author}'s`} comment on ${wo.number}`,
    field: "text", oldValue: n.text,
  });
  revalidatePath(`/work/${wo.id}`);
  return {};
}

/**
 * Delete a work order outright - the one opened by mistake, the duplicate, the
 * test row from a Tuesday afternoon. Cancelling is the tool for a job that was
 * real and then called off; this is for one that should never have existed.
 *
 * What it deliberately does NOT do is delete the work. Tasks, hours, parts,
 * files and purchase orders all point at the order with ON DELETE SET NULL, so
 * they survive as the system's own records - a job is a wrapper around work
 * that happened, and throwing away the wrapper must not throw away the work.
 * Only the comment thread goes, because it is about the wrapper.
 *
 * Refused once the order is resolved or closed. That state published a
 * close-out to the client's own feed and is the history a service record is
 * made of; re-opening it first is a deliberate act, and having to perform it
 * is the point.
 */
export async function deleteWorkOrder(woId: number, reason: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const found = await loadWorkOrder(u, woId);
  if ("error" in found) return found;
  const { wo, mover } = found;
  if (mover !== "house") return { error: "Only the service team deletes a job." };
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  if (wo.state === "resolved" || wo.state === "closed") {
    return { error: `${wo.number} is ${WO_LABEL[wo.state].toLowerCase()} - its close-out is on the client's record. Re-open it first if it really has to go.` };
  }

  // Count what is about to be set loose, so the audit line says where it went
  // rather than leaving somebody to wonder why tasks appeared unattached.
  const [taskRows, timeRows, partRows, fileRows] = await Promise.all([
    db.select({ id: tasks.id }).from(tasks).where(eq(tasks.workOrderId, woId)),
    db.select({ id: timeEntries.id }).from(timeEntries).where(eq(timeEntries.workOrderId, woId)),
    db.select({ id: parts.id }).from(parts).where(eq(parts.workOrderId, woId)),
    db.select({ id: attachments.id }).from(attachments).where(eq(attachments.workOrderId, woId)),
  ]);
  const freed = [
    taskRows.length ? `${taskRows.length} task${taskRows.length === 1 ? "" : "s"}` : "",
    timeRows.length ? `${timeRows.length} time entr${timeRows.length === 1 ? "y" : "ies"}` : "",
    partRows.length ? `${partRows.length} part${partRows.length === 1 ? "" : "s"}` : "",
    fileRows.length ? `${fileRows.length} file${fileRows.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(", ");

  await db.delete(workOrders).where(eq(workOrders.id, woId));
  await audit({
    actor: u.email, instrumentId: wo.instrumentId, assetId: wo.assetId,
    entityType: "work_order", entityId: woId,
    action: `deleted ${wo.number} '${wo.title}' (was ${WO_LABEL[wo.state] ?? wo.state})`
      + (freed ? ` - ${freed} released to the record` : "")
      + ` - reason: ${why}`,
    field: "reason", newValue: why,
  });
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
  const row = await deviceWithOrg(deviceId, readTenant(u));
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
  const row = await deviceWithOrg(deviceId, readTenant(u));
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
  const row = await deviceWithOrg(deviceId, readTenant(u));
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
  const row = await deviceWithOrg(deviceId, readTenant(u));
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
    const used = await storeUsedBytes(orgId, await storeTenantFor(orgId, u));
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

/**
 * Who at an organization receives the partner edition of the daily digest.
 * Opt-in per organization and deliberately separate from the EOD list: the
 * digest is sent by the machine every morning, and a client added to a
 * hand-written report must not silently start receiving an automated one.
 */
export async function updateDigestRecipients(orgId: number, value: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const entries = value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = entries.find((e) => !ALLOW_EMAIL.test(e));
  if (bad) return { error: `"${bad}" doesn't look like an email` };
  const digestRecipients = entries.join(", ");
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };
  await db.update(orgs).set({ digestRecipients }).where(eq(orgs.id, orgId));
  await audit({
    actor: u.email, entityType: "settings", entityId: orgId,
    action: `${org.name} daily digest recipients: ${digestRecipients || "(none)"}`,
  });
  revalidatePath("/settings");
  return {};
}

/**
 * When this organization's digest goes out: the hour, and which days of the
 * week. On the operator's own row it sets the internal edition's schedule.
 * The cron runs hourly and sends what is due, so this takes effect the next
 * morning with no deploy - and a rested day loses nothing, because the next
 * edition's window reaches back to the last one (lib/digestDays).
 */
export async function setDigestHour(orgId: number | null, hour: number, days: number[]): Promise<{ error?: string }> {
  const u = await requireOwner();
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { error: "Pick an hour of the day" };
  if (!days.length) return { error: "Pick at least one day - to stop the digest, clear its recipients instead" };
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return { error: "Those aren't days of the week" };
  const digestDays = serializeDigestDays(days);
  const at = `${String(hour).padStart(2, "0")}:00`;
  const on = digestDays ? `on days ${digestDays}` : "every day";
  // Null is the workspace's own internal edition. It lives on the operator's
  // org row, because a workspace IS an organization - and on the settings
  // singleton for an instance that has never named one.
  if (orgId === null) {
    const tenantOrgId = myTenantOrgId(u);
    if (tenantOrgId !== null) await db.update(orgs).set({ digestHour: hour, digestDays }).where(eq(orgs.id, tenantOrgId));
    else await db.update(appSettings).set({ digestHour: hour, digestDays }).where(eq(appSettings.id, 1));
    await audit({ actor: u.email, entityType: "settings", entityId: tenantOrgId ?? 0, action: `internal daily digest: ${at} ${on}` });
    revalidatePath("/settings");
    return {};
  }
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };
  await db.update(orgs).set({ digestHour: hour, digestDays }).where(eq(orgs.id, orgId));
  await audit({
    actor: u.email, entityType: "settings", entityId: orgId,
    action: `${org.name} daily digest: ${at} ${on}`,
  });
  revalidatePath("/settings");
  return {};
}

/**
 * Send an edition now rather than waiting for the morning - the button beside
 * the preview, for when the schedule is not the point.
 *
 * `orgId` null is the internal edition for the caller's own workspace;
 * anything else is that organization's partner edition. It goes through the
 * same path the cron takes, so what lands is the same email to the same
 * people and it counts as today's: pressing this at nine does not earn a
 * second copy at ten.
 */
export async function sendDigestNow(orgId: number | null): Promise<{
  error?: string; sent?: number; to?: string;
}> {
  const u = await requireStaff();
  if (!(await getModules()).digest) return { error: "The daily digest module is off for this instance" };
  const tenantOrgId = myTenantOrgId(u);
  if (orgId !== null) {
    const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
    // Somebody else's client is not ours to mail about.
    if (!org || (tenantOrgId !== null && org.parentOrgId !== tenantOrgId)) return { error: "Not found" };
  }
  const res = await sendDigestEdition(tenantOrgId, orgId);
  if (!res.sent) return { error: `Not sent - ${res.reason}` };
  await audit({
    actor: u.email, entityType: "settings", entityId: orgId ?? 0,
    action: `sent the daily digest now to ${res.to.join(", ")}`,
  });
  revalidatePath("/settings");
  return { sent: res.to.length, to: res.to.join(", ") };
}

// ---------------- Client sign-in allowlist ----------------

/** "jane@labzenllc.com" (one person) or "@labzenllc.com" (whole domain). */
const ALLOW_EMAIL = /^[^\s@]+@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;
const ALLOW_DOMAIN = /^@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;

/**
 * A whole person at a client, in one go: who they are, what they may do, where
 * they sit - and, when email cannot be trusted to arrive, a temporary password
 * to read down the phone.
 *
 * The one-line "invite an address" that this sits beside is still the fast
 * path, and still what a client's own editor uses for a colleague. This is for
 * the moment somebody is setting a company up: five people, each with a name, a
 * job title, a lab, and a role - typed once, from the page that already knows
 * which organization they belong to.
 *
 * The profile row is written even though they have never signed in, exactly as
 * updatePersonProfile does: their first sign-in finds it by address. That is
 * also what a password can hang on, which is why the two are one action.
 */
export async function addClientPerson(orgId: number, data: {
  firstName: string; lastName: string; title: string; email: string;
  siteId: number | null; canEdit: boolean; canSeeAgreements: boolean;
  invite: boolean;
  /** Mint a temporary password and hand it back, once, to be said out loud. */
  withPassword?: boolean;
  tempDays?: number;
}): Promise<{ error?: string; password?: string; expiresOn?: string; invited?: boolean }> {
  const u = await requireEditor();
  const email = data.email.trim().toLowerCase();
  if (!ALLOW_EMAIL.test(email)) return { error: 'Enter their email, like "jane@company.com"' };

  // The same two routes in as addClientAccess: an operator's staff for a client
  // they administer, or an organization's own editors for their own people.
  const asStaff = isStaffRole(u.role);
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };
  if (asStaff) {
    if (!mayAdminOrg(tenantViewer(u), org)) return { error: "Not found" };
  } else if (u.orgId === null || orgId !== u.orgId) {
    return { error: "Not found" };
  }

  const [taken] = await db.select().from(clientAllowlist).where(eq(clientAllowlist.entry, email));
  if (taken) {
    const [where] = taken.orgId === null ? [] : await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, taken.orgId));
    return { error: `${email} already signs in${where ? ` as ${where.name}` : ""}.` };
  }

  // Where they sit has to be one of this organization's own labs.
  let siteId: number | null = null;
  if (data.siteId !== null) {
    const [site] = await db.select().from(orgSites).where(eq(orgSites.id, data.siteId));
    if (!site || site.orgId !== orgId) return { error: "That site is not one of theirs" };
    siteId = site.id;
  }

  const first = data.firstName.trim().slice(0, 60);
  const last = data.lastName.trim().slice(0, 60);
  const title = data.title.trim().slice(0, 80);
  const display = [first, last].filter(Boolean).join(" ");

  await db.insert(clientAllowlist).values({
    entry: email, orgId, canEdit: data.canEdit,
    canSeeAgreements: data.canSeeAgreements, addedBy: u.name,
  });
  const profile = { firstName: first, lastName: last, title, siteId, ...(display ? { name: display } : {}) };
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) await db.update(users).set(profile).where(eq(users.id, existing.id));
  else await db.insert(users).values({ email, ...profile });

  await audit({
    actor: u.email, entityType: "settings", entityId: email,
    action: `added ${display || email} to ${org.name} as ${data.canEdit ? "an editor" : "a viewer"}`
      + `${title ? ` (${title})` : ""}`,
  });

  // The temporary password. Staff only: a client's own editor may invite a
  // colleague, but minting a credential that skips the mailbox entirely is the
  // shop's call, and it is the shop that will be asked who let somebody in.
  let password: string | undefined;
  let expiresOn: string | undefined;
  if (data.withPassword) {
    if (!asStaff) return { error: "Only the service team can set a temporary password." };
    const made = await mintTempPassword(u, email, data.tempDays ?? TEMP_DAYS_DEFAULT);
    if ("error" in made) return made;
    password = made.password;
    expiresOn = made.expiresOn;
  }

  let invited = false;
  if (data.invite) {
    await notifyInvite({ to: email, inviterName: u.name, orgName: org.name, tempPassword: !!password });
    invited = true;
  }
  revalidatePath("/settings");
  revalidatePath(`/settings/organizations/${orgId}`);
  rev();
  return { password, expiresOn, invited };
}

/**
 * Mint a temporary password for somebody, and hand it back exactly once.
 *
 * Never mailed, never stored in the clear, never written to the audit line -
 * the row records THAT one was set, by whom, and until when. The plaintext
 * lives in one HTTP response and then only in the head of the person who is
 * going to read it down a phone.
 */
async function mintTempPassword(
  u: SessionUser, email: string, days: number,
): Promise<{ error: string } | { password: string; expiresOn: string }> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!row) return { error: "Add them first, then set a password." };
  const until = tempExpiry(days, new Date());
  // Generated rather than invented: an owner in a hurry types "Welcome2026",
  // and a password somebody can guess from the company name is not a stopgap,
  // it is a door. Four tries is a formality - the words are unique per pick -
  // but the loop means a rejected one is a retry, never a thrown error.
  let password = "";
  for (let i = 0; i < 4 && !password; i++) {
    const candidate = makeTempPassword((max) => crypto.randomInt(max));
    const res = await setPasswordFor(email, candidate, until);
    if (!res.error) password = candidate;
  }
  if (!password) return { error: "Could not set a password for them - try again." };
  await audit({
    actor: u.email, entityType: "auth", entityId: email,
    action: `set a temporary sign-in password for ${email}, good until ${until.toISOString().slice(0, 10)}`,
  });
  return { password, expiresOn: until.toISOString().slice(0, 10) };
}

/**
 * A temporary password for somebody who is already here - the other half of the
 * same problem. Their address was approved weeks ago and the codes are landing
 * in a spam folder nobody can reach.
 */
export async function setClientTempPassword(
  allowlistId: number, days?: number,
): Promise<{ error?: string; password?: string; expiresOn?: string }> {
  const u = await requireStaff();
  const [row] = await db.select().from(clientAllowlist).where(eq(clientAllowlist.id, allowlistId));
  if (!row || row.orgId === null) return { error: "Not found" };
  const gate = await adminOrgGate(u, row.orgId);
  if ("error" in gate) return gate;
  const email = row.entry.trim().toLowerCase();
  if (email.startsWith("@")) return { error: "That is a whole domain, not a person." };

  // A password needs a row to hang on. Somebody approved but never signed in
  // has none yet, and this is the moment to make it - the same row their first
  // sign-in would have created, with the same address on it.
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!existing) await db.insert(users).values({ email });
  const made = await mintTempPassword(u, email, days ?? TEMP_DAYS_DEFAULT);
  if ("error" in made) return made;
  revalidatePath(`/settings/organizations/${row.orgId}`);
  return made;
}

/**
 * Send somebody's invitation again, with a working password in it.
 *
 * The invitation that matters is rarely the first one. An address gets a typo,
 * a first email lands in quarantine, somebody starts three months after they
 * were added - and the operator's only recourse was to remove the person and
 * add them back, which is a destructive edit standing in for a resend.
 *
 * A resend always mints a FRESH temporary password and prints it in the email.
 * Fresh because it has to be: the stored one is a scrypt hash, so there is no
 * "the" password to resend - the plaintext existed for one HTTP response and
 * is gone. And in the email by decision: a resend exists because somebody
 * cannot get in, and making them wait for a phone call to finish the job is
 * the same stall the resend is meant to end. The cost is real and bounded -
 * a live credential sits in an inbox until it expires - which is why this
 * mints rather than reveals, and why the expiry is printed beside it.
 *
 * Any previous password stops working the moment this runs. That is the point:
 * one invitation is live at a time, and it is the one they were just sent.
 */
export async function resendInvite(
  allowlistId: number, days?: number,
): Promise<{ error?: string; password?: string; expiresOn?: string; mailed?: boolean }> {
  const u = await requireStaff();
  const [row] = await db.select().from(clientAllowlist).where(eq(clientAllowlist.id, allowlistId));
  if (!row || row.orgId === null) return { error: "Not found" };
  const gate = await adminOrgGate(u, row.orgId);
  if ("error" in gate) return gate;
  const { org } = gate;
  const email = row.entry.trim().toLowerCase();
  // A domain entry covers everybody at a company and belongs to no mailbox.
  if (email.startsWith("@")) return { error: "That is a whole domain, not a person." };

  // Same bootstrap as setClientTempPassword: somebody approved but never signed
  // in has no users row yet, and a password needs one to hang on.
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!existing) await db.insert(users).values({ email });

  const made = await mintTempPassword(u, email, days ?? TEMP_DAYS_DEFAULT);
  if ("error" in made) return made;

  const mailed = await notifyInvite({
    to: email, inviterName: u.name, orgName: org.name,
    tempPasswordPlain: made.password, tempExpiresOn: made.expiresOn,
  });
  await audit({
    actor: u.email, entityType: "auth", entityId: email,
    action: mailed
      ? `resent ${email}'s invitation with a new temporary password, good until ${made.expiresOn}`
      : `minted a new temporary password for ${email}, good until ${made.expiresOn} - the invitation email did NOT go out`,
  });
  revalidatePath(`/settings/organizations/${row.orgId}`);
  /* The password stands either way - it is already set, and telling the caller
     otherwise would be a second lie on top of the failed send. What changes is
     whether the operator still has to make the phone call. */
  return { ...made, mailed };
}

/** Take it back. Codes never stopped working, so this takes nothing away. */
export async function clearClientTempPassword(allowlistId: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [row] = await db.select().from(clientAllowlist).where(eq(clientAllowlist.id, allowlistId));
  if (!row || row.orgId === null) return { error: "Not found" };
  const gate = await adminOrgGate(u, row.orgId);
  if ("error" in gate) return gate;
  const email = row.entry.trim().toLowerCase();
  await clearPasswordFor(email);
  await audit({
    actor: u.email, entityType: "auth", entityId: email,
    action: `removed the sign-in password from ${email}`,
  });
  revalidatePath(`/settings/organizations/${row.orgId}`);
  return {};
}

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

/**
 * Who at a client may read their organization's PAYROLL.
 *
 * Off by default and turned on one person at a time, unlike the agreements
 * flag beside it, which defaults on. The asymmetry is the point: everyone at
 * an organization could always see what their instruments cost, and nobody
 * should ever accidentally be able to see what their colleagues earn.
 *
 * Staff of the workspace grant it, and granting it gives them nothing: the
 * shop cannot read that payroll either (lib/payroll).
 */
export async function setClientSeesPayroll(id: number, canSee: boolean): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [row] = await db.select().from(clientAllowlist).where(eq(clientAllowlist.id, id));
  if (!row || row.orgId === null) return { error: "Not found" };
  const gate = await adminOrgGate(u, row.orgId);
  if ("error" in gate) return gate;
  if (row.canSeePayroll === canSee) return {};
  await db.update(clientAllowlist).set({ canSeePayroll: canSee }).where(eq(clientAllowlist.id, id));
  await audit({
    actor: u.email, entityType: "settings", entityId: row.entry,
    action: `${row.entry} ${canSee ? "may now read" : "may no longer read"} their organization's payroll`,
    field: "can_see_payroll", oldValue: String(row.canSeePayroll), newValue: String(canSee),
  });
  revalidatePath("/settings");
  revalidatePath(`/settings/organizations/${row.orgId}`);
  revalidatePath("/money/payroll");
  return {};
}

/**
 * Who at a client may read their organization's MONEY - the quotes it has been
 * sent and the invoices it owes.
 *
 * Defaults ON, like agreements and unlike payroll, and for a reason worth
 * writing down: an operator has an owner role, so keeping ITS books to the
 * owner is a rule with no switch (lib/books). A client organization has no
 * owner role. Shipping this off would leave some labs with nobody who could
 * open their own invoice until somebody here granted it back, which is a
 * broken account rather than a private one. So it is taken away per person,
 * deliberately, rather than removed from everybody by upgrading.
 */
export async function setClientSeesMoney(id: number, canSee: boolean): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [row] = await db.select().from(clientAllowlist).where(eq(clientAllowlist.id, id));
  if (!row || row.orgId === null) return { error: "Not found" };
  const gate = await adminOrgGate(u, row.orgId);
  if ("error" in gate) return gate;
  if (row.canSeeMoney === canSee) return {};
  await db.update(clientAllowlist).set({ canSeeMoney: canSee }).where(eq(clientAllowlist.id, id));
  await audit({
    actor: u.email, entityType: "settings", entityId: row.entry,
    action: `${row.entry} ${canSee ? "may now read" : "may no longer read"} their organization's quotes and invoices`,
    field: "can_see_money", oldValue: String(row.canSeeMoney), newValue: String(canSee),
  });
  revalidatePath("/settings");
  revalidatePath(`/settings/organizations/${row.orgId}`);
  revalidatePath("/orders");
  return {};
}

// ---------------- Payroll ----------------
// The most guarded rows in the app. Every one of these actions decides access
// through lib/payroll rather than through the tenancy helpers the rest of the
// file uses, because the rule is the opposite one: an operator's staff can
// read everything in their workspace EXCEPT this.

/**
 * The four facts lib/payroll needs about whoever is asking, assembled from the
 * session and the person's own allowlist row.
 */
async function payrollViewer(u: SessionUser): Promise<PayrollViewer> {
  let canSeePayroll = false;
  if (u.orgId !== null) {
    const [row] = await db.select({ canSeePayroll: clientAllowlist.canSeePayroll })
      .from(clientAllowlist).where(eq(clientAllowlist.entry, u.email.trim().toLowerCase()));
    canSeePayroll = row?.canSeePayroll ?? false;
  }
  return {
    email: u.email, role: u.role, orgId: u.orgId,
    operatorOrgId: myTenantOrgId(u), canSeePayroll,
  };
}

/**
 * The register as this person may read it: their organization's whole payroll
 * when they may see it, their own row when they may not, and nothing at all
 * for anybody else - including the operator hosting them.
 */
export async function readPayroll(orgId: number): Promise<{
  error?: string; rows?: PayRow[]; whole?: boolean; mayEdit?: boolean;
}> {
  const u = await requireUser();
  const v = await payrollViewer(u);
  const whole = maySeePayroll(v, orgId);
  const all = (await db.select().from(payroll).where(eq(payroll.orgId, orgId))
    .orderBy(asc(payroll.name), asc(payroll.effectiveOn))) as PayRow[];
  const rows = visibleRows(v, orgId, all);
  if (!whole && rows.length === 0) return { error: "Not found" };
  return { rows, whole, mayEdit: mayEditPayroll(v, orgId) };
}

/**
 * Put somebody on the payroll, or record what changed about their pay.
 *
 * A change is a NEW ROW, not an edit: the one in force is closed the day
 * before the new one starts, so last quarter's overhead still says what last
 * quarter cost. That is the difference between a register and a guess, and it
 * is why nothing here updates an amount in place.
 */
export async function addPayrollEntry(orgId: number, data: {
  name: string; personEmail: string; title: string;
  kind: string; amount: string; hoursPerWeek: number; ftePct: number; burdenPct: number;
  effectiveOn: string; note: string;
}): Promise<{ error?: string; superseded?: string }> {
  const u = await requireUser();
  const v = await payrollViewer(u);
  if (!mayEditPayroll(v, orgId)) return { error: "Not found" };

  const name = data.name.trim().slice(0, 80);
  if (!name) return { error: "Say whose pay this is" };
  const kind = ["salary", "hourly", "monthly"].includes(data.kind) ? data.kind : "salary";
  const amountCents = parseMoney(data.amount);
  if (amountCents === null || amountCents <= 0) return { error: "Enter what they are paid" };
  const effectiveOn = data.effectiveOn.trim();
  if (!isIsoDay(effectiveOn)) return { error: "Pick the day this takes effect" };
  const personEmail = data.personEmail.trim().toLowerCase().slice(0, 160);

  // The row this one replaces: the same person, still in force, starting no
  // later than this one. Closed the day before, so no month counts them twice.
  let superseded: string | undefined;
  const mine = await db.select().from(payroll).where(eq(payroll.orgId, orgId));
  const previous = mine.find((r) => r.endsOn === "" && r.effectiveOn <= effectiveOn
    && (personEmail ? r.personEmail.toLowerCase() === personEmail : r.name.toLowerCase() === name.toLowerCase()));
  if (previous) {
    const dayBefore = new Date(`${effectiveOn}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    const closed = dayBefore.toISOString().slice(0, 10);
    await db.update(payroll).set({ endsOn: closed }).where(eq(payroll.id, previous.id));
    superseded = closed;
  }

  await db.insert(payroll).values({
    tenantOrgId: await tenantOfOrg(orgId),
    orgId, personEmail, name, title: data.title.trim().slice(0, 80),
    kind, amountCents,
    hoursPerWeek: Math.min(168, Math.max(0, Math.round(data.hoursPerWeek || 40))),
    ftePct: Math.min(100, Math.max(1, Math.round(data.ftePct || 100))),
    burdenPct: Math.min(200, Math.max(0, Math.round(data.burdenPct || 0))),
    effectiveOn, note: data.note.trim().slice(0, 300), createdBy: u.email,
  });
  // The audit line records THAT pay was set and by whom, never the figure -
  // the audit log is read by more people than the register is.
  await audit({
    actor: u.email, entityType: "payroll", entityId: String(orgId), tenantOrgId: await tenantOfOrg(orgId),
    action: previous
      ? `changed ${name}'s pay from ${effectiveOn}`
      : `put ${name} on the payroll from ${effectiveOn}`,
  });
  revalidatePath("/money/payroll");
  revalidatePath("/money/expenses");
  return { superseded };
}

/** They left, or the line stopped. The history stays; the months after it do not. */
export async function endPayrollEntry(id: number, endsOn: string): Promise<{ error?: string }> {
  const u = await requireUser();
  const [row] = await db.select().from(payroll).where(eq(payroll.id, id));
  if (!row) return { error: "Not found" };
  const v = await payrollViewer(u);
  if (!mayEditPayroll(v, row.orgId)) return { error: "Not found" };
  const day = endsOn.trim();
  if (!isIsoDay(day)) return { error: "Pick the last day" };
  if (day < row.effectiveOn) return { error: "That is before the pay started" };
  await db.update(payroll).set({ endsOn: day }).where(eq(payroll.id, id));
  await audit({
    actor: u.email, entityType: "payroll", entityId: String(row.orgId), tenantOrgId: row.tenantOrgId,
    action: `ended ${row.name}'s pay on ${day}`,
  });
  revalidatePath("/money/payroll");
  revalidatePath("/money/expenses");
  return {};
}

/**
 * Delete outright - for the row typed wrong, not for somebody who left. A
 * reason is required and kept, the same discipline every other destruction in
 * this app carries.
 */
export async function deletePayrollEntry(id: number, reason: string): Promise<{ error?: string }> {
  const u = await requireUser();
  const [row] = await db.select().from(payroll).where(eq(payroll.id, id));
  if (!row) return { error: "Not found" };
  const v = await payrollViewer(u);
  if (!mayEditPayroll(v, row.orgId)) return { error: "Not found" };
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  await db.delete(payroll).where(eq(payroll.id, id));
  await audit({
    actor: u.email, entityType: "payroll", entityId: String(row.orgId), tenantOrgId: row.tenantOrgId,
    action: `deleted ${row.name}'s pay row from ${row.effectiveOn} - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revalidatePath("/money/payroll");
  revalidatePath("/money/expenses");
  return {};
}

/**
 * Adopt what a month actually cost as the loaded labor rate job costing uses.
 *
 * Deliberately a button rather than a silent override. Costing has always read
 * one number from settings; this makes that number derived instead of guessed,
 * and leaves it visible and changeable where it always was.
 */
export async function useDerivedLaborRate(centsPerHour: number): Promise<{ error?: string }> {
  const u = await requireOwner();
  const cents = Math.max(0, Math.round(centsPerHour));
  if (!cents) return { error: "There is no rate to adopt yet" };
  await db.update(appSettings).set({ loadedLaborCents: cents }).where(eq(appSettings.id, 1));
  await audit({
    actor: u.email, entityType: "settings", entityId: "loaded_labor",
    action: `set loaded labor to ${formatCents(cents)}/h from payroll and overhead`,
    field: "loaded_labor_cents", newValue: String(cents),
  });
  revalidatePath("/money/costing");
  revalidatePath("/money/expenses");
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
  data: { hours: string; person: string; date: string; note: string; billable?: boolean; category?: string },
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
    // Unbillable hours are still hours: they stay on the record and in job
    // costing, they just never reach an invoice line.
    billable: data.billable ?? true,
    category: (TIME_CATEGORIES as readonly string[]).includes(data.category ?? "") ? data.category! : "onsite",
    workOrderId: t0.workOrderId,
  }).returning();
  await audit({
    actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId, entityType: "time", entityId: row.id,
    action: `logged ${formatHours(minutes)} ${row.category}${row.billable ? "" : ", not billable"} - ${person}${t0.asset ? ` [${assetLabel(t0.asset)}]` : ""}${row.note ? ` - ${row.note}` : ""}`,
  });
  revWork(row);
  return {};
}

/**
 * Money on the job that is neither a part nor an hour: mileage, freight, a
 * night in a motel. Against the work order, because that is what it bills and
 * costs against.
 */
/** This workspace's expense vocabulary, in picker order. */
async function tenantCategories(tenant: number | null) {
  return db.select().from(expenseCategories)
    .where(forTenant(expenseCategories.tenantOrgId, tenant))
    .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.id));
}

/**
 * A kind fit to store: one of this workspace's own category names, or one of
 * the canonical slugs the app itself writes (the travel strip logs
 * "per_diem"), else "other". Free text never lands in the column - a
 * vocabulary that grows by typo is not a vocabulary.
 */
async function cleanKind(kind: string, tenant: number | null): Promise<string> {
  if ((EXPENSE_KINDS as readonly string[]).includes(kind)) return kind;
  const match = (await tenantCategories(tenant)).find((c) => categoryKey(c.name) === categoryKey(kind));
  return match ? match.name : "other";
}

/**
 * The engineer's own point zero: where the stipend radius measures from and
 * where a routed trip starts. Self-service on purpose - it is their home
 * address, so they type it, they can clear it, and nobody else's screen
 * shows it (the trip strip shows miles, never the address).
 *
 * Geocoding happens here, once, at save - never on a render. A failed
 * geocode still saves the text so their typing is not lost, and says so;
 * routed miles simply stay unavailable until an address resolves.
 */
export async function setMyHomeBase(address: string): Promise<{ error?: string; label?: string }> {
  const u = await requireStaff();
  const clean = address.trim().slice(0, 300);
  const [me] = await db.select().from(houseMembers).where(eq(houseMembers.email, u.email.toLowerCase()));
  if (!me) return { error: "Not found" };
  if (!clean) {
    await db.update(houseMembers).set({ homeAddress: "", homeLat: null, homeLng: null })
      .where(eq(houseMembers.id, me.id));
    // Their routed answers start from a place that no longer stands.
    await db.delete(driveCache).where(eq(driveCache.memberEmail, me.email));
    revalidatePath("/inbox");
    return {};
  }
  const hit = await geocode(clean);
  await db.update(houseMembers).set({
    homeAddress: clean, homeLat: hit?.lat ?? null, homeLng: hit?.lng ?? null,
  }).where(eq(houseMembers.id, me.id));
  await db.delete(driveCache).where(eq(driveCache.memberEmail, me.email));
  revalidatePath("/inbox");
  if (!hit) return { error: "Saved the address, but no map provider could place it - routed miles stay off until one can" };
  return { label: hit.label };
}

/**
 * "On my way" - the message every service client wants and no engineer stops
 * to write from a parked van.
 *
 * The browser hands over where the engineer IS (they approve the location
 * prompt; nothing is stored - the coordinates live exactly as long as this
 * call). The route from there to the site gives the ETA - traffic-aware when
 * Google is answering, honest about it when not - and the site's own contact
 * gets one short email from the reports address. The ETA comes back to the
 * caller either way, because "you'll be there around 2:40" is worth showing
 * the driver even when the email could not send.
 */
export async function notifyEnRoute(
  siteId: number,
  from: { lat: number; lng: number },
): Promise<{ error?: string; etaText?: string; sentTo?: string }> {
  const u = await requireStaff();
  if (!Number.isFinite(from.lat) || !Number.isFinite(from.lng)
    || Math.abs(from.lat) > 90 || Math.abs(from.lng) > 180) {
    return { error: "No usable location from the browser" };
  }
  const [site] = await db.select().from(orgSites).where(eq(orgSites.id, siteId));
  if (!site) return { error: "Not found" };
  const t = readTenant(u);
  if (t !== null && site.tenantOrgId !== t) return { error: "Not found" };
  if (site.lat === null || site.lng === null) {
    return { error: "This site has no pin yet - save its address so it can be placed" };
  }
  const route = await drivingRoute(from, { lat: site.lat, lng: site.lng });
  const mins = Math.max(1, Math.round(route.minutes));
  const arrive = new Date(Date.now() + mins * 60_000);
  const tz = process.env.SHOP_TZ || "America/Los_Angeles";
  const at = arrive.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  const qualifier = route.estimated ? " (rough estimate)" : route.traffic ? " with current traffic" : "";
  const etaText = `about ${mins} min - around ${at}${qualifier}`;
  const who = u.name || u.email;

  if (!site.contactEmail) {
    return { etaText, error: "No contact email on this site - ETA computed, nobody to send it to" };
  }
  const brand = await brandForTenant(site.tenantOrgId);
  const html = emailShell({
    brand: brand.operatorName,
    logoUrl: brand.operatorLogoUrl || undefined,
    tagline: "Service visit",
    preheader: `${who} arrives ${etaText}.`,
    width: 520,
    body: `<p style="font-size:14px;line-height:1.6;color:${EMAIL.ink};margin:0;">`
      + `${esc(who)} is on the way to ${esc(siteLabel(site))} - arriving ${esc(etaText)}.`
      + `</p>`,
    footer: `Sent by ${esc(brand.operatorName)}.`,
  });
  try {
    await sendEmail([site.contactEmail], `${brand.operatorName}: ${who} is en route`, html,
      { from: reportFrom(), replyTo: replyToAddress() });
  } catch {
    return { etaText, error: `ETA ${etaText} - but the email to ${site.contactEmail} failed to send` };
  }
  await audit({
    actor: u.email, entityType: "site", entityId: siteId, tenantOrgId: site.tenantOrgId,
    action: `en route to ${siteLabel(site)} - told ${site.contactEmail}, ETA ${etaText}`,
  });
  return { etaText, sentTo: site.contactEmail };
}

export async function addExpenseCategory(name: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const clean = cleanCategoryName(name);
  if (!clean) return { error: "Give it a name" };
  const tenant = readTenant(u);
  const existing = await tenantCategories(tenant);
  if (existing.some((c) => categoryKey(c.name) === categoryKey(clean))) {
    return { error: `${clean} is already on the list` };
  }
  const sortOrder = Math.max(0, ...existing.map((c) => c.sortOrder)) + 1;
  await db.insert(expenseCategories).values({ tenantOrgId: tenant, name: clean, sortOrder, createdBy: u.email });
  await audit({
    actor: u.email, entityType: "settings", entityId: "expense-categories", tenantOrgId: tenant,
    action: `added expense category "${clean}"`,
  });
  revalidatePath("/settings/billing");
  return {};
}

/**
 * Rename changes the PICKER, not history: rows already logged keep the name
 * they were logged under, because what a cost was called is a fact about the
 * day it happened. Same rule as delete, and worth stating twice.
 */
export async function renameExpenseCategory(id: number, name: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const clean = cleanCategoryName(name);
  if (!clean) return { error: "Give it a name" };
  const tenant = readTenant(u);
  const rows = await tenantCategories(tenant);
  const row = rows.find((c) => c.id === id);
  if (!row) return { error: "Not found" };
  if (rows.some((c) => c.id !== id && categoryKey(c.name) === categoryKey(clean))) {
    return { error: `${clean} is already on the list` };
  }
  await db.update(expenseCategories).set({ name: clean }).where(eq(expenseCategories.id, id));
  await audit({
    actor: u.email, entityType: "settings", entityId: "expense-categories", tenantOrgId: tenant,
    action: `renamed expense category "${row.name}" to "${clean}"`,
  });
  revalidatePath("/settings/billing");
  return {};
}

export async function deleteExpenseCategory(id: number): Promise<{ error?: string }> {
  const u = await requireOwner();
  const tenant = readTenant(u);
  const row = (await tenantCategories(tenant)).find((c) => c.id === id);
  if (!row) return { error: "Not found" };
  await db.delete(expenseCategories).where(eq(expenseCategories.id, id));
  await audit({
    actor: u.email, entityType: "settings", entityId: "expense-categories", tenantOrgId: tenant,
    action: `deleted expense category "${row.name}" - logged rows keep the name`,
  });
  revalidatePath("/settings/billing");
  return {};
}

/**
 * Put the starter set on this workspace's shelf - only the names it does not
 * already have, so pressing it twice adds nothing and a renamed category is
 * never resurrected under its old name.
 */
export async function loadStarterCategories(): Promise<{ error?: string; added?: number }> {
  const u = await requireOwner();
  const tenant = readTenant(u);
  const existing = await tenantCategories(tenant);
  const missing = missingStarters(existing);
  if (missing.length) {
    const from = Math.max(0, ...existing.map((c) => c.sortOrder));
    await db.insert(expenseCategories).values(missing.map((name, i) => ({
      tenantOrgId: tenant, name, sortOrder: from + i + 1, createdBy: u.email,
    })));
    await audit({
      actor: u.email, entityType: "settings", entityId: "expense-categories", tenantOrgId: tenant,
      action: `loaded ${missing.length} starter expense categories`,
    });
  }
  revalidatePath("/settings/billing");
  return { added: missing.length };
}

export async function logExpense(
  workOrderId: number,
  data: {
    kind: string; description: string; amount: string; incurredOn: string; billable?: boolean;
    /** Which of the client's labs the trip served. */
    siteId?: number | null;
  },
): Promise<{ error?: string }> {
  const u = await requireEditor();
  const cents = parseMoney(data.amount);
  if (cents === null || cents <= 0) return { error: "Enter an amount like 43.00" };
  const date = data.incurredOn.trim();
  if (!isIsoDay(date)) return { error: "Pick the date it was incurred" };
  const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, workOrderId));
  if (!wo) return { error: "Not found" };
  await assertWorkEditable(u, wo);
  const kind = await cleanKind(data.kind, wo.tenantOrgId);
  // The site must be one of THIS client's labs - a stamp that pointed at
  // another client's building would be wrong twice over.
  let siteId: number | null = null;
  if (data.siteId != null) {
    const [site] = await db.select().from(orgSites).where(eq(orgSites.id, data.siteId));
    if (site && site.orgId === wo.orgId) siteId = site.id;
  }
  const [row] = await db.insert(expenses).values({
    tenantOrgId: wo.tenantOrgId, workOrderId, siteId,
    kind, description: data.description.trim(), amountCents: cents,
    incurredOn: date, billable: data.billable ?? true, loggedBy: u.email,
  }).returning();
  await audit({
    actor: u.email, instrumentId: wo.instrumentId, assetId: wo.assetId,
    entityType: "expense", entityId: row.id,
    action: `logged a ${kind} expense of ${formatCents(cents)} on ${wo.number}${row.description ? ` - ${row.description}` : ""}`,
  });
  revalidatePath(`/work/${workOrderId}`);
  return {};
}

export async function deleteExpense(id: number, reason: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [row] = await db.select().from(expenses).where(eq(expenses.id, id));
  if (!row) return {};
  // Overhead rows have no job to check against, so the tenant stamp is the
  // whole authorization; job rows still answer to their work order.
  let wo: typeof workOrders.$inferSelect | undefined;
  if (row.workOrderId === null) {
    const t = readTenant(u);
    if (t !== null && row.tenantOrgId !== t) return {};
  } else {
    [wo] = await db.select().from(workOrders).where(eq(workOrders.id, row.workOrderId));
    if (wo) await assertWorkEditable(u, wo);
  }
  await db.delete(expenses).where(eq(expenses.id, id));
  await audit({
    actor: u.email, instrumentId: wo?.instrumentId ?? null, assetId: wo?.assetId ?? null,
    entityType: "expense", entityId: id, tenantOrgId: row.tenantOrgId,
    action: `removed a ${row.kind} expense of ${formatCents(row.amountCents)} - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revalidatePath(row.workOrderId === null ? "/money/expenses" : `/work/${row.workOrderId}`);
  return {};
}

/**
 * Money the business spent that no job caused - an engineer's internet bill,
 * a software seat, the shop's own postage. It lands in the same table as job
 * expenses with NULL where the work order would be, which is the entire
 * difference: overhead never reaches an invoice draft (those are built from a
 * work order's expenses) and never joins a job's margin. What it feeds is the
 * monthly ledger at /money/expenses.
 *
 * `person` is who gets reimbursed, validated against the directory like every
 * other field that names somebody - see logOffSystemWork for the argument.
 */
export async function logOverheadExpense(
  data: { kind: string; description: string; amount: string; incurredOn: string; person: string },
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const cents = parseMoney(data.amount);
  if (cents === null || cents <= 0) return { error: "Enter an amount like 43.00" };
  const date = data.incurredOn.trim();
  if (!isIsoDay(date)) return { error: "Pick the date it was incurred" };
  const description = data.description.trim();
  if (!description) return { error: "Say what it was - a bare amount is unreadable in a month" };
  const person = data.person.trim();
  if (person && !(await assignableNames(u)).has(person)) return { error: "Unknown person" };
  const kind = await cleanKind(data.kind, readTenant(u));
  const [row] = await db.insert(expenses).values({
    tenantOrgId: readTenant(u), workOrderId: null,
    kind, description, amountCents: cents,
    incurredOn: date, billable: false, person, loggedBy: u.email,
  }).returning();
  await audit({
    actor: u.email, entityType: "expense", entityId: row.id, tenantOrgId: row.tenantOrgId,
    action: `logged ${formatCents(cents)} of overhead - ${description}${person ? ` (${person})` : ""}`,
  });
  revalidatePath("/money/expenses");
  return {};
}

// ── Expense reports ─────────────────────────────────────────────────────────
// The reimbursement lifecycle: an engineer batches their expenses into a
// report, the owner pays it or returns it. The report never stores a total -
// it is summed from its rows, so an edit before payout can never leave a
// stale number for the payout to trust. lib/expenseReports owns the rules.

/**
 * Log an expense from the Expenses desk itself.
 *
 * The desk is where an engineer empties their pockets at the end of a trip,
 * so it takes the receipt right here instead of sending them to find the
 * right work order page first. The job is a PICKER, not a requirement: any
 * work order in the tenant, open or closed - a receipt often surfaces after
 * the job it belongs to is wrapped - or none at all, which files it as
 * overhead the way the internet bill is.
 *
 * The row is stamped with MY name whichever way it goes, so it lands in my
 * reimbursement pool - that is the difference from logExpense on the work
 * order, which leaves person blank because it is recording job cost, not a
 * personal claim.
 */
export async function logMyExpense(
  data: {
    kind: string; description: string; amount: string; incurredOn: string; workOrderId: number | null;
    receiptUrl?: string; receiptName?: string;
    /** Land it straight on one of my open reports instead of the pool. */
    reportId?: number | null;
  },
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const cents = parseMoney(data.amount);
  if (cents === null || cents <= 0) return { error: "Enter an amount like 43.00" };
  const date = data.incurredOn.trim();
  if (!isIsoDay(date)) return { error: "Pick the date it was incurred" };
  if (date > shopToday()) return { error: "That date is in the future" };
  const description = data.description.trim();
  if (!description) return { error: "Say what it was - a bare amount is unreadable in a month" };
  const t = readTenant(u);
  let workOrderId: number | null = null;
  if (data.workOrderId !== null) {
    const [wo] = await db.select().from(workOrders)
      .where(and(eq(workOrders.id, data.workOrderId), forTenant(workOrders.tenantOrgId, t)));
    if (!wo) return { error: "That work order is not one of ours" };
    workOrderId = wo.id;
  }
  const kind = await cleanKind(data.kind, t);
  let reportId: number | null = null;
  if (data.reportId != null) {
    const [report] = await db.select().from(expenseReports).where(eq(expenseReports.id, data.reportId));
    if (!report || report.person !== u.name) return { error: "Not your report" };
    if (!editableReport(report.status)) return { error: `That report is ${report.status} - it cannot take new rows` };
    reportId = report.id;
  }
  const [row] = await db.insert(expenses).values({
    tenantOrgId: t, workOrderId, kind, description, amountCents: cents, incurredOn: date,
    // On a job it defaults to rebillable, same as the work order form; with no
    // job there is nobody to rebill - it is overhead, like the internet bill.
    billable: workOrderId !== null,
    person: u.name, loggedBy: u.email, reportId,
    receiptUrl: (data.receiptUrl ?? "").trim().slice(0, 500),
    receiptName: (data.receiptName ?? "").trim().slice(0, 200),
  }).returning();
  await audit({
    actor: u.email, entityType: "expense", entityId: row.id, tenantOrgId: row.tenantOrgId,
    action: `logged ${formatCents(cents)} - ${description}`
      + (workOrderId !== null ? ` on a work order` : " (no job - overhead)"),
  });
  revalidatePath("/money/reimbursements");
  if (reportId !== null) revalidatePath(`/money/reimbursements/${reportId}`);
  revalidatePath("/money/expenses");
  if (workOrderId !== null) revalidatePath(`/work/${workOrderId}`);
  return {};
}

/** Open a fresh draft report to fill - the container the receipts land in. */
export async function createExpenseReport(): Promise<{ error?: string; id?: number }> {
  const u = await requireStaff();
  const [report] = await db.insert(expenseReports).values({
    tenantOrgId: readTenant(u), person: u.name, status: "draft", submittedBy: u.email,
  }).returning();
  await audit({
    actor: u.email, entityType: "expense_report", entityId: report.id, tenantOrgId: report.tenantOrgId,
    action: "opened a draft expense report",
  });
  revalidatePath("/money/reimbursements");
  return { id: report.id };
}

/** Pull rows from my unclaimed pool onto one of my open reports. */
export async function attachPoolExpenses(
  reportId: number, expenseIds: number[],
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [report] = await db.select().from(expenseReports).where(eq(expenseReports.id, reportId));
  if (!report || report.person !== u.name) return { error: "Not your report" };
  if (!editableReport(report.status)) return { error: `That report is ${report.status} - it cannot take new rows` };
  const ids = [...new Set(expenseIds)].filter((n) => Number.isInteger(n));
  if (!ids.length) return { error: "Pick at least one expense" };
  const rows = await db.select().from(expenses)
    .where(and(inArray(expenses.id, ids), forTenant(expenses.tenantOrgId, readTenant(u))));
  const mine = reimbursementPool(rows, { name: u.name, email: u.email });
  if (mine.length !== ids.length) {
    return { error: "Some of those are not yours to claim, or are already on a report" };
  }
  await db.update(expenses).set({ reportId }).where(inArray(expenses.id, ids));
  revalidatePath("/money/reimbursements");
  revalidatePath(`/money/reimbursements/${reportId}`);
  return {};
}

/** Take a row off one of my open reports - back to the pool, not deleted. */
export async function removeReportExpense(expenseId: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [row] = await db.select().from(expenses).where(eq(expenses.id, expenseId));
  if (!row || row.reportId === null) return {};
  const [report] = await db.select().from(expenseReports).where(eq(expenseReports.id, row.reportId));
  if (!report || (report.person !== u.name && u.role !== "owner")) return { error: "Not your report" };
  if (!editableReport(report.status)) return { error: `That report is ${report.status} - its rows are fixed` };
  await db.update(expenses).set({ reportId: null }).where(eq(expenses.id, expenseId));
  revalidatePath("/money/reimbursements");
  revalidatePath(`/money/reimbursements/${report.id}`);
  return {};
}

/**
 * Send my draft (or a returned report, fixed) in for payout.
 *
 * Same word from either starting point on purpose: a returned report is not a
 * different kind of thing, it is the same claim going around again.
 */
export async function submitDraftReport(reportId: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [report] = await db.select().from(expenseReports).where(eq(expenseReports.id, reportId));
  if (!report || report.person !== u.name) return { error: "Not your report" };
  if (!editableReport(report.status)) return { error: `It is already ${report.status}` };
  const rows = await db.select().from(expenses).where(eq(expenses.reportId, reportId));
  if (!rows.length) return { error: "There is nothing on this report to submit" };
  await db.update(expenseReports).set({ status: "submitted", returnedReason: "" })
    .where(eq(expenseReports.id, reportId));
  await audit({
    actor: u.email, entityType: "expense_report", entityId: reportId, tenantOrgId: report.tenantOrgId,
    action: `submitted ${rows.length} expense${rows.length === 1 ? "" : "s"} (${formatCents(reportTotalCents(rows))}) for reimbursement`
      + (report.status === "returned" ? " (resubmitted after a return)" : ""),
  });
  revalidatePath("/money/reimbursements");
  revalidatePath(`/money/reimbursements/${reportId}`);
  return {};
}

/** Throw away one of my empty-handed drafts. Its rows return to the pool first. */
export async function deleteExpenseReport(id: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [report] = await db.select().from(expenseReports).where(eq(expenseReports.id, id));
  if (!report) return {};
  if (report.person !== u.name && u.role !== "owner") return { error: "Not yours to delete" };
  if (!editableReport(report.status)) return { error: `It is ${report.status} - withdraw it first` };
  await db.update(expenses).set({ reportId: null }).where(eq(expenses.reportId, id));
  await db.delete(expenseReports).where(eq(expenseReports.id, id));
  await audit({
    actor: u.email, entityType: "expense_report", entityId: id, tenantOrgId: report.tenantOrgId,
    action: `deleted ${report.person}'s draft expense report - its expenses are back in the pool`,
  });
  revalidatePath("/money/reimbursements");
  return {};
}

/**
 * Submit my expenses as one reimbursement claim.
 *
 * The ids are re-checked against MY pool on the server: rows already on a
 * report are refused (the same receipt on two reports is the same money paid
 * twice), and rows that belong to somebody else are not mine to claim,
 * whatever the client sent.
 */
export async function submitExpenseReport(
  expenseIds: number[], note = "",
): Promise<{ error?: string; id?: number }> {
  const u = await requireStaff();
  const ids = [...new Set(expenseIds)].filter((n) => Number.isInteger(n));
  if (!ids.length) return { error: "Pick at least one expense" };
  const t = readTenant(u);
  const rows = await db.select().from(expenses)
    .where(and(inArray(expenses.id, ids), forTenant(expenses.tenantOrgId, t)));
  const mine = reimbursementPool(rows, { name: u.name, email: u.email });
  if (mine.length !== ids.length) {
    return { error: "Some of those are not yours to claim, or are already on a report" };
  }
  const total = reportTotalCents(mine);
  const [report] = await db.insert(expenseReports).values({
    tenantOrgId: t, person: u.name, status: "submitted",
    submittedBy: u.email, note: note.trim().slice(0, 500),
  }).returning();
  await db.update(expenses).set({ reportId: report.id }).where(inArray(expenses.id, ids));
  await audit({
    actor: u.email, entityType: "expense_report", entityId: report.id, tenantOrgId: t,
    action: `submitted ${ids.length} expense${ids.length === 1 ? "" : "s"} (${formatCents(total)}) for reimbursement`,
  });
  revalidatePath("/money/reimbursements");
  revalidatePath("/money/expenses");
  return { id: report.id };
}

/** Take my own unpaid report back to draft - rows stay on it, editable again. */
export async function withdrawExpenseReport(id: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [report] = await db.select().from(expenseReports).where(eq(expenseReports.id, id));
  if (!report) return { error: "Not found" };
  if (report.person !== u.name && u.role !== "owner") return { error: "Not yours to withdraw" };
  if (report.status !== "submitted") return { error: `It is ${report.status} - there is nothing to take back` };
  await db.update(expenseReports).set({ status: "draft" }).where(eq(expenseReports.id, id));
  await audit({
    actor: u.email, entityType: "expense_report", entityId: id, tenantOrgId: report.tenantOrgId,
    action: `withdrew ${report.person}'s expense report back to draft`,
  });
  revalidatePath("/money/reimbursements");
  revalidatePath(`/money/reimbursements/${id}`);
  return {};
}

/**
 * Pay a report. Owner only: this is the company writing a check.
 *
 * It marks, it does not move money - the check or the payroll run happens
 * wherever it happens, and this records that it did, with the reference the
 * engineer can chase it by.
 */
export async function payExpenseReport(
  id: number, data: { paidOn: string; reference: string },
): Promise<{ error?: string }> {
  const u = await requireOwner();
  const [report] = await db.select().from(expenseReports).where(eq(expenseReports.id, id));
  if (!report) return { error: "Not found" };
  // requireOwner is "an owner of some service company", and expense_reports is
  // one instance-wide table - so without this an owner could mark another
  // workspace's report paid, closing a claim their engineer is still waiting
  // on and writing the payout against a company that never paid it.
  if (!houseOf(u, report.tenantOrgId)) return { error: "Not found" };
  if (report.status !== "submitted") return { error: `This report is ${report.status}, not awaiting payout` };
  const day = data.paidOn.trim();
  if (!isIsoDay(day)) return { error: "Pick the date it was paid" };
  if (day > shopToday()) return { error: "That date is in the future" };
  const rows = await db.select().from(expenses).where(eq(expenses.reportId, id));
  const total = reportTotalCents(rows);
  await db.update(expenseReports).set({
    status: "paid", paidOn: day, paidBy: u.email, paidRef: data.reference.trim().slice(0, 120),
  }).where(eq(expenseReports.id, id));
  await audit({
    actor: u.email, entityType: "expense_report", entityId: id, tenantOrgId: report.tenantOrgId,
    action: `paid ${report.person} ${formatCents(total)} for ${rows.length} expense${rows.length === 1 ? "" : "s"}`
      + (data.reference.trim() ? ` (${data.reference.trim()})` : "") + `, ${day}`,
  });
  revalidatePath("/money/reimbursements");
  revalidatePath(`/money/reimbursements/${id}`);
  return {};
}

/**
 * Send a report back. Its rows STAY on it - the engineer fixes the claim in
 * place and resubmits the same report, rather than reassembling it from the
 * pool - and the reason rides on the report where they will read it.
 */
export async function returnExpenseReport(id: number, reason: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [report] = await db.select().from(expenseReports).where(eq(expenseReports.id, id));
  if (!report) return { error: "Not found" };
  if (report.status !== "submitted") return { error: `This report is ${report.status}, not awaiting payout` };
  await db.update(expenseReports).set({ status: "returned", returnedReason: why }).where(eq(expenseReports.id, id));
  await audit({
    actor: u.email, entityType: "expense_report", entityId: id, tenantOrgId: report.tenantOrgId,
    action: `returned ${report.person}'s expense report - ${why}`,
  });
  revalidatePath("/money/reimbursements");
  revalidatePath(`/money/reimbursements/${id}`);
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
    // The acknowledgement belongs to the leg that is ending, so it clears with
    // it: a client who dismissed the last handback must still be told about
    // this one. See ackQueueHandback.
    .set({
      queueOrgId: toOrgId, queueReason: why, queueSince: new Date(),
      queueAckAt: null, queueAckBy: "",
    })
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
 * "Yes, I have seen that" - the holder dismisses the handback line.
 *
 * A queue position is a standing fact; a handback is a notification, and the
 * two were being shown as the same thing. "Back with you since Tuesday,
 * nothing is pending on it" earns the top of the record once. On the fortieth
 * visit it is furniture, and furniture at the top of a record is how people
 * learn to skip the top of the record - which is exactly where the line that
 * DOES matter will appear next time.
 *
 * So it is dismissible, and the dismissal is recorded rather than hidden in a
 * browser: it is the only signal the shop gets that a handback actually landed
 * with a human. That is also what pays for the gap left open when the queue
 * stopped raising a chore on every held system - a nudge that goes unread now
 * shows as unread.
 *
 * Only the holder may dismiss it, because it is only being said to them.
 * Whoever holds it, not whoever may move it: canKick deliberately also admits
 * the operator and the owner, and neither of them is the audience for this.
 */
export async function ackQueueHandback(instrumentId: number): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  if (!(await canSeeSystemSafe(u, instrumentId))) return { error: "Not found" };
  // A null queue org is the house's own queue, which staff hold.
  const holding = inst.queueOrgId === null ? isStaffRole(u.role) : u.orgId === inst.queueOrgId;
  if (!holding) return { error: "Only whoever is holding it can dismiss that" };
  // Already dismissed by a colleague. Not an error - the line is gone either
  // way, and the first name on it is the one worth keeping.
  if (inst.queueAckAt) return {};
  await db.update(instruments)
    .set({ queueAckAt: new Date(), queueAckBy: u.email })
    .where(eq(instruments.id, instrumentId));
  /* No audit line on purpose. The activity log is every field anybody ever
     edited, and a read receipt is not an edit to the record - it is a fact
     ABOUT the record's delivery, which the two columns already carry in the
     one place anybody would look for it. */
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
  // Whose record it is decides who may move it. requireStaff() admits every
  // operator's people, so without this the id was the whole authorization -
  // and a handoff deletes the outgoing owner's share, so the lab that owns
  // the instrument opens the portal and the record is simply gone.
  if (!houseOf(u, inst.tenantOrgId)) return { error: "Not found" };
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
  // Same rule as handOffSystem: the record's workspace, not the actor's role.
  if (!houseOf(u, inst.tenantOrgId)) return { error: "Not found" };
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

  // This workspace's fleet, and only this workspace's. Unscoped, an external id
  // that happened to match another operator's system did two bad things at
  // once: it hung the imported assets off THEIR record, and it reported the
  // collision back to the importer - a serial from a book they cannot open.
  const tenant = readTenant(u);
  const existing = await db.select({ id: instruments.id, externalId: instruments.externalId })
    .from(instruments).where(forTenant(instruments.tenantOrgId, tenant));
  const byExt = new Map(existing.map((i) => [i.externalId.toLowerCase(), i.id]));
  const extOf = new Map(existing.map((i) => [i.id, i.externalId]));
  const createdThisRun = new Map<string, number>(); // externalId -> new instrument id
  const results: ImportRowResult[] = [];
  let systemsMade = 0, assetsMade = 0, skippedDupes = 0;

  // Duplicate protection. Re-importing a sheet used to double the fleet; now a
  // row that already exists is skipped and says what it matched. Keyed on the
  // system's EXTERNAL id rather than its row id, because rows landing in a
  // system this run is about to create have no row id yet.
  // Same scope, for the same reason: describeKey below turns these into the
  // "already imported as ..." lines the caller reads back.
  const priorAssets = await db.select({
    id: assets.id, instrumentId: assets.instrumentId, kind: assets.kind, model: assets.model,
    serial: assets.serial, owner: assets.owner, location: assets.location,
  }).from(assets).where(forTenant(assets.tenantOrgId, tenant));
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
    // Against this workspace's catalog. Matching another's meant the term was
    // recorded as already known and never registered here, so the import
    // finished with equipment no picker on this instance could name.
    const vocab = await db.select().from(vocabTerms)
      .where(forTenant(vocabTerms.tenantOrgId, tenant));
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
    jar.set(VIEW_AS_COOKIE, personaCookie({ kind: "role", orgId, role: mode === "viewer" ? "client_viewer" : "client_editor" }), {
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

/**
 * Stand in one named person's shoes - read-only.
 *
 * The difference from setViewAs is not a degree, it is a kind. A role persona
 * answers "what does an editor at Lab Zen see"; this answers "what does BILL
 * see", which is the only question that reaches his saved panel layout, the
 * jobs assigned to him, his read state and the per-person flags on his
 * account. An engineer's glitch that the operator cannot reproduce is almost
 * always in one of those, and none of them were reachable before.
 *
 * Read-only, enforced in lib/authz rather than here: reproducing somebody's
 * screen must not be able to act in their name, and the owner's own account is
 * one click away for anything that genuinely needs doing.
 */
export async function setViewAsPerson(email: string | null): Promise<{ error?: string }> {
  const real = await requireRealOwner();
  const jar = await cookies();
  if (email === null) {
    jar.delete(VIEW_AS_COOKIE);
    revalidatePath("/", "layout");
    return {};
  }
  const wanted = email.trim().toLowerCase();
  if (wanted === real.email.trim().toLowerCase()) {
    return { error: "That is you - there is nothing to stand in" };
  }
  /* Resolved the way a sign-in resolves, NOT by looking for a users row. An
     account row is only written at first sign-in, so requiring one refused
     exactly the person this was built for: a staff member who exists in
     house_members and has never logged in. */
  const theirs = await signInIdentity(wanted);
  const [row] = await db.select({ name: users.name }).from(users).where(eq(users.email, wanted));
  if (!theirs.role && theirs.orgId === null) return { error: "No account with that address" };
  const shownName = row?.name || wanted.split("@")[0];
  /* Only people this owner is entitled to see at all. The platform's owner
     runs the instance and may shadow anybody on it; a second operator's owner
     runs their own workspace, and another company's engineer is not theirs to
     look through. */
  if (!isPlatformStaff(tenantViewer(real))) {
    const mine = await visibleOrgs(real);
    const ok = theirs.operatorOrgId === real.operatorOrgId
      || (theirs.orgId !== null && mine.some((o) => o.id === theirs.orgId));
    if (!ok) return { error: "Not found" };
  }
  jar.set(VIEW_AS_COOKIE, personaCookie({ kind: "person", email: wanted }), {
    httpOnly: true, sameSite: "lax", path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 8,
  });
  await audit({
    actor: real.email, entityType: "settings", entityId: "view_as",
    action: `started viewing the portal as ${shownName} (read-only)`,
  });
  revalidatePath("/", "layout");
  return {};
}

/**
 * Everybody this owner may stand in for, for the picker.
 *
 * Grouped by organization on the way out, because "Sierra Spectra, then Bill"
 * is how somebody thinks about it - and because a flat list of every account
 * on the instance is a list nobody scrolls.
 */
export async function viewAsPeople(): Promise<{
  email: string; name: string; role: string; orgName: string;
}[]> {
  const real = await requireRealOwner();
  const platform = isPlatformStaff(tenantViewer(real));
  const mine = platform ? [] : await visibleOrgs(real);
  const brand = await getBrand();

  /* Everybody with a way in, not everybody who has used it. An account row is
     only written at first sign-in, so a staff member who has never logged in -
     which is exactly the person whose setup you would want to check - exists
     only in house_members or the client allowlist. Reading users alone left
     the engineers out of the list, which is who this was built for. */
  const [userRows, houseRows, allowRows] = await Promise.all([
    db.select({ email: users.email, name: users.name }).from(users)
      .orderBy(asc(users.email)).catch(() => []),
    // Read directly, not through listHouseMembers: that returns ONE workspace's
    // roster now, and this picker is platform-only (see layout.tsx) and wants
    // every staff account on the instance. The per-address filter below still
    // decides who this viewer may actually stand in for.
    db.select({ email: houseMembers.email, name: houseMembers.name })
      .from(houseMembers).catch(() => []),
    db.select({ entry: clientAllowlist.entry, orgId: clientAllowlist.orgId, orgName: orgs.name })
      .from(clientAllowlist).leftJoin(orgs, eq(orgs.id, clientAllowlist.orgId)).catch(() => []),
  ]);

  const named = new Map<string, string>();
  for (const r of userRows) named.set(r.email.trim().toLowerCase(), r.name ?? "");
  for (const h of houseRows) if (!named.get(h.email)) named.set(h.email.trim().toLowerCase(), h.name ?? "");

  const emails = new Set<string>([
    ...userRows.map((r) => r.email.trim().toLowerCase()),
    ...houseRows.map((h) => h.email.trim().toLowerCase()),
    // Exact addresses only: an "@acme.com" rule is a door, not a person.
    ...allowRows.map((a) => a.entry.trim().toLowerCase()).filter((e) => e && !e.startsWith("@")),
  ]);

  const me = real.email.trim().toLowerCase();
  const out: { email: string; name: string; role: string; orgName: string }[] = [];
  for (const email of [...emails].sort()) {
    if (!email || email === me) continue;
    const who = await signInIdentity(email);
    if (!platform) {
      const ok = who.operatorOrgId === real.operatorOrgId
        || (who.orgId !== null && mine.some((o) => o.id === who.orgId));
      if (!ok) continue;
    }
    out.push({
      email,
      name: named.get(email) || email.split("@")[0],
      role: who.role || "client_viewer",
      // Staff have no client org, so they list under the company they work
      // for rather than under a blank heading.
      orgName: who.orgName || brand.operatorName,
    });
  }
  return out;
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
  // The TARGET org was validated against visibleOrgs below and the asset never
  // was, so this repointed any workspace's shelf unit at one of the caller's
  // own client orgs - which then gains see, and edit for a client_editor.
  if (!houseOf(u, asset.tenantOrgId)) return { error: "Not found" };
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

/**
 * The record's tenant was not even in this signature. `isHouse(u.role)` is
 * true for every operator's people, and setForSale RETURNS the listing token -
 * so any operator's owner could list another workspace's client's instrument
 * and be handed the public URL. /listing/<token> takes no session, and
 * lib/fileAccess makes any showOnListing attachment anonymously downloadable
 * the moment forSale is true.
 */
function canSell(u: SessionUser, inst: { ownerOrgId: number | null; tenantOrgId: number | null }): boolean {
  if (houseOf(u, inst.tenantOrgId)) return true;
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
  // The record first. `isHouse(u.role)` used to open this function, and it is
  // role === "owner" || role === "staff" - true for EVERY operator's people,
  // so an engineer at one workspace could approve or deny a request against
  // another's system by id. The read side of this was scoped in 5369210; the
  // decision was left behind.
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) throw new Error("Not found");
  if (kind === "claim") {
    // A claim asserts "this instrument is ours", so the servicing workspace is
    // not neutral about it either - schema.ts says only the platform operator
    // may grant one, "since approving one moves ownership", and that is also
    // what makes a wrongly granted claim fixable by somebody.
    if (!isPlatformStaff(tenantViewer(u))) throw new Error("Not found");
    return;
  }
  // The house of the record's OWN workspace, not of any workspace.
  if (houseOf(u, inst.tenantOrgId)) return;
  if (inst.ownerOrgId === null || inst.ownerOrgId !== u.orgId || u.role !== "client_editor") {
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
  // This moves ownership and mints an edit share, and it never went through the
  // decider at all - requireStaff was the whole test, so any operator's staff
  // could grant a claim against any workspace's system. SystemPanel paints the
  // button from a plain isOperator boolean, so it was on screen for them too.
  try { await assertRequestDecider(u, req.instrumentId, "claim"); } catch { return { error: "Not found" }; }
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
export async function setBranding(
  data: { name: string; tagline: string; contactEmail?: string },
): Promise<{ error?: string }> {
  const u = await requirePlatformOwner();
  const name = data.name.trim().slice(0, 60);
  const tagline = data.tagline.trim().slice(0, 80);
  const contact = (data.contactEmail ?? "").trim().slice(0, 120);
  if (!name) return { error: "Give the platform a name" };
  // Blank is a valid answer - it takes the enquiry buttons off the landing
  // page. A typo is not: a public "talk to us" that bounces is worse than no
  // button, because nobody finds out it happened.
  if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contact)) {
    return { error: "That contact address does not look like an email" };
  }
  const patch = { platformName: name, platformTagline: tagline, publicContactEmail: contact };
  await db.insert(appSettings).values({ id: 1, ...patch })
    .onConflictDoUpdate({ target: appSettings.id, set: patch });
  await audit({
    actor: u.email, entityType: "settings", entityId: "branding",
    action: `renamed the platform to "${name}"${tagline ? ` (${tagline})` : ""}`,
    field: "platform_name", newValue: name,
  });
  revalidatePath("/", "layout");
  return {};
}

/**
 * How the platform looks: the header bar, and the spectrum above it.
 *
 * Validated here and not only in the form, because these values are written
 * into a style attribute on every page - a colour that is not a colour is a
 * way to write CSS onto the whole app, so what reaches the column has been
 * through lib/appearance first. Blank is stored for anything that is the stock
 * look, so an instance that never expressed a preference follows the default
 * if it ever moves.
 */
export async function setPlatformAppearance(data: {
  headerColor: string; spectrumHeight: number; spectrumStops: Stop[];
}): Promise<{ error?: string }> {
  const u = await requirePlatformOwner();
  const raw = data.headerColor.trim();
  if (raw && !isValidHex(raw)) return { error: "The header color needs to be a hex like #1D9E75" };
  const headerColor = raw ? raw.toUpperCase() : "";
  const spectrumHeight = clampHeight(data.spectrumHeight);
  const spectrumStops = serializeStops(data.spectrumStops);
  const row = { headerColor, spectrumHeight, spectrumStops };
  await db.insert(appSettings).values({ id: 1, ...row })
    .onConflictDoUpdate({ target: appSettings.id, set: row });
  await audit({
    actor: u.email, entityType: "settings", entityId: "appearance",
    action: `platform appearance: header ${headerColor || "default"}, spectrum ${spectrumHeight}px`
      + ` with ${spectrumStops ? JSON.parse(spectrumStops).length : DEFAULT_STOPS.length} stops`,
    field: "header_color", newValue: headerColor,
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
  // The one that watches people rather than machines. See lib/trail.
  trail: { col: "trailEnabled", label: "activity trail" },
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

/**
 * Turn the calendar feed on (minting or rotating its secret) or off.
 *
 * The URL is the credential, so this is owner work: minting hands out a key
 * to every dated fact in the shop, and rotating revokes every copy at once.
 *
 * NOTE: with a platform operator that is not itself a service company, the feed
 * this mints is that platform workspace's - which has no systems. See the route
 * for why, and what the per-operator fix looks like. Leave the module off until
 * then.
 *
 * PLATFORM owner, specifically. The token is a single column on app_settings,
 * so there is one feed for the instance and it is the instance operator's.
 * Under requireOwner() a second operator's owner could mint it - handing
 * themselves a standing export of somebody else's calendar - and rotating it
 * would silently kill the first operator's subscription on every phone.
 */
export async function setCalendarFeed(on: boolean): Promise<{ error?: string; token?: string }> {
  const u = await requirePlatformOwner();
  const token = on ? crypto.randomBytes(18).toString("base64url") : "";
  await db.update(appSettings).set({ calendarToken: token }).where(eq(appSettings.id, 1));
  await audit({
    actor: u.email, entityType: "settings", entityId: "calendar_feed",
    action: on ? "minted a calendar feed link (any old link is dead)" : "turned the calendar feed off",
  });
  revalidatePath("/calendar");
  return { token };
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

/**
 * The four lockout rules from memberGuard, plus the one it cannot know: WHOSE
 * staff this is.
 *
 * house_members is one instance-wide table keyed on email, and requireOwner
 * means "an owner of some service company" - so without this an owner of any
 * workspace could rewrite, revoke, or mint a temporary password for another
 * workspace's engineer, and then sign in as them. memberGuard refuses exactly
 * three subjects (the STAFF_EMAILS root owner, yourself, the last owner) and
 * none of them is a tenant, so the root owner was the only person on the
 * instance this did not reach.
 *
 * `mine` is myTenantOrgId - "my own workspace's people" - which is what the
 * siblings setHouseTempPassword and clearHouseTempPassword already test, and
 * what listHouseMembers filters by. Null is platform staff, who administer
 * everybody. A subject with no org is nobody's staff yet; only platform staff
 * may claim one, because there is nothing on the row that says whose it is.
 */
async function guardFor(
  actor: SessionUser,
  subjectEmail: string,
  next: "owner" | "staff" | "revoke",
) {
  const members = await houseMemberRows();
  const base = memberGuard({
    actorEmail: actor.email, subjectEmail, next,
    envStaff: parseList(process.env.STAFF_EMAILS), members,
  });
  if (!base.ok) return { members, guard: base };
  // Platform staff administer every workspace - the same support path
  // listHouseMembers already takes, and the reason readTenant returns null for
  // them. Without this the tenant test below caught them too: myTenantOrgId is
  // never null on a configured instance, so the platform's own administrator
  // could not touch a tenant's staff at all.
  const mine = isPlatformStaff(tenantViewer(actor as SessionUser)) ? null : actor.operatorOrgId;
  if (mine !== null) {
    // Only an EXISTING row can belong to somebody else. No row means this is a
    // new hire, and the insert below stamps them with myTenantOrgId(u) - the
    // actor's own workspace - so refusing here would break adding staff at all.
    const subject = members.find((m) => m.email.trim().toLowerCase() === subjectEmail.trim().toLowerCase());
    if (subject && (subject.orgId ?? null) !== mine) {
      // Same words a missing row gets: whether another workspace employs this
      // address is not something to confirm by the shape of the refusal.
      return { members, guard: { ok: false as const, error: "Not found" } };
    }
  }
  return { members, guard: base };
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
/**
 * Which half of the app I work in.
 *
 * MINE TO SET, and nobody else's. It changes which question a page leads with
 * - is the equipment running, or is the stock moving - and changes nothing at
 * all about what I may see or do, so it is not something an operator grants or
 * an owner administers. Blank puts me back on my company's own setting, which
 * is where everybody starts and where almost everybody stays.
 *
 * Not audited, for the same reason: a preference about my own screen is not an
 * act on the record, and a trail full of "changed their view" is a trail
 * somebody has to read past to find the changes that mattered.
 */
/**
 * Where a person STARTS, set by the operator before they ever sign in.
 *
 * The reason this exists rather than leaving everybody on their company's
 * default: a COO put in charge of the equipment at a reselling company should
 * not have to find a menu on his first morning to stop being shown a pipeline
 * of stock. Somebody who already knows what he does can say so for him.
 *
 * It is a STARTING point and nothing more. The moment he chooses for himself
 * (setMyViewMode) his answer wins and this stops mattering - which is why
 * changing it later moves nobody who has already decided.
 *
 * Refused where the organization has no such view: a standard client cannot be
 * started on a reseller screen, because there is no reseller screen there to
 * start them on. lib/viewMode clamps the same answer again at read time, so a
 * company that stops reselling does not strand anybody it was set for.
 */
export async function setStartView(id: number, mode: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [row] = await db.select().from(clientAllowlist).where(eq(clientAllowlist.id, id));
  if (!row || row.orgId === null) return { error: "Not found" };
  const gate = await adminOrgGate(u, row.orgId);
  if ("error" in gate) return gate;
  if (!isViewPref(mode)) return { error: "Unknown view" };
  const [org] = await db.select({ resale: orgs.resaleEnabled }).from(orgs).where(eq(orgs.id, row.orgId));
  if (mode !== "" && !viewAllowed(mode, org?.resale ?? false)) {
    return { error: `${VIEW_LABEL[mode as ViewMode]} isn't a view this organization has` };
  }
  if (row.startView === mode) return {};
  await db.update(clientAllowlist).set({ startView: mode }).where(eq(clientAllowlist.id, id));
  await audit({
    actor: u.email, entityType: "settings", entityId: row.entry,
    action: mode
      ? `${row.entry} now starts in the ${VIEW_LABEL[mode as ViewMode].toLowerCase()} view`
      : `${row.entry} now starts in their organization's default view`,
    field: "start_view", oldValue: row.startView, newValue: mode,
  });
  revalidatePath("/", "layout");
  revalidatePath(`/settings/organizations/${row.orgId}`);
  return {};
}

/**
 * "I have seen where the switch lives." Stamped once and never asked again.
 */
export async function dismissViewTour(): Promise<{ error?: string }> {
  const u = await requireUser();
  await db.update(users).set({ viewTourAt: new Date() })
    .where(eq(users.email, u.email.toLowerCase()));
  revalidatePath("/");
  return {};
}

export async function setMyViewMode(mode: string): Promise<{ error?: string }> {
  const u = await requireUser();
  if (!isViewPref(mode)) return { error: "Unknown view" };
  await db.update(users).set({ viewMode: mode }).where(eq(users.email, u.email.toLowerCase()));
  // The nav, the landing and the roster all read it, so the whole shell.
  revalidatePath("/", "layout");
  return {};
}

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
  // A workspace is born with a working expense vocabulary rather than an
  // empty picker - every name deletable, renameable, theirs from day one.
  await db.insert(expenseCategories).values(missingStarters([]).map((name, i) => ({
    tenantOrgId: org.id, name, sortOrder: i + 1, createdBy: u.email,
  })));
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
/**
 * Add or update one of our own people - now with the whole profile in one
 * motion, and optionally the invitation too.
 *
 * homeAddress: the engineer's point zero for the stipend radius and routed
 * miles. Historically self-set only; the hiring flow is the exception the
 * rule always meant to allow - the owner filling in the profile BEFORE the
 * person's first sign-in is setting up their account, not typing someone
 * else's home behind their back, and the engineer can change it on their own
 * settings page any time.
 *
 * invite: sends the email that tells them they're in and where the door is.
 * Separate flag because re-saving a role must never re-spam an inbox.
 */
export async function setHouseMember(
  email: string, role: string, name?: string,
  extra: {
    homeAddress?: string; invite?: boolean;
    /** Mint a temporary password too, for when mail is not arriving at all. */
    withPassword?: boolean; tempDays?: number;
  } = {},
): Promise<{
  error?: string; invited?: boolean; homeLabel?: string;
  password?: string; expiresOn?: string;
}> {
  const u = await requireOwner();
  const want = role === "owner" ? "owner" : "staff";
  const e = email.trim().toLowerCase();
  const { guard } = await guardFor(u, e, want);
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
  // The profile's other half: where their trips start from.
  let homeLabel: string | undefined;
  const home = (extra.homeAddress ?? "").trim().slice(0, 300);
  if (home) {
    const hit = await geocode(home).catch(() => null);
    await db.update(houseMembers).set({
      homeAddress: home, homeLat: hit?.lat ?? null, homeLng: hit?.lng ?? null,
    }).where(eq(houseMembers.email, e));
    await db.delete(driveCache).where(eq(driveCache.memberEmail, e));
    homeLabel = hit?.label;
  }

  // A way in that does not depend on mail arriving. Same rules as a client's:
  // generated, shown once, and dead on its own date. The account row is made
  // here if they have never signed in, which is the whole point of offering it.
  let password: string | undefined;
  let expiresOn: string | undefined;
  if (extra.withPassword) {
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, e));
    if (!row) await db.insert(users).values({ email: e, ...(label ? { name: label } : {}) });
    const made = await mintTempPassword(u, e, extra.tempDays ?? TEMP_DAYS_DEFAULT);
    if ("error" in made) return made;
    password = made.password;
    expiresOn = made.expiresOn;
  }

  // The invitation: they are IN either way - sign-in is by email code, so
  // access exists the moment the row does. The email is how they find out.
  let invited = false;
  if (extra.invite) {
    const brand = await getBrand();
    const url = appUrl();
    const who = brand.operatorName || brand.name;
    try {
      await sendEmail([e],
        `You're set up on ${who}'s service portal`,
        `<p>${label || e},</p>
         <p>${u.name || u.email} added you to <b>${who}</b>'s service portal as ${want === "owner" ? "an owner" : "staff"}.</p>
         <p>Sign in at <a href="${url}">${url}</a> with this email address - ${password
            ? "a temporary password has been set for you, and whoever added you will pass it on. A code by mail works too."
            : "a code arrives by mail; there is no password."}</p>
         ${home ? `<p>Your home base is set to <b>${home}</b> - trips and the expense stipend radius measure from it. You can change it under your own settings.</p>` : ""}`,
        { from: reportFrom(), replyTo: replyToAddress() });
      invited = true;
      await audit({
        actor: u.email, entityType: "house", entityId: e,
        action: `sent ${e} their invitation`,
      });
    } catch {
      // The account stands; only the mail failed. Say so instead of undoing.
    }
  }

  // Their next session read picks the new role up (src/auth.ts) - no redeploy,
  // and no need for them to sign out and back in.
  revHouse();
  return { invited: extra.invite ? invited : undefined, homeLabel, password, expiresOn };
}

/**
 * A temporary password for somebody already on the house list - the engineer
 * hired last week whose codes are landing nowhere. Owner-only, like every
 * other change to who works here.
 */
export async function setHouseTempPassword(
  email: string, days?: number,
): Promise<{ error?: string; password?: string; expiresOn?: string }> {
  const u = await requireOwner();
  const e = email.trim().toLowerCase();
  const [member] = await db.select().from(houseMembers).where(eq(houseMembers.email, e));
  if (!member || member.role === "none") return { error: "Not found" };
  // Their own workspace's people, nobody else's - the same line every other
  // house change is drawn on.
  const mine = myTenantOrgId(u);
  if (mine !== null && member.orgId !== null && member.orgId !== mine) return { error: "Not found" };
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, e));
  if (!row) await db.insert(users).values({ email: e, ...(member.name ? { name: member.name } : {}) });
  const made = await mintTempPassword(u, e, days ?? TEMP_DAYS_DEFAULT);
  if ("error" in made) return made;
  revHouse();
  return made;
}

/** Take it back; they go back to codes. */
export async function clearHouseTempPassword(email: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const e = email.trim().toLowerCase();
  const [member] = await db.select().from(houseMembers).where(eq(houseMembers.email, e));
  if (!member) return { error: "Not found" };
  const mine = myTenantOrgId(u);
  if (mine !== null && member.orgId !== null && member.orgId !== mine) return { error: "Not found" };
  await clearPasswordFor(e);
  await audit({
    actor: u.email, entityType: "auth", entityId: e,
    action: `removed the sign-in password from ${e}`,
  });
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
  const { guard } = await guardFor(u, e, "revoke");
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
export async function listHouseMembers(
  /**
   * Whose roster. Omitted means the caller's own workspace, which is what
   * "Our people" means on anybody's Settings page - INCLUDING the platform's
   * administrator, whose own people are the platform's, not the instance's.
   * Reading the whole instance into that panel put one company's engineers on
   * another company's roster under the heading "Our people" and the copy
   * "Staff see and work every system in the shop", which is a claim about
   * them that is not true.
   *
   * Platform staff may name another workspace to administer it - that is the
   * support path, and it is how a tenant's staff are reached from that
   * tenant's own organization page rather than from the platform's roster.
   */
  orgId?: number | null,
): Promise<{
  email: string; role: string; name: string; fromEnv: boolean; isRoot: boolean; locked: boolean;
}[]> {
  const u = await requireOwner();
  const env = parseList(process.env.STAFF_EMAILS);
  const members = await houseMemberRows();
  const root = rootOwner(env);
  const owners = ownerEmails(env, members);
  const rows = await db.select().from(houseMembers);
  /**
   * WHOSE people. house_members is one instance-wide table, and this used to
   * return all of it - so a second service company's owner opened Settings and
   * read the first company's engineers by name and address, beside a "revoke"
   * link and a "temp password" one. The listing is also what Settings > Usage
   * decides from, so the same row leaked that person's last sign-in.
   *
   * An operator sees the members stamped with their own workspace. Nobody else's,
   * and none of the STAFF_EMAILS entries either: those are the ROOT operator's
   * break-glass access (lib/houseRole), so they belong to that workspace and not
   * to whoever happens to be reading. Platform staff still see the instance -
   * that is the support path, and the whole reason readTenant returns null.
   */
  const platform = isPlatformStaff(tenantViewer(u));
  // A workspace other than my own is platform-staff-only; anyone else asking
  // for one gets their own, which is all they could ever see anyway.
  const want = platform && orgId !== undefined ? orgId : myTenantOrgId(u);
  const visible = rows.filter((r) => (r.orgId ?? null) === want);
  // STAFF_EMAILS is the ROOT operator's break-glass access, so those entries
  // belong on the root workspace's roster and nowhere else.
  const isRootRoster = want === u.rootOperatorOrgId;
  const emails = [...new Set([
    ...(isRootRoster ? env : []),
    ...visible.map((r) => r.email.toLowerCase()),
  ])];
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

  // The STOCKROOM's workspace - the room is the thing that has a tenant here,
  // since a stock line hangs off it rather than carrying a stamp of its own.
  const book = await db.select().from(partPrices)
    .where(forTenant(partPrices.tenantOrgId, acc.room.tenantOrgId));
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
  revalidatePath("/money/purchasing");
  if (id) revalidatePath(`/money/purchasing/${id}`);
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
  urgent?: boolean;
  lines: PoLineInput[];
  /** A deliberately blank draft, lines typed on the order itself. Send still refuses empty. */
  allowEmpty?: boolean;
}): Promise<{ error?: string; id?: number }> {
  const u = await requireEditor();
  const acc = await roomAccess(u, data.stockroomId);
  if (!acc.room) return { error: "Not found" };
  if (!acc.issue) return { error: acc.see ? "You can't order into someone else's stockroom" : "Not found" };
  const vendor = data.vendor.trim().slice(0, 80);
  if (!vendor) return { error: "Vendor required" };
  const usable = data.lines.filter((l) => l.partNumber.trim());
  if (!usable.length && !data.allowEmpty) return { error: "An order needs at least one line" };
  if (usable.length > 200) return { error: "200 lines at a time" };

  // Deliberately NOT tenant-scoped, and this is the one place in this sweep
  // where that is right: po_number_unique (schema.ts) is UNIQUE(number) across
  // the whole table, not per workspace. Scoping the scan let two workspaces
  // climb their own series independently until they met, and the meeting is an
  // unhandled constraint violation on somebody's screen. The scan reveals only
  // the highest number in use, never a row; making the constraint per-tenant is
  // the real fix and is a migration, not a predicate.
  const existing = await db.select({ number: purchaseOrders.number }).from(purchaseOrders);
  const [po] = await db.insert(purchaseOrders).values({
    tenantOrgId: acc.room.tenantOrgId ?? myTenantOrgId(u),
    number: nextPoNumber(existing.map((r) => r.number)),
    vendor, stockroomId: data.stockroomId, orgId: acc.room.orgId,
    urgent: !!data.urgent,
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
    action: `raised ${po.number} to ${vendor}: ${usable.length} line${usable.length === 1 ? "" : "s"} for "${acc.room.name}"`
      + (data.urgent ? " - URGENT" : ""),
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

/**
 * How an order travels: to the shelf as always, or drop-shipped straight to a
 * client site under our paperwork - plus whether somebody is waiting on it.
 * Draft-only, like every other edit: once the vendor has the order, changing
 * where it ships is a phone call, not a field.
 */
export async function setPoShipping(id: number, data: {
  shipToSiteId: number | null; urgent: boolean;
}): Promise<{ error?: string }> {
  const u = await requireEditor();
  const { po, manage, see } = await poAccess(u, id);
  if (!po) return { error: "Not found" };
  if (!manage) return { error: see ? "You can't change this order" : "Not found" };
  if (!poEditable(po.status)) return { error: `${po.number} has already gone to the vendor` };

  let site: typeof orgSites.$inferSelect | null = null;
  if (data.shipToSiteId !== null) {
    [site] = await db.select().from(orgSites).where(eq(orgSites.id, data.shipToSiteId));
    if (!site || site.archived) return { error: "That site is gone" };
    if (po.tenantOrgId !== null && site.tenantOrgId !== null && site.tenantOrgId !== po.tenantOrgId) {
      return { error: "Not found" };
    }
  }
  const changes: string[] = [];
  if ((po.shipToSiteId ?? null) !== (data.shipToSiteId ?? null)) {
    changes.push(site ? `drop-ship to ${site.name || "the site"}` : "ships to the stockroom");
  }
  if (po.urgent !== data.urgent) changes.push(data.urgent ? "URGENT" : "not urgent");
  if (!changes.length) return {};
  await db.update(purchaseOrders).set({ shipToSiteId: data.shipToSiteId, urgent: data.urgent })
    .where(eq(purchaseOrders.id, id));
  await audit({
    actor: u.email, entityType: "po", entityId: id, tenantOrgId: po.tenantOrgId,
    action: `${po.number}: ${changes.join(", ")}`,
    field: "shipping", oldValue: String(po.shipToSiteId ?? ""), newValue: String(data.shipToSiteId ?? ""),
  });
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
      + `${totals.unpriced ? ` (${totals.unpriced} line${totals.unpriced === 1 ? "" : "s"} unpriced)` : ""}`
      + (po.shipToSiteId !== null ? " - drop-ship" : "") + (po.urgent ? " - URGENT" : ""),
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
  // A drop-shipped line never touches a shelf: the vendor delivered it to the
  // client's site, so receiving here is confirming the delivery happened. The
  // cost stays on the PO (and the job it names), not on any room's held cost -
  // but everything else about arrival (the job's part rows, the PO's status)
  // runs the same as a dock receipt below.
  const dropSite = po.shipToSiteId === null ? null
    : (await db.select().from(orgSites).where(eq(orgSites.id, po.shipToSiteId)))[0] ?? null;
  if (po.shipToSiteId !== null) {
    await db.update(poLines).set({ qtyReceived: line.qtyReceived + qty }).where(eq(poLines.id, lineId));
  } else {
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
      + (dropSite !== null || po.shipToSiteId !== null
        ? ` - delivered at ${dropSite?.name || "the client site"}` : "")
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
  revalidatePath("/money/purchasing");
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
  revalidatePath("/money/purchasing");
  return { sent: rows.length };
}

/**
 * Delete a purchase order outright - for the one raised by mistake, the
 * duplicate, the test. Cancelling is for an order that was real and called
 * off; this is for one that should never have existed, and it takes its lines
 * with it.
 *
 * REFUSED once anything has been received, and that is the whole design. A
 * receipt put goods on a shelf, set that shelf's held cost, and closed the
 * open part requests on somebody's job - none of which this could undo. An
 * order somebody can delete after receiving it is an order that leaves the
 * stockroom holding parts no paperwork explains, which is the exact failure
 * purchasing records exist to prevent. Cancel it instead: that stops what is
 * outstanding and leaves what arrived arrived.
 *
 * The paperwork filed against it - the vendor's receipt, the parts that name
 * it - survives with the link nulled rather than being deleted along with it.
 */
export async function deletePurchaseOrder(id: number, reason: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const { po, manage, see } = await poAccess(u, id);
  if (!po) return { error: "Not found" };
  if (!manage) return { error: see ? "You can't delete this order" : "Not found" };

  // Two independent signals that goods arrived, and either one refuses. The
  // line quantities are the ledger; the status is what the rest of the app
  // reads. A row where they disagree is exactly the row not to delete.
  const lines = await db.select().from(poLines).where(eq(poLines.poId, id));
  const received = lines.reduce((n, l) => n + l.qtyReceived, 0);
  if (received > 0 || po.status === "received" || po.status === "partial") {
    return {
      error: `${po.number} has been received against`
        + `${received > 0 ? ` (${received} item${received === 1 ? "" : "s"})` : ""}.`
        + ` Cancel it instead - deleting would leave stock nothing explains.`,
    };
  }

  const total = poTotals(lines).cents;
  // The lines explicitly, then the order. The cascade exists (schema-sync
  // grew the key that had been declared and never enforced), but a delete
  // that depends on a constraint being present in every environment is a
  // delete that leaves rows behind in the one where it is not.
  await db.delete(poLines).where(eq(poLines.poId, id));
  await db.delete(purchaseOrders).where(eq(purchaseOrders.id, id));
  await audit({
    actor: u.email, entityType: "po", entityId: id, tenantOrgId: po.tenantOrgId,
    action: `deleted ${po.number} to ${po.vendor}`
      + `${lines.length ? ` (${lines.length} line${lines.length === 1 ? "" : "s"}${total ? `, ${formatCents(total)}` : ""})` : ""}`
      + ` - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revalidatePath("/money/purchasing");
  if (po.workOrderId) revalidatePath(`/work/${po.workOrderId}`);
  return {};
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
  /** Business days to ship. Blank/undefined = unknown, kept null on purpose. */
  leadDays?: string;
  dropShips?: boolean; expediteOk?: boolean;
  /**
   * Names the part, and doing so is what catalogues an unknown PN: a pasted
   * vendor sheet with a name column builds the catalog as it prices it. A
   * priced-but-unnamed number stays out of the catalog on purpose.
   */
  name?: string;
};

/** One row, validated and case-insensitively matched against what's on file. */
async function cleanPriceRow(r: PartPriceInput): Promise<
  | { ok: false; error: string }
  | { ok: true; pn: string; vendor: string; cents: number; isOem: boolean; url: string; note: string;
      leadDays: number | null; dropShips: boolean; expediteOk: boolean;
      existing: typeof partPrices.$inferSelect | undefined }
> {
  const pn = r.partNumber.trim().slice(0, 80);
  const vendor = r.vendor.trim().slice(0, 80);
  if (!pn || !vendor) return { ok: false, error: "Part number and vendor are both required" };
  const cents = parseMoney(r.price);
  if (cents === null) return { ok: false, error: `"${r.price.trim() || "(blank)"}" isn't a price - use a number like 129.95` };
  const leadRaw = (r.leadDays ?? "").trim();
  const leadDays = leadRaw === "" ? null : parseInt(leadRaw, 10);
  if (leadDays !== null && (!Number.isFinite(leadDays) || leadDays < 0 || leadDays > 365)) {
    return { ok: false, error: `"${leadRaw}" isn't a lead time - business days, like 3` };
  }
  const [existing] = await db.select().from(partPrices).where(and(
    sql`lower(${partPrices.partNumber}) = ${pn.toLowerCase()}`,
    sql`lower(${partPrices.vendor}) = ${vendor.toLowerCase()}`,
  ));
  return {
    ok: true, pn, vendor, cents, isOem: !!r.isOem, url: (r.url ?? "").trim().slice(0, 300),
    note: (r.note ?? "").trim().slice(0, 200),
    leadDays, dropShips: !!r.dropShips, expediteOk: !!r.expediteOk, existing,
  };
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
): Promise<{ error?: string; created?: number; updated?: number; cataloged?: number; failures?: { row: number; name: string; error: string }[] }> {
  const u = await requireStaff();
  const usable = rows.filter((r) => r.partNumber.trim() || r.vendor.trim() || r.price.trim());
  if (!usable.length) return { error: "Nothing to save" };
  if (usable.length > 300) return { error: "Save 300 rows at a time" };
  const failures: { row: number; name: string; error: string }[] = [];
  let created = 0, updated = 0;
  for (let i = 0; i < usable.length; i++) {
    const row = await cleanPriceRow(usable[i]);
    if (!row.ok) { failures.push({ row: i + 1, name: usable[i].partNumber.trim() || "(no PN)", error: row.error }); continue; }
    const { pn, vendor, cents, isOem, url, note, leadDays, dropShips, expediteOk, existing } = row;
    if (existing) {
      await db.update(partPrices).set({
        priceCents: cents, isOem, url, note,
        // A blank lead time on a re-paste keeps what somebody once recorded.
        ...(leadDays !== null ? { leadDays } : {}),
        dropShips, expediteOk,
        updatedBy: u.email, updatedAt: new Date(),
      }).where(eq(partPrices.id, existing.id));
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
        partNumber: pn, vendor, priceCents: cents, isOem, url, note,
        leadDays, dropShips, expediteOk, updatedBy: u.email,
      }).returning();
      await audit({
        actor: u.email, entityType: "price", entityId: p.id,
        action: `priced PN ${pn} at ${formatCents(cents)} from ${vendor}${isOem ? " (OEM)" : ""}`,
      });
      created++;
    }
  }
  // A pasted sheet that NAMES its parts fills the catalog as it prices them.
  // One stub per unknown PN: number, name, and - for an OEM row - the vendor
  // as maker, since the maker's own sheet is the one source that knows.
  let cataloged = 0;
  const named = new Map<string, { partNumber: string; name: string; manufacturer: string }>();
  for (const r of usable) {
    const pn = r.partNumber.trim().slice(0, 80);
    const nm = (r.name ?? "").trim().slice(0, 120);
    if (!pn || !nm || named.has(pn.toLowerCase())) continue;
    named.set(pn.toLowerCase(), { partNumber: pn, name: nm, manufacturer: r.isOem ? r.vendor.trim().slice(0, 80) : "" });
  }
  if (named.size) {
    const have = await db.select({ partNumber: partCatalog.partNumber }).from(partCatalog)
      .where(forTenant(partCatalog.tenantOrgId, myTenantOrgId(u)));
    const known = new Set(have.map((r) => r.partNumber.trim().toLowerCase()));
    for (const stub of named.values()) {
      if (known.has(stub.partNumber.toLowerCase())) continue;
      const [c] = await db.insert(partCatalog).values({
        tenantOrgId: myTenantOrgId(u), partNumber: stub.partNumber, name: stub.name,
        manufacturer: stub.manufacturer, createdBy: u.email,
      }).returning();
      await audit({
        actor: u.email, entityType: "catalog_part", entityId: c.id,
        action: `cataloged PN ${stub.partNumber} (${stub.name}) from a pasted price sheet`,
      });
      cataloged++;
    }
  }
  revalidatePath("/settings/catalog");
  revalidatePath("/settings/parts");
  return { created, updated, cataloged, failures };
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
  contactEmail?: string;
  /** One-way road miles from the shop, as text from the form. Blank = unknown. */
  onewayMiles?: string;
};

const cleanSite = (d: SiteInput) => ({
  name: d.name.trim().slice(0, 80),
  address: d.address.trim().slice(0, 600),
  accessNotes: d.accessNotes.trim().slice(0, 1000),
  contactName: d.contactName.trim().slice(0, 80),
  contactPhone: d.contactPhone.trim().slice(0, 40),
  contactEmail: (d.contactEmail ?? "").trim().toLowerCase().slice(0, 120),
  onewayMiles: Math.max(0, Math.min(9999, parseInt(d.onewayMiles ?? "", 10) || 0)),
});

/**
 * Pin a site to the map, best-effort. A failed geocode leaves lat/lng null
 * and costs nothing anybody was promised: routed miles fall back to the
 * site's typed default. Never allowed to fail the save that triggered it.
 */
async function geocodeSite(siteId: number, address: string): Promise<void> {
  try {
    const hit = address.trim() ? await geocode(address) : null;
    await db.update(orgSites).set({ lat: hit?.lat ?? null, lng: hit?.lng ?? null })
      .where(eq(orgSites.id, siteId));
  } catch { /* the site stands without a pin */ }
}

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
  await geocodeSite(row.id, clean.address);
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
  if (clean.address !== site.address) await geocodeSite(siteId, clean.address);
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
// part fitted at 2am must land in the record whether or not it is cataloged.
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
  const rows = await storeFiles(u.orgId ?? null, await storeTenantFor(u.orgId ?? null, u), 500).catch(() => []);
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

  // Your own workspace's library, not the instance operator's - the slug is
  // unique across the instance, so two tenants still cannot race for the same
  // page, but each may publish its own models. Keyed off the instance operator
  // this refused every workspace but the landlord's.
  const mine = myTenantOrgId(u);
  if (mine !== null && term.tenantOrgId !== null && term.tenantOrgId !== mine) {
    return { error: "You can only publish your own workspace's catalog" };
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
 * The parts catalog, for pickers that need to name a part rather than have one
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
 * The parts catalog as a part-number field needs it: every live entry with its
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
    action: `cataloged ${clean.partNumber}${clean.name ? ` - ${clean.name}` : ""} (${PART_KIND_LABEL[clean.kind].toLowerCase()})`,
  });
  revalidatePath("/settings/parts");
  return { id: row.id };
}

/**
 * A whole sheet: parts and the vendors who sell them, in one pass.
 *
 * The two entries this replaces asked for the same forty part numbers twice -
 * once to say what each one IS and once to say what it costs - when a vendor's
 * quote sheet arrives with both on one line. See lib/partImport for the shape.
 *
 * BLANK LEAVES WHAT IS ON FILE ALONE. A sheet that names a vendor and a price
 * and nothing else must not wipe the description somebody wrote by hand last
 * year, and a re-import of an export must not depend on every column surviving
 * the round trip. The only way to clear a field stays the form.
 *
 * Repeating a part number is how a part gets a second vendor, not a collision:
 * the catalog half is upserted once per number and every row's price half is
 * taken. That is what a real quote comparison looks like - twenty parts, four
 * vendors each, eighty lines.
 */
export async function importParts(rows: PartImportRow[]): Promise<{
  error?: string; parts?: number; created?: number; updated?: number;
  prices?: number; problems?: RowProblem[];
}> {
  const u = await requireStaff();
  const { ok, problems } = checkRows(rows);
  if (!ok.length) return { error: "Nothing on that sheet to import", problems };
  if (ok.length > 500) return { error: "Import 500 rows at a time", problems };
  /* ONE UNIVERSE FOR THE LOOKUP AND THE INSERT, which is the bug this line
     exists to have fixed. Reading in a wider scope than the stamp writes in
     means a part can be seen and still not be found - so a sheet exported from
     this page re-imports as a second copy of every part, and the unique index
     that should have caught it does not fire because the two rows differ by
     tenant. Same scope addCatalogPart uses, for the same reason. */
  const tenant = myTenantOrgId(u);
  const mine = await loadAliases(
    await db.select().from(partCatalog).where(forTenant(partCatalog.tenantOrgId, tenant)));
  /* Every number an entry answers to, not just its primary. A catalog that let
     two entries answer to one number would resolve it to whichever came first,
     so the same box would describe itself differently depending on the screen -
     the invariant addCatalogPart refuses a hand-typed number for, and one a
     five-hundred-line import can break five hundred times as fast. */
  const byPn = new Map<string, typeof mine[number]>();
  for (const c of mine) {
    for (const n of allNumbers(c)) if (!byPn.has(normalizePn(n))) byPn.set(normalizePn(n), c);
  }

  let created = 0, updated = 0;
  const seen = new Set<string>();
  for (const r of ok) {
    const pn = r.partNumber.trim().slice(0, 80);
    const norm = normalizePn(pn);
    // One catalog write per number however many vendor rows it has.
    if (seen.has(norm)) continue;
    seen.add(norm);

    /* Everything this sheet says about the part, and nothing it does not.
       An absent cell is silence, not an instruction. */
    const said = {
      ...(r.name.trim() ? { name: r.name.trim().slice(0, 160) } : {}),
      ...(r.manufacturer.trim() ? { manufacturer: r.manufacturer.trim().slice(0, 80) } : {}),
      ...(r.mfrPartNumber.trim() ? { mfrPartNumber: r.mfrPartNumber.trim().slice(0, 80) } : {}),
      ...((PART_KINDS as readonly string[]).includes(r.kind.trim().toLowerCase())
        ? { kind: r.kind.trim().toLowerCase() } : {}),
      ...(r.fits.trim() ? { assetTypes: splitCell(r.fits) } : {}),
      ...(r.models.trim() ? { models: splitCell(r.models) } : {}),
      ...(r.note.trim() ? { note: r.note.trim().slice(0, 500) } : {}),
    };

    const existing = byPn.get(norm);
    if (existing) {
      if (Object.keys(said).length) {
        await db.update(partCatalog).set(said).where(eq(partCatalog.id, existing.id));
        updated++;
      }
    } else {
      const [row] = await db.insert(partCatalog).values({
        partNumber: pn, tenantOrgId: tenant, createdBy: u.email, ...said,
      }).returning();
      // Into the index under every number it now answers to, so a later line
      // naming the manufacturer's number finds the entry this line just made
      // rather than filing a second one beside it.
      const added = { ...row, aliases: [] };
      for (const n of allNumbers(added)) byPn.set(normalizePn(n), added);
      created++;
    }
  }
  await audit({
    actor: u.email, entityType: "part_catalog", entityId: 0, tenantOrgId: tenant,
    action: `imported a parts sheet: ${created} new, ${updated} updated across ${seen.size} part numbers`,
  });

  /* The price half goes through the price book's own write path rather than a
     second copy of it - so a re-priced pair is audited as a re-pricing here
     exactly as it is when somebody pastes a quote sheet into the price card. */
  const priced = ok.filter((r) => r.vendor.trim() && r.price.trim());
  const res = priced.length ? await addPartPrices(priced.map((r) => ({
    partNumber: r.partNumber, vendor: r.vendor, price: r.price,
    isOem: yesish(r.oem), url: r.url, leadDays: r.leadDays,
    dropShips: yesish(r.blindShip), expediteOk: yesish(r.overnight),
    // Deliberately NOT r.name: this action has already catalogued the part
    // properly, and addPartPrices' stub-maker would be a second, thinner one.
  })) as PartPriceInput[]) : {};

  revalidatePath("/settings/parts");
  return {
    parts: seen.size, created, updated,
    prices: (res.created ?? 0) + (res.updated ?? 0),
    problems: [...problems, ...(res.failures ?? []).map((f) => ({
      line: f.row, partNumber: f.name, problem: f.error,
    }))],
  };
}

/** "Pump; Autosampler" -> ["Pump", "Autosampler"]. Semicolons, in a CSV. */
const splitCell = (s: string): string[] =>
  [...new Set(s.split(";").map((x) => x.trim()).filter(Boolean))];

const yesish = (s: string): boolean => /^(y|yes|true|1|oem)$/i.test((s ?? "").trim());

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

// ---------------- The trail ----------------

/**
 * Report a page opened, or an error thrown at somebody.
 *
 * Called from the browser, so it is written as if it were: it trusts nothing
 * from the caller except the route and the message, takes WHO from the session
 * rather than the payload, and cannot fail anything. A visitor with no session
 * records nothing - the sign-in page is not where bugs hide, and an unnamed
 * row helps nobody.
 *
 * The identity is the REAL one. An owner viewing as a client still records as
 * themselves, which is what the banner over that mode promises.
 */
export async function reportTrail(input: {
  kind: string; route: string; search?: string; message?: string; detail?: string;
}): Promise<void> {
  try {
    const { real, persona } = await viewContext();
    if (!real) return;
    const h = await headers();
    await recordTrail({
      kind: input.kind,
      email: real.email,
      role: real.role,
      orgId: real.orgId,
      orgName: real.orgName ?? "",
      operatorOrgId: real.operatorOrgId,
      viewingAs: persona ? persona.orgName : "",
      route: input.route,
      search: input.search,
      message: input.message,
      detail: input.detail,
      userAgent: h.get("user-agent") ?? "",
    });
    /* One page in a few hundred pays for the sweep, so the table cannot grow
       without an end and nothing has to be scheduled to stop it. Errors never
       draw the short straw: the row somebody came here to read is not the one
       that should wait on a delete. */
    if (input.kind === "page" && Math.random() < 0.005) await pruneTrail();
  } catch {
    // Nothing here may surface to a person. See lib/trailData.
  }
}

/** Empty the trail. Only whoever may read it may clear it. */
export async function clearTrail(): Promise<{ error?: string; cleared?: number }> {
  const u = await requireUser();
  if (!maySeeTrail(u.email)) return { error: "Not found" };
  const gone = await db.delete(trailEvents).returning({ id: trailEvents.id });
  await audit({
    actor: u.email, entityType: "trail", entityId: 0,
    action: `cleared the activity trail - ${gone.length} row${gone.length === 1 ? "" : "s"}`,
  });
  revalidatePath("/settings/trail");
  return { cleared: gone.length };
}

// ---------------- Service agreements ----------------
// The contract and what it entitles somebody to. What has been DRAWN DOWN is
// never written here - it is summed from the work in lib/agreementUsage - so
// the answer is always what the ledger actually says rather than a second copy
// of it that is free to disagree. See lib/agreements.

/**
 * A third party named on an agreement, resolved to a directory entry.
 *
 * A service provider we do not run is an orgs row with no users, no login and
 * no workspace - the same kind of thing a manufacturer name is. It gets a row
 * rather than a text column because "who do I call" eventually wants a phone
 * number, and because two agreements naming the same company should point at
 * the same company.
 *
 * Matched case-insensitively inside the tenant before anything is created, so
 * "Agilent" typed twice is one entry. It will still collect "Agilent" and
 * "Agilent Technologies" as separate companies - that is a merge problem for
 * whoever tidies the directory, and a far smaller one than refusing to record
 * the fact at all.
 */
async function resolveProvider(
  name: string, tenantOrgId: number | null, operatorName: string,
): Promise<{ error: string } | { id: number | null }> {
  const clean = name.trim().slice(0, 120);
  if (!clean) return { id: null };
  /* Naming ourselves means it is ours, which is what a null provider says.
     Checked against the TENANT'S OWN NAME as well as the brand's: on an
     instance whose settings row names no operator the brand falls back to the
     platform name, and "Sierra Spectra" typed into a Sierra Spectra workspace
     has to resolve to us whichever of the two it matches. This is the check
     that stops a client granting themselves one of our contracts, so it is
     not a place to be relying on one lookup being populated. */
  const [tenant] = tenantOrgId === null ? [] : await db.select({ name: orgs.name })
    .from(orgs).where(eq(orgs.id, tenantOrgId));
  const us = [operatorName, tenant?.name ?? ""]
    .map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (us.includes(clean.toLowerCase())) return { id: null };
  const existing = await db.select({ id: orgs.id, name: orgs.name, parentOrgId: orgs.parentOrgId })
    .from(orgs)
    .where(tenantOrgId === null ? undefined : eq(orgs.parentOrgId, tenantOrgId));
  const hit = existing.find((o) => o.name.trim().toLowerCase() === clean.toLowerCase());
  if (hit) return { id: hit.id };
  const [made] = await db.insert(orgs)
    .values({ name: clean, kind: "provider", parentOrgId: tenantOrgId })
    .returning({ id: orgs.id });
  return { id: made.id };
}

export type AgreementInput = {
  kind: string; number: string; title: string; status: string;
  /**
   * Who provides the service, by name. Blank or our own name means us, which
   * is what a null provider_org_id has always meant.
   */
  providerName?: string;
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
  const tenantOrgId = orgTenant(org) ?? myTenantOrgId(u);
  const provider = await resolveProvider(
    data.providerName ?? "", tenantOrgId, (await getBrand()).operatorName);
  if ("error" in provider) return provider;
  const [row] = await db.insert(agreements).values({
    ...clean, orgId, tenantOrgId, providerOrgId: provider.id, createdBy: u.email,
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
  const provider = await resolveProvider(
    data.providerName ?? "", before.tenantOrgId, (await getBrand()).operatorName);
  if ("error" in provider) return provider;
  await db.update(agreements).set({ ...clean, providerOrgId: provider.id })
    .where(eq(agreements.id, id));
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
 * "Somebody else covers this one." Recorded by whoever it is true of.
 *
 * The client knows their own paperwork better than we do. Before this, the
 * only way a manufacturer's contract reached this app was a phone call
 * somebody remembered to make and somebody else remembered to type in, which
 * is why every system a client shared with us read as one we service.
 *
 * THE GATE IS THE POINT. agreements is also where OUR contracts live - the
 * rows that decide what we bill and what we absorb - so this door is narrow in
 * three directions at once:
 *
 *   - their own organization's paper only, never another client's;
 *   - a provider that is somebody else, never us and never blank. A client who
 *     could write a row with a null provider could grant themselves unlimited
 *     visits on our dime;
 *   - editors only, because it speaks for the whole organization.
 *
 * Staff can call it too and it behaves identically - the record should not
 * depend on which side of the relationship typed it.
 */
export async function recordCoverage(input: {
  instrumentId: number;
  providerName: string;
  title: string;
  number: string;
  startsOn: string;
  endsOn: string;
  visitsIncluded: string;
  partsAllowance: string;
  laborIncludedHours: string;
  note: string;
}): Promise<{ error?: string; id?: number }> {
  const u = await requireEditor();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, input.instrumentId));
  if (!inst) return { error: "Not found" };
  if (!(await canSeeSystemSafe(u, input.instrumentId))) return { error: "Not found" };
  // A contract is written with whoever OWNS the machine. A system nobody owns
  // on this instance is ours outright and has nothing to record.
  if (inst.ownerOrgId === null) return { error: "That system has no owner to hold a contract" };
  const staff = isStaffRole(u.role);
  if (!staff && u.orgId !== inst.ownerOrgId) {
    return { error: "Only the organization that owns it can record its coverage" };
  }
  const name = input.providerName.trim();
  if (name.length < 2) return { error: "Say who provides the service" };

  const brand = await getBrand();
  const provider = await resolveProvider(name, inst.tenantOrgId, brand.operatorName);
  if ("error" in provider) return provider;
  /* The lock. resolveProvider returns null for our own name, and a null
     provider is what marks an agreement as OURS - the row that decides what
     we bill and what we absorb. Recording one of ours is a commercial act and
     belongs on the agreements screen behind requireStaff, not here. */
  if (provider.id === null) {
    return {
      error: `This is for a contract somebody else holds. To record one of ${brand.operatorName}'s own, use the agreements screen.`,
    };
  }

  const clean = cleanAgreement({
    kind: "contract", number: input.number, title: input.title, status: "active",
    startsOn: input.startsOn, endsOn: input.endsOn, renewNoticeDays: 60,
    visitsIncluded: input.visitsIncluded, partsAllowance: input.partsAllowance,
    laborIncludedHours: input.laborIncludedHours,
    // Scoped to this one system. An account-wide claim about somebody else's
    // paper is a much bigger assertion than anybody typing into one record's
    // panel means to make.
    instrumentIds: [input.instrumentId],
    value: "", note: input.note,
  });
  if ("error" in clean) return clean;

  const [row] = await db.insert(agreements).values({
    ...clean, orgId: inst.ownerOrgId, tenantOrgId: inst.tenantOrgId,
    providerOrgId: provider.id, createdBy: u.email,
  }).returning();
  await audit({
    actor: u.email, entityType: "agreement", entityId: row.id, tenantOrgId: row.tenantOrgId,
    instrumentId: input.instrumentId,
    action: `recorded ${name} coverage on ${inst.externalId}`
      + `${clean.endsOn ? ` (to ${clean.endsOn})` : ""}`,
  });
  rev(input.instrumentId);
  revalidatePath("/settings/agreements");
  return { id: row.id };
}

/**
 * Take a recorded third-party coverage row back off the record.
 *
 * Same three-way gate as recording it, plus one more: only rows with a
 * provider. Ours are removed from the agreements screen, by staff, with a
 * reason - deleting a commercial contract is not something a client's editor
 * does from an instrument page.
 */
export async function removeCoverage(id: number): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [row] = await db.select().from(agreements).where(eq(agreements.id, id));
  if (!row) return {};
  if (row.providerOrgId === null) return { error: "Not found" };
  if (!isStaffRole(u.role) && u.orgId !== row.orgId) return { error: "Not found" };
  const [prov] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, row.providerOrgId));
  await db.delete(agreements).where(eq(agreements.id, id));
  await audit({
    actor: u.email, entityType: "agreement", entityId: id, tenantOrgId: row.tenantOrgId,
    instrumentId: row.instrumentIds[0] ?? null,
    action: `removed ${prov?.name ?? "third-party"} coverage`,
  });
  rev(row.instrumentIds[0] ?? null);
  revalidatePath("/settings/agreements");
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

// ---------------- Invoices ----------------
// The bill for work that is finished. Nothing in this section writes a total,
// a balance or an amount due: the lines carry qty and unit price, payments
// carry what arrived, and every figure anybody reads is summed at render by
// lib/billing and lib/statement. The status column is the lifecycle word -
// sent, void, referred - and never an arithmetic result.

/**
 * Who at a client hears about their money. The digest recipient list is the
 * one place a client has already told us where their mail goes; the AP address
 * is added on top by the caller, because reminders belong at the desk that
 * pays rather than the lab that ordered.
 */
async function orgRecipients(orgId: number): Promise<string[]> {
  const [org] = await db.select({ list: orgs.digestRecipients }).from(orgs).where(eq(orgs.id, orgId));
  return org ? digestRecipientList(org.list) : [];
}

/** Where an invoice is read, so a write shows up everywhere it appears. */
function revInvoice(inv: { id: number; workOrderId: number | null }) {
  revalidatePath(`/money/invoices/${inv.id}`);
  revalidatePath("/money");
  if (inv.workOrderId) revalidatePath(`/work/${inv.workOrderId}`);
}

/**
 * Compose the bill for a closed job, and write it as a draft.
 *
 * The lines are built by the same loader the draft page rendered, not posted
 * back from the form: what somebody looked at and what gets written come from
 * one place, so a stale page cannot invoice last week's numbers.
 *
 * Numbers race, exactly as work order numbers do - two drafts in the same
 * second read the same highest number. The unique index is what makes that a
 * failed insert rather than two bills called INV-0094, and this retries.
 */
export async function draftInvoice(workOrderId: number): Promise<{ error?: string; id?: number }> {
  const u = await requireStaff();
  const found = await loadWorkOrder(u, workOrderId);
  if ("error" in found) return found;
  const { wo } = found;
  if (wo.orgId === null) return { error: "This job has no client on it - an invoice needs somebody to bill." };

  // A deposit invoice raised by a quote's approval carries this job's id, but
  // it is not THE job's invoice - it is half the money arriving early. It
  // must neither block the final bill nor be forgotten by it; the arithmetic
  // and its reasoning live in lib/invoiceData.depositOffsetsFor.
  const { depositInvoiceIds, offsets } = await depositOffsetsFor(workOrderId);

  const existing = (await db.select().from(invoices)
    .where(and(eq(invoices.workOrderId, workOrderId), ne(invoices.status, "void"))))
    .filter((i) => !depositInvoiceIds.has(i.id));
  if (existing.length) {
    return { error: `${wo.number} is already on ${existing[0].number}.` };
  }

  const src = await draftSourceFor(workOrderId);
  if (!src) return { error: "Not found" };

  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const used = await db.select({ number: invoices.number }).from(invoices)
      .where(forTenant(invoices.tenantOrgId, wo.tenantOrgId));
    const number = nextWoNumber(used.map((r) => r.number), src.context.invoicePrefix);
    try {
      const [inv] = await db.insert(invoices).values({
        tenantOrgId: wo.tenantOrgId, orgId: wo.orgId, workOrderId,
        agreementId: src.coverage.agreementId,
        number, status: "draft",
        poNumber: src.org?.poNumber ?? "",
        createdBy: u.email,
      }).returning();
      if (src.lines.length) {
        await db.insert(invoiceLines).values(src.lines.map((l, i) => ({
          invoiceId: inv.id, kind: l.kind, description: l.description,
          // Thousandths: 4.5 hours is 4500 and no part of a bill is a float.
          qty: Math.round(l.qty * 1000), unitCents: l.unitCents,
          covered: l.covered, coveredBy: l.coveredBy ?? "",
          sourceId: l.sourceId, position: i,
        })));
      }
      if (offsets.length) {
        await db.insert(invoiceLines).values(offsets.map((o, i) => ({
          invoiceId: inv.id, kind: "fee_ref",
          description: `Less deposit invoiced on ${o.quoteNumber}`,
          detail: `${o.number} - ${formatCents(o.cents)} billed at approval`,
          qty: 1000, unitCents: -o.cents, covered: false,
          sourceId: null, position: src.lines.length + i,
        })));
      }
      const total = linesTotal(src.lines) - offsets.reduce((n, o) => n + o.cents, 0);
      await audit({
        actor: u.email, instrumentId: wo.instrumentId, assetId: wo.assetId,
        entityType: "invoice", entityId: inv.id, tenantOrgId: wo.tenantOrgId,
        action: `drafted ${number} from ${wo.number}: ${src.lines.length} line${src.lines.length === 1 ? "" : "s"}, ${formatCents(total)}`
          + (offsets.length ? ` after ${formatCents(offsets.reduce((n, o) => n + o.cents, 0))} of deposit` : "")
          + (src.coverage.agreementNumber && total === 0 ? ` - covered by ${src.coverage.agreementNumber}` : ""),
      });
      revInvoice(inv);
      return { id: inv.id };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** The two fields a draft is edited on before it goes out. */
export async function updateInvoice(
  id: number, data: { poNumber?: string; note?: string },
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
  if (!inv) return { error: "Not found" };
  const patch: Partial<typeof invoices.$inferInsert> = { updatedAt: new Date() };
  const changes: string[] = [];
  if (data.poNumber !== undefined && data.poNumber.trim() !== inv.poNumber) {
    patch.poNumber = data.poNumber.trim();
    changes.push(`PO ${patch.poNumber || "cleared"}`);
  }
  if (data.note !== undefined && data.note.trim() !== inv.note) {
    patch.note = data.note.trim();
    changes.push("note");
  }
  if (!changes.length) return {};
  await db.update(invoices).set(patch).where(eq(invoices.id, id));
  await audit({
    actor: u.email, entityType: "invoice", entityId: id, tenantOrgId: inv.tenantOrgId,
    action: `edited ${inv.number}: ${changes.join(", ")}`,
  });
  revInvoice(inv);
  return {};
}

/**
 * Take a line off a draft.
 *
 * Only off a DRAFT. An invoice that changed after it was sent is one nobody
 * can reconcile against the copy in their inbox - past send, the way to
 * remove money is a credit line, which leaves both facts on the record.
 */
export async function removeInvoiceLine(lineId: number, reason: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.id, lineId));
  if (!line) return {};
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, line.invoiceId));
  if (!inv) return { error: "Not found" };
  if (inv.status !== "draft") return { error: `${inv.number} has been sent - issue a credit line instead of editing it.` };
  await db.delete(invoiceLines).where(eq(invoiceLines.id, lineId));
  await audit({
    actor: u.email, entityType: "invoice", entityId: inv.id, tenantOrgId: inv.tenantOrgId,
    action: `removed a line from ${inv.number}: ${line.description} - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revInvoice(inv);
  return {};
}

/**
 * Issue it: stamp the date, apply the client's terms, open a share link and
 * mail it.
 *
 * The link is how the client reads the bill, and its open event is the Viewed
 * signal on the timeline - there is no second tracker, because a second
 * tracker is a second answer to "did they see it". Mail failing does not
 * un-issue the invoice; the link exists either way and the error says so.
 */
export async function sendInvoice(id: number): Promise<{ error?: string; token?: string; warning?: string }> {
  const u = await requireStaff();
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
  if (!inv) return { error: "Not found" };
  if (inv.status !== "draft") return { error: `${inv.number} has already been sent.` };
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id));
  if (!lines.length) return { error: "There is nothing on this invoice to send." };

  const [org] = await db.select().from(orgs).where(eq(orgs.id, inv.orgId));
  const issuedOn = shopToday();
  const dueOn = dueFor(org ?? null, issuedOn);

  const token = crypto.randomBytes(18).toString("base64url");
  const [link] = await db.insert(shareLinks).values({
    token, kind: "invoice", orgId: inv.orgId, invoiceId: inv.id,
    label: `Invoice ${inv.number}`,
    // A bill stays readable well past its due date: a link that dies at day 30
    // is a link that dies exactly when collections starts needing it.
    expiresOn: addDays(issuedOn, 365),
    tenantOrgId: inv.tenantOrgId, createdBy: u.email,
  }).returning();

  await db.update(invoices).set({ status: "sent", issuedOn, dueOn, updatedAt: new Date() })
    .where(eq(invoices.id, id));

  const total = linesTotal(lines.map((l) => ({
    kind: "part" as const, description: "", qty: l.qty / 1000,
    unitCents: l.unitCents, covered: l.covered, sourceId: null,
  })));
  await audit({
    actor: u.email, entityType: "invoice", entityId: id, tenantOrgId: inv.tenantOrgId,
    action: `sent ${inv.number} to ${org?.name ?? "the client"}: ${formatCents(total)}, due ${dueOn}`,
  });

  const warning = await mailInvoice({ inv, org: org ?? null, token, total, dueOn })
    .then(() => "")
    .catch(() => "The invoice is issued and the link works, but the email did not go out.");
  revInvoice(inv);
  return { token, ...(warning ? { warning } : {}) };
}

/**
 * The email itself. Threaded per client through lib/emailThread, so this
 * month's invoice and last month's are one conversation rather than twelve
 * lookalike messages, and addressed to the AP contact when there is one -
 * reminders go to the desk that pays, not the lab that ordered.
 */
async function mailInvoice(opts: {
  inv: typeof invoices.$inferSelect;
  org: typeof orgs.$inferSelect | null;
  token: string; total: number; dueOn: string;
}): Promise<void> {
  const { inv, org } = opts;
  const to = [org?.apEmail?.trim(), ...(await orgRecipients(inv.orgId))].filter(Boolean) as string[];
  if (!to.length) return;
  const base = appUrl();
  if (!base) return;
  const brand = await brandForTenant(inv.tenantOrgId);
  const href = `${base}/share/${opts.token}`;
  const html = emailShell({
    brand: brand.operatorName || brand.name,
    logoUrl: brand.operatorLogoUrl || undefined,
    tagline: brand.tagline || undefined,
    preheader: `Invoice ${inv.number} - ${formatCents(opts.total)}, due ${opts.dueOn}`,
    body: `<p style="margin:0 0 12px;"><strong>Invoice ${esc(inv.number)}</strong></p>`
      + `<p style="margin:0 0 16px;">${esc(formatCents(opts.total))}, due ${esc(opts.dueOn)}.</p>`
      + btn(href, "View the invoice"),
    footer: `Questions about a line? Reply to this message and we will pause that line while the rest stays due.`,
  });
  const root = threadRootId(`invoice-org-${inv.orgId}`, mailHost(process.env.EMAIL_FROM));
  await sendEmail([...new Set(to)], `${brand.name}: invoice ${inv.number}`, html, {
    headers: threadHeaders(root),
    text: `Invoice ${inv.number} - ${formatCents(opts.total)}, due ${opts.dueOn}.\n${href}`,
  });
}

/**
 * Money arrived. Never edits a line and never edits another payment: a
 * mistake is corrected by a second row, so the ledger reads as what happened
 * rather than as what somebody last decided it should look like.
 *
 * The status column is nudged to partial or paid for the sake of a list that
 * has not summed anything yet; lib/statement still reconciles it against the
 * rows, and the rows win.
 */
export async function recordPayment(
  invoiceId: number,
  data: { method: string; amount: string; reference: string; receivedOn: string },
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const cents = parseMoney(data.amount);
  if (cents === null || cents <= 0) return { error: "Enter an amount like 840.00" };
  const day = data.receivedOn.trim();
  if (!isIsoDay(day)) return { error: "Pick the date it arrived" };
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) return { error: "Not found" };
  if (inv.status === "draft") return { error: `${inv.number} has not been sent yet.` };
  const method = (PAYMENT_METHODS as readonly string[]).includes(data.method) ? data.method : "other";

  const [row] = await db.insert(payments).values({
    tenantOrgId: inv.tenantOrgId, invoiceId, method, amountCents: cents,
    reference: data.reference.trim(), receivedOn: day, recordedBy: u.email,
  }).returning();

  const full = await invoiceById(invoiceId);
  const view = full ? invoiceView(asStatementRow(full), shopToday()) : null;
  if (view && inv.status !== "void" && inv.status !== "referred") {
    const next = view.balanceCents <= 0 ? "paid" : "partial";
    if (next !== inv.status) {
      await db.update(invoices).set({ status: next, updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
    }
  }
  await audit({
    actor: u.email, entityType: "invoice", entityId: invoiceId, tenantOrgId: inv.tenantOrgId,
    action: `recorded ${formatCents(cents)} by ${METHOD_LABEL[method].toLowerCase()} on ${inv.number}`
      + (row.reference ? ` (${row.reference})` : "")
      + (view ? ` - ${view.balanceCents <= 0 ? "paid in full" : `${formatCents(view.balanceCents)} still open`}` : ""),
  });
  revInvoice(inv);
  return {};
}

/** Undo a payment that was never really there. Audited with the reason. */
export async function deletePayment(id: number, reason: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [row] = await db.select().from(payments).where(eq(payments.id, id));
  if (!row) return {};
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, row.invoiceId));
  await db.delete(payments).where(eq(payments.id, id));
  if (inv) {
    await audit({
      actor: u.email, entityType: "invoice", entityId: inv.id, tenantOrgId: inv.tenantOrgId,
      action: `removed a ${formatCents(row.amountCents)} payment from ${inv.number} - reason: ${why}`,
      field: "reason", newValue: why,
    });
    revInvoice(inv);
  }
  return {};
}

/**
 * Void it. The row and its lines stay: an invoice number that vanishes is a
 * gap somebody has to explain to an auditor, and "voided on the 3rd because
 * it was billed to the wrong site" is the explanation.
 */
export async function voidInvoice(id: number, reason: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
  if (!inv) return { error: "Not found" };
  if (inv.status === "void") return {};
  const paid = await db.select().from(payments).where(eq(payments.invoiceId, id));
  if (paid.length) return { error: `${inv.number} has payments against it - remove those first.` };
  await db.update(invoices).set({ status: "void", updatedAt: new Date() }).where(eq(invoices.id, id));
  await db.update(shareLinks).set({ revokedAt: new Date() }).where(eq(shareLinks.invoiceId, id));
  await audit({
    actor: u.email, entityType: "invoice", entityId: id, tenantOrgId: inv.tenantOrgId,
    action: `voided ${inv.number} - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revInvoice(inv);
  return {};
}

// ---------------- Collections ----------------
// Fees, promises, disputes, the ladder, and the decision to work for somebody
// who owes money anyway. Nothing here stores a balance either: a fee is its
// own row, a waiver flags that row, and what is owed is still summed at render.

/**
 * Post the late charge this invoice has earned.
 *
 * The amount is computed here, not posted from the form: what somebody was
 * shown and what gets charged come from one function, so a page left open
 * cannot charge last week's interest. The basis sentence is stored with it -
 * "1.50% per month on $3,900 undisputed, 31 days past the 10-day grace
 * period" - because a year from now that is the only thing that can explain
 * the number.
 */
export async function postFee(invoiceId: number): Promise<{ error?: string; amountCents?: number }> {
  const u = await requireStaff();
  const full = await invoiceById(invoiceId);
  if (!full) return { error: "Not found" };
  const today = shopToday();
  const view = invoiceView(asStatementRow(full), today);
  const { policy } = await billingContext(full.row.orgId);

  const quote = feeFor({
    policy, dueOn: full.row.dueOn, today,
    payableCents: view.payableCents,
    partsCents: full.lines.filter((l) => l.kind === "part" && !l.covered)
      .reduce((n, l) => n + Math.round((l.qty / 1000) * l.unitCents), 0),
    postedOn: full.fees.filter((f) => !f.waived).map((f) => f.postedOn),
  });
  if (quote.amountCents <= 0) return { error: quote.blocked || "There is no fee to post." };

  const [row] = await db.insert(invoiceFees).values({
    tenantOrgId: full.row.tenantOrgId, invoiceId,
    amountCents: quote.amountCents, basis: quote.basis,
    postedOn: today, postedBy: u.email,
  }).returning();
  await audit({
    actor: u.email, entityType: "invoice", entityId: invoiceId, tenantOrgId: full.row.tenantOrgId,
    action: `posted a late fee of ${formatCents(row.amountCents)} on ${full.row.number} - ${row.basis}`,
  });
  revInvoice(full.row);
  return { amountCents: row.amountCents };
}

/**
 * Take a fee back off.
 *
 * The row stays and gets flagged, because expecting to waive more than you
 * charge is the honest posture, and the record of having charged and then
 * waived is the part that is worth anything - in a dispute, and in deciding
 * whether the policy is set right at all.
 */
export async function waiveFee(feeId: number, reason: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [fee] = await db.select().from(invoiceFees).where(eq(invoiceFees.id, feeId));
  if (!fee) return { error: "Not found" };
  if (fee.waived) return {};
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, fee.invoiceId));
  await db.update(invoiceFees).set({ waived: true, waivedBy: u.email, waivedReason: why })
    .where(eq(invoiceFees.id, feeId));
  await audit({
    actor: u.email, entityType: "invoice", entityId: fee.invoiceId, tenantOrgId: fee.tenantOrgId,
    action: `waived the ${formatCents(fee.amountCents)} late fee on ${inv?.number ?? "the invoice"} - reason: ${why}`,
    field: "reason", newValue: why,
  });
  if (inv) revInvoice(inv);
  return {};
}

/**
 * "The check goes out Friday." Worth a row for one reason: the morning after
 * it is broken is when the conversation changes, and nobody remembers the
 * date without one.
 */
export async function logPromise(
  invoiceId: number, data: { promisedOn: string; byName: string; note: string },
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const day = data.promisedOn.trim();
  if (!isIsoDay(day)) return { error: "Pick the day they said" };
  const who = data.byName.trim();
  if (!who) return { error: "Who said it? A promise with no name on it is a note." };
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) return { error: "Not found" };
  const [row] = await db.insert(promises).values({
    tenantOrgId: inv.tenantOrgId, invoiceId, promisedOn: day,
    byName: who, note: data.note.trim(), loggedBy: u.email,
  }).returning();
  await audit({
    actor: u.email, entityType: "invoice", entityId: invoiceId, tenantOrgId: inv.tenantOrgId,
    action: `logged a promise on ${inv.number}: ${who} says by ${day}${row.note ? ` - ${row.note}` : ""}`,
  });
  revInvoice(inv);
  return {};
}

/** They paid it. Closes the promise so the ladder stops escalating on it. */
export async function keepPromise(promiseId: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [row] = await db.select().from(promises).where(eq(promises.id, promiseId));
  if (!row) return { error: "Not found" };
  if (row.keptOn) return {};
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, row.invoiceId));
  const today = shopToday();
  await db.update(promises).set({ keptOn: today }).where(eq(promises.id, promiseId));
  await audit({
    actor: u.email, entityType: "invoice", entityId: row.invoiceId, tenantOrgId: row.tenantOrgId,
    action: `${row.byName || "The client"} kept the promise on ${inv?.number ?? "the invoice"} (${row.promisedOn})`,
  });
  if (inv) revInvoice(inv);
  return {};
}

/**
 * The client has questioned a line.
 *
 * It pauses what the reminders ASK for on that line alone. The undisputed
 * remainder keeps aging and keeps being chased, because a fair question about
 * one cartridge must not buy ninety quiet days on the rest of the bill - and
 * quoting the whole number at somebody who raised a real question is how the
 * rest of the invoice stops getting paid too.
 */
export async function openDispute(
  invoiceId: number, data: { lineId: number | null; reason: string },
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const why = requireReason(data.reason);
  if (typeof why !== "string") return why;
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) return { error: "Not found" };
  let line: typeof invoiceLines.$inferSelect | undefined;
  if (data.lineId !== null) {
    [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.id, data.lineId));
    if (!line || line.invoiceId !== invoiceId) return { error: "That line is not on this invoice" };
  }
  const [row] = await db.insert(disputes).values({
    tenantOrgId: inv.tenantOrgId, invoiceId, lineId: line?.id ?? null,
    reason: why, openedOn: shopToday(), openedBy: u.email,
  }).returning();
  await audit({
    actor: u.email, entityType: "invoice", entityId: invoiceId, tenantOrgId: inv.tenantOrgId,
    action: `opened a dispute on ${inv.number}${line ? `, line "${line.description}"` : ""} - ${row.reason}`,
    field: "reason", newValue: row.reason,
  });
  revInvoice(inv);
  return {};
}

/**
 * Settle it, one of two ways.
 *
 * "kept" means the line stands and the pause lifts. "credited" issues a
 * NEGATIVE line rather than editing the disputed one, so the invoice still
 * reconciles against the copy in the client's inbox and both facts - what was
 * charged and what was given back - stay on the record.
 */
export async function resolveDispute(
  disputeId: number, resolution: "kept" | "credited", note: string,
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [d] = await db.select().from(disputes).where(eq(disputes.id, disputeId));
  if (!d) return { error: "Not found" };
  if (d.resolvedOn) return {};
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, d.invoiceId));
  if (!inv) return { error: "Not found" };
  const today = shopToday();

  let credited = 0;
  if (resolution === "credited") {
    const [line] = d.lineId === null ? [undefined]
      : await db.select().from(invoiceLines).where(eq(invoiceLines.id, d.lineId));
    if (!line) return { error: "There is no line to credit - resolve it as kept, or credit by hand." };
    credited = Math.round((line.qty / 1000) * line.unitCents);
    const [last] = await db.select({ position: invoiceLines.position }).from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, d.invoiceId)).orderBy(desc(invoiceLines.position)).limit(1);
    await db.insert(invoiceLines).values({
      invoiceId: d.invoiceId, kind: "fee_ref",
      description: `Credit memo - ${line.description}`,
      detail: note.trim() || `dispute opened ${d.openedOn}`,
      qty: 1000, unitCents: -credited, covered: false,
      sourceId: line.id, position: (last?.position ?? 0) + 1,
    });
  }

  await db.update(disputes).set({
    resolvedOn: today, resolution, resolvedBy: u.email,
    reason: note.trim() ? `${d.reason} | resolved: ${note.trim()}` : d.reason,
  }).where(eq(disputes.id, disputeId));

  await audit({
    actor: u.email, entityType: "invoice", entityId: d.invoiceId, tenantOrgId: inv.tenantOrgId,
    action: resolution === "credited"
      ? `resolved a dispute on ${inv.number} with a credit of ${formatCents(credited)}${note.trim() ? ` - ${note.trim()}` : ""}`
      : `resolved a dispute on ${inv.number}: the line stands${note.trim() ? ` - ${note.trim()}` : ""}`,
  });
  revInvoice(inv);
  return {};
}

/**
 * Work for somebody who owes money anyway.
 *
 * The reason is required BY THE ACTION, not by the form - the same rule
 * toggleStage's blocked-reason follows, and for the same reason: a check that
 * lives only in the UI is a check that is not there.
 */
export async function overrideCreditHold(
  orgId: number, data: { reason: string; untilOn: string },
): Promise<{ error?: string }> {
  const u = await requireOwner();
  const why = requireReason(data.reason);
  if (typeof why !== "string") return why;
  const until = data.untilOn.trim();
  if (until && !isIsoDay(until)) return { error: "Pick a date, or leave it open-ended" };
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };
  await db.insert(creditOverrides).values({
    tenantOrgId: myTenantOrgId(u), orgId, reason: why,
    untilOn: until, grantedBy: u.email,
  });
  await audit({
    actor: u.email, entityType: "org", entityId: orgId, tenantOrgId: myTenantOrgId(u),
    action: `overrode the credit hold on ${org.name}${until ? ` until ${until}` : ""} - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revalidatePath("/money");
  revalidatePath("/work");
  return {};
}

/** Put the hold back on before its date runs out. */
export async function liftCreditOverride(id: number): Promise<{ error?: string }> {
  const u = await requireOwner();
  const [row] = await db.select().from(creditOverrides).where(eq(creditOverrides.id, id));
  if (!row || row.liftedAt !== null) return {};
  const [org] = await db.select().from(orgs).where(eq(orgs.id, row.orgId));
  await db.update(creditOverrides).set({ liftedAt: new Date() }).where(eq(creditOverrides.id, id));
  await audit({
    actor: u.email, entityType: "org", entityId: row.orgId, tenantOrgId: row.tenantOrgId,
    action: `ended the credit-hold override on ${org?.name ?? "the client"}`,
  });
  revalidatePath("/money");
  revalidatePath("/work");
  return {};
}

/**
 * Climb one rung: send it, and write the row that says it was sent.
 *
 * Shared by the cron and the "Send now" button, so an automatic reminder and a
 * hand-pressed one are the same thing on the record. Reminders thread under
 * the invoice's original send, so a client's inbox holds one conversation per
 * bill instead of six lookalike messages.
 */
export async function sendDunningRung(
  invoiceId: number, opts: { actor?: string } = {},
): Promise<{ error?: string; rung?: string }> {
  const actor = opts.actor ?? (await requireStaff()).email;
  const full = await invoiceById(invoiceId);
  if (!full) return { error: "Not found" };
  const today = shopToday();
  const view = invoiceView(asStatementRow(full), today);
  if (!isOpen(view)) return { error: `${full.row.number} is not open.` };
  if (isReferred(full.dunning.map((d) => ({ rung: d.rung, sentOn: d.sentOn })))) {
    return { error: `${full.row.number} has been referred - it is off the ladder.` };
  }

  const { policy } = await billingContext(full.row.orgId);
  const brokenPromise = full.promises.some((p) => promiseBroken(
    { promisedOn: p.promisedOn, byName: p.byName, keptOn: p.keptOn }, today,
  ));
  const step = nextAction({
    dueOn: full.row.dueOn, today, policy,
    log: full.dunning.map((d) => ({ rung: d.rung, sentOn: d.sentOn })),
    promiseBroken: brokenPromise,
  });
  if (!step) return { error: "Nothing is due on this invoice today." };

  const [org] = await db.select().from(orgs).where(eq(orgs.id, full.row.orgId));
  const to = [
    step.contact?.email?.trim(),
    // Past the first rung the AP desk is the destination; before it, whoever
    // has been getting the mail.
    step.rung.contactIndex >= 0 ? org?.apEmail?.trim() : "",
    ...(await orgRecipients(full.row.orgId)),
  ].filter(Boolean) as string[];

  const warning = to.length
    ? await mailDunning({ full, org: org ?? null, step, view, policy })
        .then(() => "").catch(() => "sent, but the email did not go out")
    : "nobody to send it to";

  await db.insert(dunningEvents).values({
    tenantOrgId: full.row.tenantOrgId, invoiceId,
    rung: step.rung.key,
    toName: step.contact?.name ?? org?.name ?? "",
    toEmail: to[0] ?? "",
    sentBy: opts.actor ? "auto" : actor,
    note: warning, sentOn: today,
  });
  await audit({
    actor, entityType: "invoice", entityId: invoiceId, tenantOrgId: full.row.tenantOrgId,
    action: `${step.rung.action.toLowerCase()} on ${full.row.number}`
      + `${step.contact ? ` to ${step.contact.name}, ${step.contact.role.toLowerCase()}` : ""}`
      + ` - ${formatCents(view.payableCents)} outstanding`
      + (brokenPromise ? " (escalated: a promise was broken)" : "")
      + (warning ? ` [${warning}]` : ""),
  });
  revInvoice(full.row);
  return { rung: step.rung.key };
}

/** The reminder itself, threaded under the invoice's original send. */
async function mailDunning(opts: {
  full: NonNullable<Awaited<ReturnType<typeof invoiceById>>>;
  org: typeof orgs.$inferSelect | null;
  step: NonNullable<ReturnType<typeof nextAction>>;
  view: ReturnType<typeof invoiceView>;
  policy: BillingPolicy;
}): Promise<void> {
  const { full, org, step, view } = opts;
  const base = appUrl();
  const brand = await brandForTenant(full.row.tenantOrgId);
  const [link] = await db.select().from(shareLinks)
    .where(and(eq(shareLinks.invoiceId, full.row.id), isNull(shareLinks.revokedAt)));
  const href = base && link ? `${base}/share/${link.token}` : "";

  // The reminder quotes what is actually being ASKED for. On an invoice with a
  // disputed line that is the undisputed remainder, and saying the whole
  // number at somebody who raised a fair question is how the rest stops
  // getting paid too.
  const asking = formatCents(view.payableCents);
  const disputedNote = view.disputedCents > 0
    ? `<p style="margin:0 0 12px;">${esc(formatCents(view.disputedCents))} is paused while we sort out the line you asked about. The figure above is the rest.</p>`
    : "";
  const to = [
    step.contact?.email?.trim(),
    step.rung.contactIndex >= 0 ? org?.apEmail?.trim() : "",
    ...(await orgRecipients(full.row.orgId)),
  ].filter(Boolean) as string[];

  const html = emailShell({
    brand: brand.operatorName || brand.name,
    logoUrl: brand.operatorLogoUrl || undefined,
    tagline: brand.tagline || undefined,
    preheader: `${full.row.number} - ${asking}${view.daysLate > 0 ? `, ${view.daysLate} days past due` : ""}`,
    body: `<p style="margin:0 0 12px;"><strong>Invoice ${esc(full.row.number)}</strong></p>`
      + `<p style="margin:0 0 12px;">${esc(asking)} ${view.daysLate > 0
        ? `is ${view.daysLate} day${view.daysLate === 1 ? "" : "s"} past due (due ${esc(full.row.dueOn)}).`
        : `is due ${esc(full.row.dueOn)}.`}</p>`
      + disputedNote
      + (href ? btn(href, "View the invoice") : ""),
    footer: "Question a line? Reply and we will pause that line while we sort it out; the rest stays due.",
  });
  const root = threadRootId(`invoice-org-${full.row.orgId}`, mailHost(process.env.EMAIL_FROM));
  await sendEmail([...new Set(to)], `${brand.operatorName || brand.name}: invoice ${full.row.number}`, html, {
    headers: threadHeaders(root),
    text: `Invoice ${full.row.number} - ${asking}${view.daysLate > 0 ? `, ${view.daysLate} days past due` : ""}.`
      + (href ? `\n${href}` : ""),
  });
}

/**
 * Mark it referred: off the ladder, out of the reminders, into a packet
 * somebody exports and hands to an agency or a small-claims filing.
 */
export async function referInvoice(id: number, reason: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
  if (!inv) return { error: "Not found" };
  if (inv.status === "referred") return {};
  await db.update(invoices).set({ status: "referred", updatedAt: new Date() }).where(eq(invoices.id, id));
  await db.insert(dunningEvents).values({
    tenantOrgId: inv.tenantOrgId, invoiceId: id, rung: "refer",
    toName: "", toEmail: "", sentBy: u.email, note: why, sentOn: shopToday(),
  });
  await audit({
    actor: u.email, entityType: "invoice", entityId: id, tenantOrgId: inv.tenantOrgId,
    action: `referred ${inv.number} for collection - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revInvoice(inv);
  return {};
}

// ---------------- Quotes ----------------
// A price, offered - composed by the same function that composes an invoice,
// from the same rows, so what was quoted and what gets billed cannot drift.
// The three answering actions are TOKEN-GATED: the person pressing them is the
// client, holding a share link and no account, so the token is the credential
// and the org on its row is the authorization.

function revQuote(q: { id: number; workOrderId: number | null }) {
  revalidatePath(`/money/quotes/${q.id}`);
  revalidatePath("/money/quotes");
  revalidatePath("/money");
  if (q.workOrderId) revalidatePath(`/work/${q.workOrderId}`);
  // The client's side of the same quote. It worked before only because both
  // portal pages are force-dynamic, which is a property of those files rather
  // than a decision made here - and the client landing now counts unanswered
  // quotes, so a stale one would keep telling them to answer something they
  // already answered.
  revalidatePath(`/orders/q/${q.id}`);
  revalidatePath("/orders");
  revalidatePath("/");
}

/**
 * Price a job that has not been done yet.
 *
 * Same composer as the invoice: the parts somebody listed as needed, the hours
 * estimated against the job, the rate card that client is on. A quote whose
 * arithmetic is a second implementation is a quote that disagrees with its own
 * invoice six weeks later.
 */
export async function draftQuote(
  workOrderId: number, data: { depositPct: number; expiresOn: string; title: string },
): Promise<{ error?: string; id?: number }> {
  const u = await requireStaff();
  const found = await loadWorkOrder(u, workOrderId);
  if ("error" in found) return found;
  const { wo } = found;
  if (wo.orgId === null) return { error: "This job has no client on it - a quote needs somebody to send it to." };

  const expires = data.expiresOn.trim();
  if (!isIsoDay(expires)) return { error: "Pick the day it stops being good for" };
  const pct = Math.max(0, Math.min(100, Math.round(data.depositPct)));

  const src = await draftSourceFor(workOrderId);
  if (!src) return { error: "Not found" };
  // An empty job quotes fine: a fixed-price move or install is priced by
  // TYPING lines on the quote draft, not by pre-logging hours nobody has
  // worked. What matters is keeping the quote ON the job either way - that
  // link is what flips the job active on approval and what lets the final
  // invoice subtract the deposit.

  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const used = await db.select({ number: quotes.number }).from(quotes)
      .where(forTenant(quotes.tenantOrgId, wo.tenantOrgId));
    const number = nextWoNumber(used.map((r) => r.number), "Q-");
    try {
      const [q] = await db.insert(quotes).values({
        tenantOrgId: wo.tenantOrgId, orgId: wo.orgId, workOrderId,
        agreementId: src.coverage.agreementId,
        number, status: "draft",
        title: data.title.trim() || wo.title,
        expiresOn: expires, depositPct: pct, createdBy: u.email,
      }).returning();
      await db.insert(quoteLines).values(src.lines.map((l, i) => ({
        quoteId: q.id, kind: l.kind, description: l.description,
        qty: Math.round(l.qty * 1000), unitCents: l.unitCents,
        covered: l.covered, coveredBy: l.coveredBy ?? "",
        sourceId: l.sourceId, position: i,
      })));
      const total = linesTotal(src.lines);
      await audit({
        actor: u.email, instrumentId: wo.instrumentId, assetId: wo.assetId,
        entityType: "quote", entityId: q.id, tenantOrgId: wo.tenantOrgId,
        action: `drafted ${number} from ${wo.number}: ${formatCents(total)}`
          + (pct > 0 ? `, ${pct}% deposit on approval` : "") + `, good to ${expires}`,
      });
      revQuote(q);
      return { id: q.id };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** Open the link and mail it. The client answers on the link, not by reply. */
export async function sendQuote(id: number): Promise<{ error?: string; token?: string; warning?: string }> {
  const u = await requireStaff();
  const [q] = await db.select().from(quotes).where(eq(quotes.id, id));
  if (!q) return { error: "Not found" };
  if (q.status !== "draft") return { error: `${q.number} has already been sent.` };
  const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, id));
  if (!lines.length) return { error: "There is nothing on this quote to send." };

  const [org] = await db.select().from(orgs).where(eq(orgs.id, q.orgId));
  const today = shopToday();
  const token = crypto.randomBytes(18).toString("base64url");
  await db.insert(shareLinks).values({
    token, kind: "quote", orgId: q.orgId, quoteId: q.id,
    label: `Quote ${q.number}`,
    // Outliving the quote itself on purpose: a link that dies the same day
    // leaves a client staring at "no longer active" with no idea what lapsed.
    expiresOn: addDays(q.expiresOn || today, 30),
    tenantOrgId: q.tenantOrgId, createdBy: u.email,
  });
  await db.update(quotes).set({ status: "sent", sentOn: today, updatedAt: new Date() })
    .where(eq(quotes.id, id));

  const total = lines.reduce((n, l) => n + (l.covered ? 0 : Math.round((l.qty / 1000) * l.unitCents)), 0);
  await audit({
    actor: u.email, entityType: "quote", entityId: id, tenantOrgId: q.tenantOrgId,
    action: `sent ${q.number} to ${org?.name ?? "the client"}: ${formatCents(total)}, expires ${q.expiresOn}`,
  });

  const warning = await mailQuote({ q, org: org ?? null, token, total })
    .then(() => "")
    .catch(() => "The quote is out and the link works, but the email did not go out.");
  revQuote(q);
  return { token, ...(warning ? { warning } : {}) };
}

async function mailQuote(opts: {
  q: typeof quotes.$inferSelect;
  org: typeof orgs.$inferSelect | null;
  token: string; total: number;
}): Promise<void> {
  const { q, org } = opts;
  const to = [org?.apEmail?.trim(), ...(await orgRecipients(q.orgId))].filter(Boolean) as string[];
  if (!to.length) return;
  const base = appUrl();
  if (!base) return;
  const brand = await brandForTenant(q.tenantOrgId);
  const href = `${base}/share/${opts.token}`;
  const { policy } = await billingContext(q.orgId);
  const clause = feeClause(policy);
  const html = emailShell({
    brand: brand.operatorName || brand.name,
    logoUrl: brand.operatorLogoUrl || undefined,
    tagline: brand.tagline || undefined,
    preheader: `Quote ${q.number} - ${formatCents(opts.total)}, good to ${q.expiresOn}`,
    body: `<p style="margin:0 0 12px;"><strong>Quote ${esc(q.number)}</strong>${q.title ? ` - ${esc(q.title)}` : ""}</p>`
      + `<p style="margin:0 0 16px;">${esc(formatCents(opts.total))}, good until ${esc(q.expiresOn)}.`
      + `${q.depositPct > 0 ? ` A ${q.depositPct}% deposit is invoiced on approval.` : ""}</p>`
      + btn(href, "Read it and answer"),
    // The clause prints because a late charge is only collectable if the terms
    // rode the paper the client agreed to.
    footer: clause || undefined,
  });
  const root = threadRootId(`quote-org-${q.orgId}`, mailHost(process.env.EMAIL_FROM));
  await sendEmail([...new Set(to)], `${brand.operatorName || brand.name}: quote ${q.number}`, html, {
    headers: threadHeaders(root),
    text: `Quote ${q.number} - ${formatCents(opts.total)}, good until ${q.expiresOn}.\n${href}`,
  });
}

/**
 * The token IS the credential. Everything a client-side quote action touches is
 * reached through the org id ON THE LINK'S ROW, never through an id in the
 * request - the same door the share viewer reads money through.
 */
async function quoteByToken(token: string, quoteId: number): Promise<
  { error: string } | { link: typeof shareLinks.$inferSelect; q: typeof quotes.$inferSelect }
> {
  if (!token || token.length < 12) return { error: "This link is not valid." };
  const [link] = await db.select().from(shareLinks).where(eq(shareLinks.token, token));
  if (!link || link.kind !== "quote" || link.orgId === null) return { error: "This link is not valid." };
  if (linkState(link, shopToday()) !== "active") return { error: "This link is no longer active." };
  const [q] = await db.select().from(quotes)
    .where(and(eq(quotes.id, quoteId), eq(quotes.orgId, link.orgId)));
  if (!q || link.quoteId !== q.id) return { error: "This link is not valid." };
  return { link, q };
}

export type QuoteAnswer = { error?: string; depositInvoiceId?: number; onHold?: boolean };

/**
 * The client says yes - everything that follows from it, once.
 *
 * Three things happen, in this order and all of them audited: the job is taken
 * off its wait, a deposit invoice is raised if the quote asked for one, and the
 * answer is written where the engineer will read it. If the client is on credit
 * hold the job is still recorded - it opens held, and the portal said so before
 * they pressed the button.
 *
 * This is the core, with no authorization in it at all. Two doors reach it and
 * they authorize differently - a public share token, or a signed-in client -
 * but what approval MEANS must not fork with the door, or one route eventually
 * grows a deposit rule the other does not have.
 *
 * Two things must stay inside here rather than move to a caller. The
 * `answerable` check is the only thing making approval idempotent: a double
 * submit after success is refused rather than raising a second deposit
 * invoice. And the total is re-read from the quote's own lines, so no caller
 * can hand in a figure.
 */
async function applyQuoteApproval(
  q: typeof quotes.$inferSelect,
  signedBy: string,
  /** The account behind the signature, when there is one. */
  actorEmail: string,
): Promise<QuoteAnswer> {
  const today = shopToday();
  if (!answerable(q, today)) return { error: `${q.number} is ${quoteStanding(q, today)} and cannot be answered.` };
  const who = signedBy.trim().slice(0, 120);
  if (!who) return { error: "Type your name to sign." };

  const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, q.id));
  const total = lines.reduce((n, l) => n + (l.covered ? 0 : Math.round((l.qty / 1000) * l.unitCents)), 0);
  const deposit = depositCents(total, q.depositPct);
  const credit = await creditFor(q.orgId, today).catch(() => null);

  let depositInvoiceId: number | null = null;
  if (deposit > 0) {
    const [org] = await db.select().from(orgs).where(eq(orgs.id, q.orgId));
    const ctx = await billingContext(q.orgId);
    for (let attempt = 0; attempt < 4; attempt++) {
      const used = await db.select({ number: invoices.number }).from(invoices)
        .where(forTenant(invoices.tenantOrgId, q.tenantOrgId));
      const number = nextWoNumber(used.map((r) => r.number), ctx.invoicePrefix);
      try {
        const [inv] = await db.insert(invoices).values({
          tenantOrgId: q.tenantOrgId, orgId: q.orgId, workOrderId: q.workOrderId,
          agreementId: q.agreementId, number, status: "sent",
          // Due immediately: a deposit that is net 30 is not a deposit.
          issuedOn: today, dueOn: today,
          poNumber: org?.poNumber ?? "",
          note: `${q.depositPct}% deposit on ${q.number}`,
          createdBy: "client approval",
        }).returning();
        await db.insert(invoiceLines).values({
          invoiceId: inv.id, kind: "fee_ref",
          description: `Deposit on ${q.number}`,
          detail: `${q.depositPct}% of ${formatCents(total)}, due on approval`,
          qty: 1000, unitCents: deposit, covered: false, sourceId: q.id, position: 0,
        });
        depositInvoiceId = inv.id;
        break;
      } catch { /* number raced; try the next one */ }
    }
  }

  await db.update(quotes).set({
    status: "approved", answeredOn: today, answeredBy: who,
    depositInvoiceId, updatedAt: new Date(),
  }).where(eq(quotes.id, q.id));

  // The job comes off its wait. There is no "Ready" state in this codebase -
  // a job waiting on the client's answer sits in `waiting`, and the answer
  // moves it to `active`, which is what Ready meant.
  if (q.workOrderId !== null) {
    const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, q.workOrderId));
    if (wo && wo.state === "waiting") {
      await db.update(workOrders).set({ state: "active" }).where(eq(workOrders.id, wo.id));
    }
    if (wo) {
      await db.insert(workOrderNotes).values({
        workOrderId: wo.id, author: who, authorEmail: actorEmail,
        text: `Approved ${q.number} (${formatCents(total)}).`
          + (deposit > 0 ? ` A ${q.depositPct}% deposit of ${formatCents(deposit)} was invoiced.` : "")
          + (credit?.onHold ? " The account is past due, so this opens on credit hold." : ""),
      });
    }
  }

  await audit({
    actor: who, entityType: "quote", entityId: q.id, tenantOrgId: q.tenantOrgId,
    action: `${who} approved ${q.number}: ${formatCents(total)}`
      + (deposit > 0 ? `, ${formatCents(deposit)} deposit invoiced` : "")
      + (credit?.onHold ? " - the job opens on credit hold" : ""),
  });
  revQuote(q);
  return { depositInvoiceId: depositInvoiceId ?? undefined, onHold: credit?.onHold ?? false };
}

/**
 * Approval through a public share link.
 *
 * The door for somebody who was emailed a quote and has no account. The link
 * is the whole authorization, which is why it is a long unguessable token
 * bound to one quote and one organization, and why the signature is typed
 * text: there is no session to attribute it to.
 */
export async function approveQuote(
  token: string, quoteId: number, signedBy: string,
): Promise<QuoteAnswer> {
  const found = await quoteByToken(token, quoteId);
  if ("error" in found) return found;
  const who = signedBy.trim().slice(0, 120);
  if (!who) return { error: "Type your name to sign." };
  return applyQuoteApproval(found.q, who, "");
}

/**
 * Approval by a signed-in client, without leaving their session.
 *
 * A logged-in client used to be handed a link to the PUBLIC share page to
 * approve their own quote - and if nobody had minted a share link, or somebody
 * had revoked one, they had no way to approve at all. Worse, the token route
 * authorizes by URL possession, so a `client_viewer` - read-only in every
 * other corner of this app - could accept four thousand dollars of work by
 * following a link somebody forwarded them.
 *
 * This door closes both. `requireEditor` refuses a viewer, `quoteForOrg` binds
 * the quote to the caller's own organization inside the query rather than
 * after it, and the signature is tied to a real account instead of being
 * whatever was typed into a box.
 */
export async function approveQuoteAsClient(
  quoteId: number, signedBy: string,
): Promise<QuoteAnswer> {
  let u;
  try {
    u = await requireEditor();
  } catch {
    // Deliberately the same words a viewer gets anywhere else, rather than
    // "you may not approve" - which would tell them a quote is there.
    return { error: "Your account is read-only. Ask a colleague who can approve." };
  }
  if (u.orgId === null) return { error: "This quote is not yours to answer." };
  const full = await quoteForOrg(quoteId, u.orgId);
  if (!full) return { error: "This quote is not yours to answer." };
  const who = (signedBy.trim() || u.name || u.email).slice(0, 120);
  return applyQuoteApproval(full.row, who, u.email);
}

/**
 * The client says no. The reason goes to the job's discussion, where the
 * engineer will read it - not into a field on a quote nobody opens again.
 */
async function applyQuoteDecline(
  q: typeof quotes.$inferSelect,
  who: string,
  why: string,
  actorEmail: string,
): Promise<{ error?: string }> {
  const today = shopToday();
  if (!answerable(q, today)) return { error: `${q.number} is ${quoteStanding(q, today)} and cannot be answered.` };

  await db.update(quotes).set({
    status: "declined", answeredOn: today, answeredBy: who,
    answerNote: why, updatedAt: new Date(),
  }).where(eq(quotes.id, q.id));

  if (q.workOrderId !== null) {
    await db.insert(workOrderNotes).values({
      workOrderId: q.workOrderId, author: who, authorEmail: actorEmail,
      text: `Declined ${q.number}.${why ? ` ${why}` : ""}`,
    });
  }
  await audit({
    actor: who, entityType: "quote", entityId: q.id, tenantOrgId: q.tenantOrgId,
    action: `${who} declined ${q.number}${why ? ` - ${why}` : ""}`,
    ...(why ? { field: "reason", newValue: why } : {}),
  });
  revQuote(q);
  return {};
}

/** Declining through a public share link. */
export async function declineQuote(
  token: string, quoteId: number, data: { by: string; reason: string },
): Promise<{ error?: string }> {
  const found = await quoteByToken(token, quoteId);
  if ("error" in found) return found;
  return applyQuoteDecline(
    found.q,
    data.by.trim().slice(0, 120) || "The client",
    data.reason.trim().slice(0, 2000),
    "",
  );
}

/**
 * Declining from inside a session. Same authority as approving: saying no to
 * quoted work is a decision about money, and it is recorded against a real
 * account rather than against whatever was typed into a box.
 */
export async function declineQuoteAsClient(
  quoteId: number, signedBy: string, reason: string,
): Promise<{ error?: string }> {
  let u;
  try {
    u = await requireEditor();
  } catch {
    return { error: "Your account is read-only. Ask a colleague who can answer this." };
  }
  if (u.orgId === null) return { error: "This quote is not yours to answer." };
  const full = await quoteForOrg(quoteId, u.orgId);
  if (!full) return { error: "This quote is not yours to answer." };
  return applyQuoteDecline(
    full.row,
    (signedBy.trim() || u.name || u.email).slice(0, 120),
    reason.trim().slice(0, 2000),
    u.email,
  );
}

/**
 * The client asks something instead of answering. It posts to the job's
 * discussion and leaves the quote answerable - a question is not a no, and
 * closing the quote because somebody asked about a line is how a sale is lost
 * to a misunderstanding.
 */
export async function askAboutQuote(
  token: string, quoteId: number, data: { by: string; question: string },
): Promise<{ error?: string }> {
  const found = await quoteByToken(token, quoteId);
  if ("error" in found) return found;
  const { q } = found;
  const text = data.question.trim().slice(0, 2000);
  if (text.length < 3) return { error: "Say a little more and we will answer it." };
  const who = data.by.trim().slice(0, 120) || "The client";

  if (q.workOrderId !== null) {
    await db.insert(workOrderNotes).values({
      workOrderId: q.workOrderId, author: who, authorEmail: "",
      text: `Question on ${q.number}: ${text}`,
    });
  }
  await audit({
    actor: who, entityType: "quote", entityId: q.id, tenantOrgId: q.tenantOrgId,
    action: `${who} asked about ${q.number}: ${text.slice(0, 200)}`,
  });
  revQuote(q);
  return {};
}

// ---------------- Billing settings ----------------

/**
 * The workspace's billing defaults. Owner only, every field audited by name -
 * "changed the late-fee rate" is the line somebody needs a year later, not
 * "updated settings".
 */
/**
 * The shop's travel rules, saved whole. The form posts every field, so the
 * resolver's fallback-to-default is the validation: a malformed number lands
 * on the default rather than in the column, and there is no partial patch
 * that could silently zero the fields it did not mention.
 */
export async function saveExpensePolicy(data: Record<string, unknown>): Promise<{ error?: string }> {
  const u = await requireOwner();
  const [row] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  const before = resolveExpensePolicy(row?.expensePolicy ?? null);
  const after = resolveExpensePolicy(data);
  await db.insert(appSettings).values({ id: 1, expensePolicy: after })
    .onConflictDoUpdate({ target: appSettings.id, set: { expensePolicy: after } });
  const changes = (Object.keys(after) as (keyof typeof after)[])
    .filter((k) => before[k] !== after[k]);
  await audit({
    actor: u.email, entityType: "settings", entityId: "expense-policy",
    action: changes.length ? `changed travel rules: ${changes.join(", ")}` : "saved travel rules unchanged",
  });
  revalidatePath("/settings/billing");
  return {};
}

export async function saveBillingDefaults(data: {
  policy: Record<string, unknown>;
  invoicePrefix?: string;
  loadedLabor?: string;
  platformFeeBps?: number;
}): Promise<{ error?: string }> {
  const u = await requireOwner();
  const [row] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  const before = resolvePolicy(row?.billingPolicy ?? null, null);
  const after = resolvePolicy(row?.billingPolicy ?? null, data.policy);

  const patch: Partial<typeof appSettings.$inferInsert> = { billingPolicy: after };
  const changes: string[] = [];
  for (const key of Object.keys(after) as (keyof typeof after)[]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes.push(String(key));
  }
  if (data.invoicePrefix !== undefined) {
    const prefix = data.invoicePrefix.trim().slice(0, 12);
    if (prefix && prefix !== row?.invoicePrefix) { patch.invoicePrefix = prefix; changes.push("invoice prefix"); }
  }
  if (data.loadedLabor !== undefined) {
    const cents = parseMoney(data.loadedLabor) ?? 0;
    if (cents !== row?.loadedLaborCents) { patch.loadedLaborCents = cents; changes.push("loaded labor rate"); }
  }
  if (data.platformFeeBps !== undefined) {
    const bps = Math.max(0, Math.min(500, Math.round(data.platformFeeBps)));
    if (bps !== row?.platformFeeBps) { patch.platformFeeBps = bps; changes.push("platform fee"); }
  }
  if (!changes.length) return {};

  await db.update(appSettings).set(patch).where(eq(appSettings.id, 1));
  await audit({
    actor: u.email, entityType: "settings", entityId: "billing",
    action: `changed the billing defaults: ${changes.join(", ")}`,
  });
  revalidatePath("/settings/billing");
  revalidatePath("/money");
  return {};
}

/**
 * One client's overrides. The same shape, one level down - defaults in
 * app_settings, per-org wins, exactly the layering the digest schedule uses,
 * so there is one place to say "what we do" and one per client to say
 * "except them".
 */
export async function saveOrgBilling(orgId: number, data: {
  policy?: Record<string, unknown>;
  termsDays?: number;
  apEmail?: string;
  poNumber?: string;
  poBalance?: string;
}): Promise<{ error?: string }> {
  const u = await requireOwner();
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };

  const patch: Partial<typeof orgs.$inferInsert> = {};
  const changes: string[] = [];
  if (data.policy !== undefined) {
    const [settings] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
    const before = resolvePolicy(settings?.billingPolicy ?? null, org.billingPolicy ?? null);
    const after = resolvePolicy(settings?.billingPolicy ?? null, data.policy);
    for (const key of Object.keys(after) as (keyof typeof after)[]) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes.push(String(key));
    }
    patch.billingPolicy = after;
  }
  if (data.termsDays !== undefined) {
    const n = Math.max(0, Math.min(180, Math.round(data.termsDays)));
    if (n !== org.termsDays) { patch.termsDays = n; changes.push(`terms to net ${n}`); }
  }
  if (data.apEmail !== undefined && data.apEmail.trim().toLowerCase() !== org.apEmail) {
    patch.apEmail = data.apEmail.trim().toLowerCase().slice(0, 200);
    changes.push("AP contact");
  }
  if (data.poNumber !== undefined && data.poNumber.trim() !== org.poNumber) {
    patch.poNumber = data.poNumber.trim().slice(0, 80);
    changes.push(patch.poNumber ? `PO ${patch.poNumber}` : "PO cleared");
  }
  if (data.poBalance !== undefined) {
    const cents = parseMoney(data.poBalance) ?? 0;
    if (cents !== org.poBalanceCents) { patch.poBalanceCents = cents; changes.push("PO balance"); }
  }
  if (!changes.length) return {};

  await db.update(orgs).set(patch).where(eq(orgs.id, orgId));
  await audit({
    actor: u.email, entityType: "org", entityId: orgId, tenantOrgId: myTenantOrgId(u),
    action: `changed ${org.name}'s billing: ${changes.join(", ")}`,
  });
  revalidatePath(`/settings/organizations/${orgId}`);
  revalidatePath("/money");
  return {};
}

/**
 * Start Stripe Connect onboarding for this workspace.
 *
 * Express, so Stripe does the identity checks on the operator rather than this
 * platform collecting bank details it has no business holding. The account is
 * THEIRS: money moves bank to bank and Ridgeline never holds funds.
 */
export async function connectStripe(returnUrl: string): Promise<{ error?: string; url?: string }> {
  const u = await requireOwner();
  if (!stripeConfigured()) {
    return { error: "This instance has no Stripe keys set. Add STRIPE_SECRET_KEY and try again." };
  }
  const orgId = myTenantOrgId(u);
  if (orgId === null) return { error: "This workspace has no organization to connect an account to." };
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };

  try {
    const accountId = org.stripeAccountId || await createConnectAccount(u.email);
    if (!org.stripeAccountId) {
      await db.update(orgs).set({ stripeAccountId: accountId }).where(eq(orgs.id, orgId));
      await audit({
        actor: u.email, entityType: "org", entityId: orgId, tenantOrgId: orgId,
        action: `started Stripe Connect onboarding (${stripeMode()} mode)`,
      });
    }
    return { url: await onboardingLink(accountId, returnUrl) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Ask Stripe whether the account may actually be paid into yet. */
export async function refreshStripeStatus(): Promise<{ error?: string; ready?: boolean }> {
  const u = await requireOwner();
  const orgId = myTenantOrgId(u);
  if (orgId === null) return { error: "Not found" };
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org?.stripeAccountId) return { ready: false };
  const ready = await accountReady(org.stripeAccountId).catch(() => false);
  if (ready !== org.stripeReady) {
    await db.update(orgs).set({ stripeReady: ready }).where(eq(orgs.id, orgId));
    await audit({
      actor: u.email, entityType: "org", entityId: orgId, tenantOrgId: orgId,
      action: ready ? "Stripe finished its checks - the account can take payments" : "the Stripe account is no longer able to take payments",
    });
    revalidatePath("/settings/billing");
  }
  return { ready };
}

/**
 * The client presses Pay. Token-gated: the share link is the credential and
 * the org on its row is the authorization, exactly as the rest of the portal
 * works. No card number touches this server - Stripe hosts the page.
 */
export async function startPayment(
  token: string, invoiceId: number, method: "ach" | "card",
): Promise<{ error?: string; url?: string }> {
  if (!token || token.length < 12) return { error: "This link is not valid." };
  const [link] = await db.select().from(shareLinks).where(eq(shareLinks.token, token));
  if (!link || link.orgId === null || link.invoiceId !== invoiceId) return { error: "This link is not valid." };
  if (linkState(link, shopToday()) !== "active") return { error: "This link is no longer active." };
  if (!stripeConfigured()) return { error: "Card and bank payments are not set up. Please send a check." };

  const full = await invoiceForOrg(invoiceId, link.orgId);
  if (!full) return { error: "Not found" };
  const view = invoiceView(asStatementRow(full), shopToday());
  if (view.payableCents <= 0) return { error: "There is nothing outstanding on this invoice." };

  const [operator] = await db.select().from(orgs).where(eq(orgs.id, full.row.tenantOrgId ?? -1));
  if (!operator?.stripeAccountId || !operator.stripeReady) {
    return { error: "Online payment is not available yet. Please send a check." };
  }
  const [settings] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  const { policy } = await billingContext(full.row.orgId);
  if (method === "card" && !policy.cardsEnabled) return { error: "Card payments are not offered on this account." };

  const amount = payAmount({
    balanceCents: view.payableCents, method,
    cardSurchargeBps: policy.cardSurchargeBps,
    cardSurchargeFlatCents: policy.cardSurchargeFlatCents,
  });
  const base = appUrl() || "";
  try {
    const url = await checkoutSession({
      accountId: operator.stripeAccountId,
      invoiceId, invoiceNumber: full.row.number,
      amountCents: amount.amountCents, method,
      platformFeeBps: settings?.platformFeeBps ?? 0,
      successUrl: `${base}/share/${token}?paid=1`,
      cancelUrl: `${base}/share/${token}`,
    });
    await audit({
      actor: "client", entityType: "invoice", entityId: invoiceId, tenantOrgId: full.row.tenantOrgId,
      action: `opened a ${method === "ach" ? "bank transfer" : "card"} payment for ${formatCents(amount.amountCents)}`
        + ` on ${full.row.number} (${stripeMode()} mode)`,
    });
    return { url };
  } catch (e) {
    // Stripe's own message names configuration - a bad key, a capability that
    // was never requested - and none of that is a client's problem or their
    // business. They get a sentence they can act on; the real reason goes to
    // the audit log where an operator will find it.
    await audit({
      actor: "client", entityType: "invoice", entityId: invoiceId, tenantOrgId: full.row.tenantOrgId,
      action: `a payment could not be started on ${full.row.number}: ${(e as Error).message}`,
    });
    return { error: "We could not start the payment just now. Please try again, or send a check referencing this invoice." };
  }
}

/**
 * Stripe says the money arrived. Called only by the webhook, which has already
 * verified the signature - this records the payment, lets the credit hold
 * recompute itself, and writes the audit row.
 */
export async function recordStripePayment(input: {
  invoiceId: number; amountCents: number; reference: string; method: string;
}): Promise<void> {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, input.invoiceId));
  if (!inv) return;
  const already = await db.select().from(payments)
    .where(and(eq(payments.invoiceId, input.invoiceId), eq(payments.reference, input.reference)));
  if (already.length) return;   // Stripe retries; a payment is not recorded twice.

  await db.insert(payments).values({
    tenantOrgId: inv.tenantOrgId, invoiceId: input.invoiceId,
    method: input.method === "card" ? "card" : "ach",
    amountCents: input.amountCents, reference: input.reference,
    receivedOn: shopToday(), recordedBy: "stripe",
  });

  const full = await invoiceById(input.invoiceId);
  const view = full ? invoiceView(asStatementRow(full), shopToday()) : null;
  if (view && inv.status !== "void" && inv.status !== "referred") {
    const next = view.balanceCents <= 0 ? "paid" : "partial";
    if (next !== inv.status) {
      await db.update(invoices).set({ status: next, updatedAt: new Date() }).where(eq(invoices.id, input.invoiceId));
    }
  }
  // The hold is computed, never stored, so paying the balance lifts it by
  // arithmetic the next time anybody looks. Nothing to un-set here.
  const credit = await creditFor(inv.orgId, shopToday()).catch(() => null);
  await audit({
    actor: "stripe", entityType: "invoice", entityId: input.invoiceId, tenantOrgId: inv.tenantOrgId,
    action: `received ${formatCents(input.amountCents)} by ${input.method === "card" ? "card" : "bank transfer"} on ${inv.number}`
      + (view ? ` - ${view.balanceCents <= 0 ? "paid in full" : `${formatCents(view.balanceCents)} still open`}` : "")
      + (credit && !credit.onHold ? "; the credit hold has cleared" : ""),
  });
  revInvoice(inv);
}

/**
 * Ask a held client for enough to get moving again.
 *
 * Raises a real invoice for the figure lib/credit.depositToClear computes, due
 * immediately - not a note, not an email, an invoice, because "pay us $2,000
 * and we will come out" is only an agreement once there is something to pay
 * against. Recording the payment clears the hold by arithmetic; there is no
 * flag to un-set.
 *
 * It does NOT lift the hold. That is still the owner's decision with a reason,
 * and a deposit that lifted a hold on its own would be a way to work around
 * the override without writing one.
 */
export async function requestDeposit(orgId: number, note: string): Promise<{ error?: string; id?: number }> {
  const u = await requireStaff();
  const today = shopToday();
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };

  const [standing, ctx] = await Promise.all([creditFor(orgId, today), billingContext(orgId)]);
  if (!standing.onHold && !standing.override) {
    return { error: `${org.name} is not on credit hold - there is nothing to clear.` };
  }
  const full = await invoicesForOrg(orgId);
  const open = full.map((f) => invoiceView(asStatementRow(f), today)).filter(isOpen);
  const cents = depositToClear({
    policy: ctx.policy,
    openInvoices: open.map((v) => ({ balanceCents: v.balanceCents, daysLate: v.daysLate })),
  });
  if (cents <= 0) return { error: "Nothing would clear it - the hold is on something else." };

  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const used = await db.select({ number: invoices.number }).from(invoices)
      .where(forTenant(invoices.tenantOrgId, myTenantOrgId(u)));
    const number = nextWoNumber(used.map((r) => r.number), ctx.invoicePrefix);
    try {
      const [inv] = await db.insert(invoices).values({
        tenantOrgId: myTenantOrgId(u), orgId, number, status: "sent",
        issuedOn: today, dueOn: today,          // a deposit that is net 30 is not a deposit
        poNumber: org.poNumber,
        note: note.trim() || `Deposit to clear the credit hold on ${org.name}.`,
        createdBy: u.email,
      }).returning();
      await db.insert(invoiceLines).values({
        invoiceId: inv.id, kind: "fee_ref",
        description: "Deposit to resume service",
        detail: `enough to clear the hold on ${org.name}, due on receipt`,
        qty: 1000, unitCents: cents, covered: false, sourceId: null, position: 0,
      });
      await audit({
        actor: u.email, entityType: "invoice", entityId: inv.id, tenantOrgId: myTenantOrgId(u),
        action: `raised ${number}, a ${formatCents(cents)} deposit to clear ${org.name}'s credit hold`,
      });
      revInvoice(inv);
      revalidatePath("/work");
      return { id: inv.id };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/**
 * Delete an invoice outright. Owner only, reason required, audited - the row
 * and its lines, fees, payments and share links go with it. Void remains the
 * lighter option when the number should stay on the books.
 */
export async function deleteInvoice(id: number, reason: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
  if (!inv) return {};
  const paid = await db.select().from(payments).where(eq(payments.invoiceId, id));
  const total = paid.reduce((n, p) => n + p.amountCents, 0);
  await db.delete(invoices).where(eq(invoices.id, id));   // children cascade
  await audit({
    actor: u.email, entityType: "invoice", entityId: id, tenantOrgId: inv.tenantOrgId,
    action: `deleted ${inv.number}${total > 0 ? ` (had ${formatCents(total)} in payments)` : ""} - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revalidatePath("/money");
  revalidatePath("/money/invoices");
  if (inv.workOrderId) revalidatePath(`/work/${inv.workOrderId}`);
  return {};
}

/** Delete a quote. Owner only, reason required, audited. */
export async function deleteQuote(id: number, reason: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [q] = await db.select().from(quotes).where(eq(quotes.id, id));
  if (!q) return {};
  await db.delete(quotes).where(eq(quotes.id, id));
  await audit({
    actor: u.email, entityType: "quote", entityId: id, tenantOrgId: q.tenantOrgId,
    action: `deleted ${q.number} - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revalidatePath("/money");
  revalidatePath("/money/quotes");
  if (q.workOrderId) revalidatePath(`/work/${q.workOrderId}`);
  return {};
}

/** What a hand-typed line may be. Tax and fee_ref rows come from the system. */
const MANUAL_LINE_KINDS = ["part", "labor", "travel", "expense"] as const;

function cleanManualLine(data: { kind: string; description: string; qty: number; unitCents: number }):
  { error: string } | { kind: string; description: string; qty: number; unitCents: number } {
  const description = data.description.trim();
  if (!description) return { error: "Say what the charge is for" };
  if (!(MANUAL_LINE_KINDS as readonly string[]).includes(data.kind)) {
    return { error: "Pick what kind of charge it is" };
  }
  const qty = Number(data.qty);
  if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) return { error: "Quantity must be above zero" };
  const unitCents = Math.round(Number(data.unitCents));
  if (!Number.isFinite(unitCents) || unitCents < 0) return { error: "The price cannot be negative" };
  return { kind: data.kind, description, qty, unitCents };
}

/**
 * A bill with no job behind it: a deposit, a shipment, a stocking fee, a
 * correction. Starts empty; the lines are typed onto the draft.
 */
export async function createBlankInvoice(orgId: number): Promise<{ error?: string; id?: number }> {
  const u = await requireStaff();
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org || !mayAdminOrg(tenantViewer(u), org)) return { error: "Not found" };
  const tenant = orgTenant(org) ?? myTenantOrgId(u);
  const { invoicePrefix } = await billingContext(orgId);

  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const used = await db.select({ number: invoices.number }).from(invoices)
      .where(forTenant(invoices.tenantOrgId, tenant));
    const number = nextWoNumber(used.map((r) => r.number), invoicePrefix);
    try {
      const [inv] = await db.insert(invoices).values({
        tenantOrgId: tenant, orgId, number, status: "draft",
        poNumber: org.poNumber ?? "", createdBy: u.email,
      }).returning();
      await audit({
        actor: u.email, entityType: "invoice", entityId: inv.id, tenantOrgId: tenant,
        action: `drafted ${number} for ${org.name}, no job behind it`,
      });
      revInvoice(inv);
      revalidatePath("/money/invoices");
      return { id: inv.id };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/**
 * Raise one cycle of a retainer as a draft invoice.
 *
 * The one piece of money in this app with no job behind it: nobody drove out,
 * nobody logged an hour, and the month falls due anyway. Two rules it does not
 * bend:
 *
 *   IT DRAFTS, IT DOES NOT SEND. A $20,000 invoice leaving for a client
 *   because a cron fired at 3am is a decision nobody made. The draft is the
 *   automation; pressing send stays a person's job - the same line the dunning
 *   pass draws.
 *
 *   ONE CYCLE, ONCE. bill_last_on is written in the same breath as the
 *   invoice, and a cycle at or before it is refused. Re-running the pass, or
 *   pressing the button twice, cannot bill a month twice.
 *
 * `actor` is who to credit: the cron passes its own name because there is no
 * session behind it.
 */
export async function raiseRetainerCycle(
  agreementId: number, cycleOn: string, actor: string,
): Promise<{ error?: string; id?: number; number?: string }> {
  if (!isIsoDay(cycleOn)) return { error: "That is not a day" };
  const [ag] = await db.select().from(agreements).where(eq(agreements.id, agreementId));
  if (!ag) return { error: "Not found" };
  if (!recurring(ag)) return { error: "This agreement does not bill on its own" };
  // The refusal that makes a re-run safe.
  if (ag.billLastOn && cycleOn <= ag.billLastOn) {
    return { error: `${cycleOn} was already raised on this agreement` };
  }
  const [org] = await db.select().from(orgs).where(eq(orgs.id, ag.orgId));
  if (!org) return { error: "Not found" };
  const tenant = orgTenant(org) ?? ag.tenantOrgId;
  const { invoicePrefix } = await billingContext(ag.orgId);

  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const used = await db.select({ number: invoices.number }).from(invoices)
      .where(forTenant(invoices.tenantOrgId, tenant));
    const number = nextWoNumber(used.map((r) => r.number), invoicePrefix);
    try {
      const [inv] = await db.insert(invoices).values({
        tenantOrgId: tenant, orgId: ag.orgId, agreementId: ag.id, number,
        status: "draft", issuedOn: cycleOn, dueOn: dueFor(org, cycleOn),
        poNumber: org.poNumber ?? "", createdBy: actor,
        note: ag.number ? `Under ${ag.number}` : "",
      }).returning();
      await db.insert(invoiceLines).values({
        invoiceId: inv.id, kind: "retainer",
        description: ag.billDescription.trim() || ag.title.trim() || "Service retainer",
        detail: `${billCadenceLabel(ag.billEveryMonths)} - cycle of ${cycleOn}`,
        qty: 1000, unitCents: ag.billAmountCents,
      });
      // Cursor forward in the same breath as the invoice.
      await db.update(agreements).set({
        billLastOn: cycleOn,
        billNextOn: addMonths(cycleOn, ag.billEveryMonths, ag.billDayOfMonth),
      }).where(eq(agreements.id, ag.id));
      await audit({
        actor, entityType: "invoice", entityId: inv.id, tenantOrgId: tenant,
        action: `raised ${number} for ${org.name}: ${billCadenceLabel(ag.billEveryMonths)} retainer`
          + `${ag.number ? ` under ${ag.number}` : ""}, cycle of ${cycleOn} - draft, not sent`,
      });
      revInvoice(inv);
      revalidatePath("/money/invoices");
      revalidatePath("/money");
      return { id: inv.id, number };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// ── Backfill ────────────────────────────────────────────────────────────────
// Paper that was already resolved before this app existed.
//
// Every other path in here walks a document through its life - draft, send,
// answer, pay - because that is what the app is FOR. History has none of that
// to walk: last March's invoice was issued in March, paid in April, and the
// only useful thing to do with it now is write down what happened. Making
// somebody draft it, "send" it (mailing the client a bill they settled a year
// ago), and then record a payment against today is not a migration path, it is
// a hazard.
//
// So these write the finished state directly, and are defined by what they
// REFUSE to do: no share link, no email, no card, no deposit invoice, no
// dunning ladder. Nothing leaves the building. The audit line says the
// document was recorded as history rather than issued from here, because a
// year from now the difference between "we sent this" and "we typed this in"
// is the difference between evidence and a note.

/** Shared shape: what a historical document's lines look like coming in. */
export type HistoricalLine = { kind: string; description: string; qty: number; unitCents: number };

const cleanHistoricalLines = (rows: HistoricalLine[]) =>
  rows
    .filter((l) => l.description.trim() || l.unitCents)
    .slice(0, 200)
    .map((l, i) => ({
      kind: (LINE_KINDS as readonly string[]).includes(l.kind) ? l.kind : "part",
      description: l.description.trim().slice(0, 200),
      detail: "",
      // Thousandths, the same convention every other line uses.
      qty: Math.max(0, Math.round((Number.isFinite(l.qty) ? l.qty : 1) * 1000)),
      unitCents: Math.round(l.unitCents),
      position: i,
    }));

/**
 * An invoice that was already issued, and possibly already paid.
 *
 * The number is THEIRS: a migration whose invoice numbers do not match the
 * client's own records is a migration that makes every future conversation
 * about an old bill harder. Blank falls back to our sequence.
 *
 * Payment is recorded as a real payments row rather than by setting the
 * status, so the invoice's balance is summed from the same ledger as every
 * other invoice - the app has no stored balances, and history must not be the
 * one exception that disagrees with the rest.
 */
export async function recordHistoricalInvoice(
  orgId: number,
  data: {
    number: string; issuedOn: string; dueOn: string; poNumber: string; note: string;
    lines: HistoricalLine[];
    /** paid | open | void - what became of it. */
    outcome: string;
    paidOn: string; method: string; reference: string;
  },
): Promise<{ error?: string; id?: number; number?: string }> {
  const u = await requireStaff();
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org || !mayAdminOrg(tenantViewer(u), org)) return { error: "Not found" };
  const tenant = orgTenant(org) ?? myTenantOrgId(u);
  const today = shopToday();

  const issuedOn = data.issuedOn.trim();
  const outcome = (INVOICE_OUTCOMES as readonly string[]).includes(data.outcome) ? data.outcome : "paid";
  // One authority for the rules, shared with the dialog, so the two cannot
  // drift into different answers about the same paperwork.
  const bad = invoiceProblem({ issuedOn, outcome, paidOn: data.paidOn, lines: data.lines }, today);
  if (bad) return { error: bad };

  const lines = cleanHistoricalLines(data.lines);
  const dueOn = isIsoDay(data.dueOn.trim()) ? data.dueOn.trim() : dueFor(org, issuedOn);
  const total = lines.reduce((n, l) => n + Math.round((l.qty / 1000) * l.unitCents), 0);
  const paidOn = outcome === "paid" ? (data.paidOn.trim() || issuedOn) : "";
  const method = (PAYMENT_METHODS as readonly string[]).includes(data.method) ? data.method : "check";

  const typed = data.number.trim().slice(0, 40);
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const used = await db.select({ number: invoices.number }).from(invoices)
      .where(forTenant(invoices.tenantOrgId, tenant));
    if (typed && used.some((r) => r.number.toLowerCase() === typed.toLowerCase())) {
      return { error: `${typed} is already on file` };
    }
    const { invoicePrefix } = await billingContext(orgId);
    const number = typed || nextWoNumber(used.map((r) => r.number), invoicePrefix);
    try {
      const [inv] = await db.insert(invoices).values({
        tenantOrgId: tenant, orgId, number,
        // Issued, not draft: it really did go out, just not from here.
        status: openingStatus(outcome),
        issuedOn, dueOn, poNumber: data.poNumber.trim() || (org.poNumber ?? ""),
        note: data.note.trim(), createdBy: u.email,
      }).returning();
      await db.insert(invoiceLines).values(lines.map((l) => ({ ...l, invoiceId: inv.id })));

      if (outcome === "paid") {
        await db.insert(payments).values({
          tenantOrgId: tenant, invoiceId: inv.id, method, amountCents: total,
          reference: data.reference.trim(), receivedOn: paidOn, recordedBy: u.email,
        });
        // Let the ledger decide the status, exactly as recordPayment does.
        const full = await invoiceById(inv.id);
        const view = full ? invoiceView(asStatementRow(full), today) : null;
        if (view) {
          await db.update(invoices).set({ status: view.balanceCents <= 0 ? "paid" : "partial" })
            .where(eq(invoices.id, inv.id));
        }
      }

      await audit({
        actor: u.email, entityType: "invoice", entityId: inv.id, tenantOrgId: tenant,
        action: `recorded ${number} for ${org.name} as history: ${formatCents(total)}, issued ${issuedOn}`
          + (outcome === "paid" ? `, paid ${paidOn} by ${METHOD_LABEL[method].toLowerCase()}` : "")
          + (outcome === "void" ? ", voided" : "")
          + (outcome === "open" ? ", still open" : "")
          + " - entered from the old records, not issued from here",
      });
      revInvoice(inv);
      revalidatePath("/money/invoices");
      revalidatePath("/money");
      return { id: inv.id, number };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/**
 * A quote that was already answered.
 *
 * Approving one through the normal path can raise a deposit invoice and mails
 * the client; both are wrong for a job that was quoted, won and finished two
 * years ago. This writes the answer and the day it came, and raises nothing.
 */
export async function recordHistoricalQuote(
  orgId: number,
  data: {
    number: string; title: string; sentOn: string; answeredOn: string;
    lines: HistoricalLine[];
    /** approved | declined | expired. */
    outcome: string;
    answeredBy: string; answerNote: string;
  },
): Promise<{ error?: string; id?: number; number?: string }> {
  const u = await requireStaff();
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org || !mayAdminOrg(tenantViewer(u), org)) return { error: "Not found" };
  const tenant = orgTenant(org) ?? myTenantOrgId(u);
  const today = shopToday();

  const title = data.title.trim();
  const sentOn = data.sentOn.trim();
  const bad = quoteProblem({ title, sentOn, answeredOn: data.answeredOn, lines: data.lines }, today);
  if (bad) return { error: bad };

  const lines = cleanHistoricalLines(data.lines);
  const outcome = (QUOTE_OUTCOMES as readonly string[]).includes(data.outcome) ? data.outcome : "approved";
  const answeredOn = data.answeredOn.trim() || sentOn;

  const typed = data.number.trim().slice(0, 40);
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const used = await db.select({ number: quotes.number }).from(quotes)
      .where(forTenant(quotes.tenantOrgId, tenant));
    if (typed && used.some((r) => r.number.toLowerCase() === typed.toLowerCase())) {
      return { error: `${typed} is already on file` };
    }
    const number = typed || nextWoNumber(used.map((r) => r.number), "Q-");
    try {
      const [q] = await db.insert(quotes).values({
        tenantOrgId: tenant, orgId, number, status: outcome, title,
        sentOn, expiresOn: answeredOn,
        // No deposit: whatever was owed on approval was settled outside this
        // app, and raising an invoice for it now would invent a receivable.
        depositPct: 0,
        answeredOn, answeredBy: data.answeredBy.trim().slice(0, 120),
        answerNote: data.answerNote.trim().slice(0, 500), createdBy: u.email,
      }).returning();
      await db.insert(quoteLines).values(lines.map((l) => ({ ...l, quoteId: q.id })));

      const total = lines.reduce((n, l) => n + Math.round((l.qty / 1000) * l.unitCents), 0);
      await audit({
        actor: u.email, entityType: "quote", entityId: q.id, tenantOrgId: tenant,
        action: `recorded ${number} for ${org.name} as history: ${title}, ${formatCents(total)}`
          + `, sent ${sentOn}, ${outcome} ${answeredOn}`
          + " - entered from the old records, never sent from here",
      });
      revQuote(q);
      revalidatePath("/money/quotes");
      return { id: q.id, number };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/**
 * Raise a cycle from the card, rather than waiting for the overnight pass.
 *
 * Same guard rails, a session behind it instead of the cron: the person is
 * checked, and the cycle still has to be one dueCycles agrees is due, so this
 * cannot be used to run a contract forward past its own schedule.
 */
export async function raiseRetainerCycleNow(
  agreementId: number, cycleOn: string,
): Promise<{ error?: string; id?: number; number?: string }> {
  const u = await requireStaff();
  const [ag] = await db.select().from(agreements).where(eq(agreements.id, agreementId));
  if (!ag) return { error: "Not found" };
  const [org] = await db.select().from(orgs).where(eq(orgs.id, ag.orgId));
  if (!org || !mayAdminOrg(tenantViewer(u), org)) return { error: "Not found" };
  if (!dueCycles(ag, shopToday()).includes(cycleOn)) {
    return { error: `The ${cycleOn} cycle is not due yet` };
  }
  return raiseRetainerCycle(agreementId, cycleOn, u.email);
}

/**
 * The standing instruction itself: how much, how often, and from when.
 *
 * Turning it on opens the cursor at the NEXT cycle rather than the contract's
 * start - a contract signed in January does not raise eight drafts because
 * somebody ticked a box in August. Backfilling those months is a separate,
 * deliberate act.
 */
export async function saveRecurringTerms(
  agreementId: number,
  data: { everyMonths: number; amountCents: number; description: string; dayOfMonth: number; leadDays: number },
): Promise<{ error?: string; nextOn?: string }> {
  const u = await requireStaff();
  const [ag] = await db.select().from(agreements).where(eq(agreements.id, agreementId));
  if (!ag) return { error: "Not found" };
  const [org] = await db.select().from(orgs).where(eq(orgs.id, ag.orgId));
  if (!org || !mayAdminOrg(tenantViewer(u), org)) return { error: "Not found" };

  const every = Math.max(0, Math.min(60, Math.round(data.everyMonths)));
  const cents = Math.max(0, Math.round(data.amountCents));
  const day = Math.max(1, Math.min(31, Math.round(data.dayOfMonth)));
  const lead = Math.max(0, Math.min(60, Math.round(data.leadDays)));
  if (every > 0 && cents <= 0) return { error: "Say what each cycle bills" };

  const today = shopToday();
  // Keep the cursor where it is once it is running: retuning the amount must
  // not silently re-bill a month, and must not skip one either.
  const nextOn = every === 0 ? ""
    : ag.billNextOn || openingCursor({ startsOn: ag.startsOn, billDayOfMonth: day }, today);

  await db.update(agreements).set({
    billEveryMonths: every, billAmountCents: cents,
    billDescription: data.description.trim().slice(0, 200),
    billDayOfMonth: day, billLeadDays: lead, billNextOn: nextOn,
  }).where(eq(agreements.id, ag.id));

  await audit({
    actor: u.email, entityType: "agreement", entityId: ag.id, tenantOrgId: ag.tenantOrgId,
    action: every === 0
      ? `stopped billing ${ag.number || "this agreement"} on a schedule`
      : `${ag.number || "this agreement"} now bills ${formatCents(cents)} ${billCadenceLabel(every)}`
        + `, next cycle ${nextOn}, drafted ${lead} day${lead === 1 ? "" : "s"} ahead`,
  });
  revalidatePath(`/clients/${ag.orgId}`);
  revalidatePath("/money");
  return { nextOn };
}

/** A priced offer with no job behind it yet. Lines are typed onto the draft. */
export async function createBlankQuote(
  orgId: number, data: { title: string; expiresOn: string; depositPct: number },
): Promise<{ error?: string; id?: number }> {
  const u = await requireStaff();
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org || !mayAdminOrg(tenantViewer(u), org)) return { error: "Not found" };
  const tenant = orgTenant(org) ?? myTenantOrgId(u);
  const title = data.title.trim();
  if (!title) return { error: "Say what the quote is for" };
  const expires = data.expiresOn.trim();
  if (!isIsoDay(expires)) return { error: "Pick the day it stops being good for" };
  const pct = Math.max(0, Math.min(100, Math.round(data.depositPct)));

  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const used = await db.select({ number: quotes.number }).from(quotes)
      .where(forTenant(quotes.tenantOrgId, tenant));
    const number = nextWoNumber(used.map((r) => r.number), "Q-");
    try {
      const [q] = await db.insert(quotes).values({
        tenantOrgId: tenant, orgId, number, status: "draft",
        title, expiresOn: expires, depositPct: pct, createdBy: u.email,
      }).returning();
      await audit({
        actor: u.email, entityType: "quote", entityId: q.id, tenantOrgId: tenant,
        action: `drafted ${number} for ${org.name}: ${title}`
          + (pct > 0 ? `, ${pct}% deposit on approval` : "") + `, good to ${expires}`,
      });
      revQuote(q);
      revalidatePath("/money/quotes");
      return { id: q.id };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** Type a line onto a draft invoice. Sent invoices stay as sent. */
export async function addInvoiceLine(
  invoiceId: number, data: { kind: string; description: string; qty: number; unitCents: number },
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) return { error: "Not found" };
  if (inv.status !== "draft") return { error: `${inv.number} has been sent - post a fee or draft a new invoice instead.` };
  const clean = cleanManualLine(data);
  if ("error" in clean) return clean;
  const existing = await db.select({ position: invoiceLines.position }).from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId));
  await db.insert(invoiceLines).values({
    invoiceId, kind: clean.kind, description: clean.description,
    qty: Math.round(clean.qty * 1000), unitCents: clean.unitCents,
    position: existing.length ? Math.max(...existing.map((l) => l.position)) + 1 : 0,
  });
  await audit({
    actor: u.email, entityType: "invoice", entityId: invoiceId, tenantOrgId: inv.tenantOrgId,
    action: `added a line to ${inv.number}: ${clean.description}, ${formatCents(Math.round(clean.qty * clean.unitCents))}`,
  });
  revInvoice(inv);
  return {};
}

/** Type a line onto a draft quote. */
export async function addQuoteLine(
  quoteId: number, data: { kind: string; description: string; qty: number; unitCents: number },
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [q] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
  if (!q) return { error: "Not found" };
  if (q.status !== "draft") return { error: `${q.number} has gone out - it reads as sent.` };
  const clean = cleanManualLine(data);
  if ("error" in clean) return clean;
  const existing = await db.select({ position: quoteLines.position }).from(quoteLines)
    .where(eq(quoteLines.quoteId, quoteId));
  await db.insert(quoteLines).values({
    quoteId, kind: clean.kind, description: clean.description,
    qty: Math.round(clean.qty * 1000), unitCents: clean.unitCents,
    position: existing.length ? Math.max(...existing.map((l) => l.position)) + 1 : 0,
  });
  await audit({
    actor: u.email, entityType: "quote", entityId: quoteId, tenantOrgId: q.tenantOrgId,
    action: `added a line to ${q.number}: ${clean.description}, ${formatCents(Math.round(clean.qty * clean.unitCents))}`,
  });
  revQuote(q);
  return {};
}

/** Take a line off a draft quote, with the reason on the record. */
export async function removeQuoteLine(lineId: number, reason: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [line] = await db.select().from(quoteLines).where(eq(quoteLines.id, lineId));
  if (!line) return {};
  const [q] = await db.select().from(quotes).where(eq(quotes.id, line.quoteId));
  if (!q) return { error: "Not found" };
  if (q.status !== "draft") return { error: `${q.number} has gone out - the client is reading these lines.` };
  await db.delete(quoteLines).where(eq(quoteLines.id, lineId));
  await audit({
    actor: u.email, entityType: "quote", entityId: q.id, tenantOrgId: q.tenantOrgId,
    action: `removed a line from ${q.number}: ${line.description} - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revQuote(q);
  return {};
}

/** Is this address in the caller's own directory? The gate on profile edits. */
async function directoryHas(u: SessionUser, email: string): Promise<boolean> {
  const dir = await visibleDirectory(u);
  return dir.some((p) => p.email.trim().toLowerCase() === email);
}

/**
 * An owner edits somebody's profile: the structured name, their title, and
 * which site they sit at. `name` is rewritten from first/last whenever either
 * is set, so the display name and its halves cannot disagree - and the copy
 * on house_members follows, because that column is display-only and stale
 * display copies are how two screens argue about somebody's name.
 */
export async function updatePersonProfile(email: string, data: {
  firstName: string; lastName: string; title: string; siteId: number | null;
}): Promise<{ error?: string }> {
  const u = await requireOwner();
  const addr = email.trim().toLowerCase();
  if (!addr || !(await directoryHas(u, addr))) return { error: "Not found" };

  const first = data.firstName.trim().slice(0, 60);
  const last = data.lastName.trim().slice(0, 60);
  const title = data.title.trim().slice(0, 80);
  let siteId: number | null = null;
  if (data.siteId !== null) {
    const [site] = await db.select().from(orgSites).where(eq(orgSites.id, data.siteId));
    if (!site) return { error: "That site no longer exists" };
    const [siteOrg] = await db.select().from(orgs).where(eq(orgs.id, site.orgId));
    if (!siteOrg || !mayAdminOrg(tenantViewer(u), siteOrg)) return { error: "Not found" };
    siteId = site.id;
  }

  const [existing] = await db.select().from(users).where(eq(users.email, addr));
  const display = [first, last].filter(Boolean).join(" ");
  const patch = {
    firstName: first, lastName: last, title, siteId,
    ...(display ? { name: display } : {}),
  };
  if (existing) {
    await db.update(users).set(patch).where(eq(users.id, existing.id));
  } else {
    // Somebody added but never signed in: give the profile a row to live on.
    // Their first sign-in finds it by address, exactly as it would have.
    await db.insert(users).values({ email: addr, ...patch });
  }
  if (display) {
    await db.update(houseMembers).set({ name: display }).where(eq(houseMembers.email, addr));
  }
  await audit({
    actor: u.email, entityType: "user", entityId: addr, tenantOrgId: myTenantOrgId(u),
    action: `edited ${addr}'s profile: ${[display || null, title || null,
      siteId !== null ? "site set" : null].filter(Boolean).join(", ") || "cleared"}`,
    field: "profile",
    oldValue: existing ? `${existing.name ?? ""} | ${existing.title} | site ${existing.siteId ?? "-"}` : "",
    newValue: `${display || (existing?.name ?? "")} | ${title} | site ${siteId ?? "-"}`,
  });
  revalidatePath("/settings/organizations");
  return {};
}

/**
 * Move somebody's login to a new address. The address IS the identity here -
 * the users row, the allowlist entries and the house-members row all key on
 * it - so all three move together, and the person signs in with the new one
 * from the next code onward. Sessions ride on the user id and survive.
 */
export async function changePersonEmail(oldEmail: string, newEmail: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const from = oldEmail.trim().toLowerCase();
  const to = newEmail.trim().toLowerCase();
  if (!from || !(await directoryHas(u, from))) return { error: "Not found" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { error: "That does not read as an email address" };
  if (to === from) return {};

  const [taken, allowTaken, houseTaken] = await Promise.all([
    db.select().from(users).where(eq(users.email, to)),
    db.select().from(clientAllowlist).where(eq(clientAllowlist.entry, to)),
    db.select().from(houseMembers).where(eq(houseMembers.email, to)),
  ]);
  if (taken.length || allowTaken.length || houseTaken.length) {
    return { error: `${to} already has a login.` };
  }

  await db.update(users).set({ email: to, emailVerified: null }).where(eq(users.email, from));
  await db.update(clientAllowlist).set({ entry: to }).where(eq(clientAllowlist.entry, from));
  await db.update(houseMembers).set({ email: to }).where(eq(houseMembers.email, from));
  await audit({
    actor: u.email, entityType: "user", entityId: to, tenantOrgId: myTenantOrgId(u),
    action: `moved ${from}'s login to ${to}`,
    field: "email", oldValue: from, newValue: to,
  });
  revalidatePath("/settings/organizations");
  return {};
}

/**
 * A client's order from the parts store, split by the shelf - decided HERE,
 * on the server's own count, never on what the browser claimed.
 *
 * What is on the house's shelves becomes a DRAFT INVOICE at the resale the
 * store showed (best cost times the org's parts markup, frozen now): staff
 * confirm and Send opens the pay link. What is not becomes a DRAFT QUOTE for
 * the same lines: staff confirm sourcing and lead time, send it, and the
 * client approves it on their portal. Neither path charges anything by
 * itself - no card is stored anywhere to charge - and a part with no price
 * on file lands at $0 marked "price to follow" for staff to set.
 */
export async function placePartsOrder(
  lines: { partNumber: string; qty: number; source?: "oem" | "alt" }[], note: string,
): Promise<{ error?: string; number?: string; quoteNumber?: string }> {
  const u = await requireUser();
  if (u.orgId === null) return { error: "Ordering happens from a client login - staff order through Purchasing." };
  const [org] = await db.select().from(orgs).where(eq(orgs.id, u.orgId));
  if (!org || org.kind !== "client") return { error: "Not found" };
  const tenant = orgTenant(org);

  // Dedupe by part number AND chosen class - genuine and equivalent are two
  // different lines on purpose - clamp quantities, and cap the order at a
  // size a human meant: forty distinct lines is a stocking order, not a typo.
  const wanted = new Map<string, { pn: string; source?: "oem" | "alt"; qty: number }>();
  for (const l of lines) {
    const pn = l.partNumber.trim().toLowerCase();
    const qty = Math.floor(Number(l.qty));
    if (!pn || !Number.isFinite(qty) || qty <= 0) continue;
    const source = l.source === "oem" || l.source === "alt" ? l.source : undefined;
    const key = `${pn}|${source ?? ""}`;
    const cur = wanted.get(key);
    wanted.set(key, { pn, source, qty: Math.min(999, (cur?.qty ?? 0) + qty) });
  }
  if (!wanted.size) return { error: "The cart is empty" };
  if (wanted.size > 40) return { error: "Forty lines at a time - split the order" };

  const [catalogRows, priceRows, ctx] = await Promise.all([
    db.select().from(partCatalog).where(and(
      forTenant(partCatalog.tenantOrgId, tenant), eq(partCatalog.archived, false))),
    db.select().from(partPrices).where(forTenant(partPrices.tenantOrgId, tenant)),
    billingContext(org.id),
  ]);
  const byPn = new Map(catalogRows.map((c) => [c.partNumber.trim().toLowerCase(), c]));
  const ordered: {
    part: typeof partCatalog.$inferSelect; qty: number; unitCents: number | null;
    source?: "oem" | "alt";
  }[] = [];
  for (const { pn, source, qty } of wanted.values()) {
    const part = byPn.get(pn);
    if (!part) return { error: `PN ${pn.toUpperCase()} is no longer in the catalog - remove it from the cart.` };
    // The class the client chose narrows the offer pool; no choice = best
    // overall, exactly what the store's "from" price showed.
    const pool = source === undefined ? priceRows
      : priceRows.filter((r) => r.isOem === (source === "oem"));
    const best = bestPrice(pool, part.partNumber);
    if (source !== undefined && !best) {
      return { error: `PN ${part.partNumber} is no longer offered as ${source === "oem" ? "genuine" : "an equivalent"} - re-add it from the store.` };
    }
    ordered.push({
      part, qty, source,
      unitCents: best && best.priceCents > 0 ? sellPrice(best.priceCents, ctx.policy.partsMarkupBps) : null,
    });
  }

  // The shelf's answer: on-hand across the house's own unarchived rooms. It
  // decides which order lines ship today versus get sourced first - but the
  // ORDER takes every PRICED line either way ("invoiced when it ships"), and
  // only unpriced lines quote first: an unconfirmed price is the one thing a
  // client must approve before anything moves. A chosen class is a sourcing
  // request by definition, so it never ships from the shelf.
  const houseRooms = await db.select({ id: stockrooms.id }).from(stockrooms)
    .where(and(forTenant(stockrooms.tenantOrgId, tenant),
      isNull(stockrooms.orgId), eq(stockrooms.archived, false)));
  const onHand = new Map<string, number>();
  if (houseRooms.length) {
    const stockRows = await db.select({ partNumber: stockItems.partNumber, qty: stockItems.qty })
      .from(stockItems).where(inArray(stockItems.stockroomId, houseRooms.map((r) => r.id)));
    for (const s of stockRows) {
      const key = s.partNumber.trim().toLowerCase();
      onHand.set(key, (onHand.get(key) ?? 0) + s.qty);
    }
  }
  const shipsToday = (o: typeof ordered[number]) =>
    o.source === undefined && (onHand.get(o.part.partNumber.trim().toLowerCase()) ?? 0) >= o.qty;
  const nowLines = ordered.filter((o) => o.unitCents !== null);
  const quoteLinesWanted = ordered.filter((o) => o.unitCents === null);

  const why = note.trim().slice(0, 300);
  // The chosen class rides the line where staff (and the client's paperwork)
  // read it - it is what tells sourcing which vendor pool this line allows.
  const lineValues = (o: typeof ordered[number], i: number) => ({
    kind: "part",
    description: o.part.name || o.part.partNumber,
    detail: `PN ${o.part.partNumber}`
      + (o.source === "oem" ? ` - genuine ${o.part.manufacturer || "OEM"}`.trimEnd()
        : o.source === "alt" ? " - OEM-equivalent" : "")
      + (o.unitCents === null ? " - price to follow"
        : shipsToday(o) ? "" : " - sourced to order"),
    qty: o.qty * 1000, unitCents: o.unitCents ?? 0, position: i,
  });
  const describe = (set: typeof ordered) => {
    const priced = set.filter((o) => o.unitCents !== null);
    const total = priced.reduce((n, o) => n + o.unitCents! * o.qty, 0);
    const unpriced = set.length - priced.length;
    return `${formatCents(total)}` + (unpriced ? ` plus ${unpriced} line${unpriced === 1 ? "" : "s"} to be priced` : "");
  };

  let invoiceNumber: string | undefined;
  let quoteNumber: string | undefined;
  const today = shopToday();
  let last: unknown;
  for (let attempt = 0; attempt < 4 && nowLines.length && !invoiceNumber; attempt++) {
    const used = await db.select({ number: invoices.number }).from(invoices)
      .where(forTenant(invoices.tenantOrgId, tenant));
    const number = nextWoNumber(used.map((r) => r.number), ctx.invoicePrefix);
    try {
      const [inv] = await db.insert(invoices).values({
        tenantOrgId: tenant, orgId: org.id, number, status: "draft",
        poNumber: org.poNumber ?? "", createdBy: u.email,
        note: ["Parts order from the portal", why].filter(Boolean).join(" - "),
      }).returning();
      await db.insert(invoiceLines).values(nowLines.map((o, i) => ({ invoiceId: inv.id, ...lineValues(o, i) })));
      await audit({
        actor: u.email, entityType: "invoice", entityId: inv.id, tenantOrgId: tenant,
        action: `${org.name} ordered ${nowLines.length} part${nowLines.length === 1 ? "" : "s"} from the store`
          + ` on ${number}: ${describe(nowLines)}`
          + (nowLines.some((o) => !shipsToday(o)) ? ` (${nowLines.filter((o) => !shipsToday(o)).length} sourced to order)` : ""),
      });
      revInvoice(inv);
      invoiceNumber = number;
    } catch (e) {
      last = e;
    }
  }
  if (nowLines.length && !invoiceNumber) throw last;

  for (let attempt = 0; attempt < 4 && quoteLinesWanted.length && !quoteNumber; attempt++) {
    const used = await db.select({ number: quotes.number }).from(quotes)
      .where(forTenant(quotes.tenantOrgId, tenant));
    const number = nextWoNumber(used.map((r) => r.number), "Q-");
    try {
      const [q] = await db.insert(quotes).values({
        tenantOrgId: tenant, orgId: org.id, number, status: "draft",
        title: `Parts to source - ${quoteLinesWanted.length} item${quoteLinesWanted.length === 1 ? "" : "s"}`,
        expiresOn: addDays(today, 30), depositPct: 0, createdBy: u.email,
      }).returning();
      await db.insert(quoteLines).values(quoteLinesWanted.map((o, i) => ({ quoteId: q.id, ...lineValues(o, i) })));
      await audit({
        actor: u.email, entityType: "quote", entityId: q.id, tenantOrgId: tenant,
        action: `${org.name} asked the store to source ${quoteLinesWanted.length} part${quoteLinesWanted.length === 1 ? "" : "s"}`
          + ` on ${number}: ${describe(quoteLinesWanted)}`
          + (why ? ` - ${why}` : ""),
      });
      revQuote(q);
      quoteNumber = number;
    } catch (e) {
      last = e;
    }
  }
  if (quoteLinesWanted.length && !quoteNumber) throw last;

  revalidatePath("/money/invoices");
  revalidatePath("/money/quotes");
  revalidatePath("/store");
  return { number: invoiceNumber, quoteNumber };
}
