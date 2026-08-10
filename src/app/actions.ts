"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { eq, and, asc, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { redirect } from "next/navigation";
import {
  instruments, instrumentGases, tasks, checklistItems, itemNotes, taskNotes, parts, attachments,
  sheetDiffs, appSettings, eodUpdates, clientAllowlist, users, sessions, stageDefs,
  stageEvents, discussionPosts, people, assets, assetEvents, discussionReads, vocabTerms, systemShares, orgs,
  engagementRecords, accessRequests, assetShares, pmSchedules, procedures, signoffs,
} from "@/db/schema";
import { addDays, advance as advancePm, cadenceLabel, isIsoDay, parseCadence } from "@/lib/pm";
import { applyProcedures, backfillProcedure, generateDuePmTasks } from "@/lib/pmGenerate";
import { parseProcParts, procedureTaskBody, schedulePartsOf, serializeProcParts, type ProcPart } from "@/lib/procedures";
import { signoffGate, snapshotOf } from "@/lib/signoff";
import { matchesEntry, roleForEmail, emailInClientAllowlist } from "@/auth";
import { parseList } from "@/lib/allowMatch";
import { getStageDefs } from "@/lib/stageDefs";
import { notifyTaskAssigned, notifyGasEmpty, notifyDiscussion, notifySystemAssigned, notifyAccessRequest, notifyInvite } from "@/lib/notify";
import { normalizeSerial, MIN_SERIAL_LOOKUP } from "@/lib/serial";
import { isValidHex } from "@/lib/theme";
import { canSeeCosts } from "@/lib/redact";
import { audit } from "@/lib/audit";
import { requireUser, requireEditor, requireStaff, requireOwner, requireRealOwner, VIEW_AS_COOKIE, type SessionUser } from "@/lib/authz";
import { pushValueToSheet, fetchTrackerRows, appendInstrumentToSheet } from "@/lib/sheetSync";
import { GASES, GAS_STATES, ATTACH_KINDS, MODULE_KINDS, ASSET_STATES, autoFg, partOpen } from "@/lib/stages";
import { shopToday, shopTodayMDY, shopMonthDay } from "@/lib/shopday";
import { composeEodEmail } from "@/lib/eodEmail";
import { getBrand } from "@/lib/brand";
import { parseSpecs, serializeSpecs } from "@/lib/partSpecs";
import { matchItems, summarizeItem, CHECKOUT_KINDS, RESULT_TYPES } from "@/lib/checkout";
import { systemLabel } from "@/lib/systemLabel";
import { composeSystemDossier } from "@/lib/dossier";
import {
  assertSystemEditable, assertSystemVisible, assertWorkEditable, assetAccess,
  canEditSystem, isHouse, visibleSystemIds,
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
export type WorkTarget = { instrumentId: number | null; assetId: number | null };

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
async function resolveTarget(t: WorkTarget): Promise<
  { error: string } | { instrumentId: number | null; assetId: number | null; externalId: string; asset: typeof assets.$inferSelect | null }
> {
  // Every created task/part/gas/file/note comes through here, so this is where
  // "may this caller write to this system or asset?" is answered once.
  const u = await requireEditor();
  let externalId = "";
  if (t.instrumentId !== null) {
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, t.instrumentId));
    if (!inst) return { error: "Not found" };
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
  }
  if (t.instrumentId === null && !asset) return { error: "Not found" };
  return { instrumentId: t.instrumentId, assetId: asset?.id ?? null, externalId, asset };
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

export async function toggleStage(instrumentId: number, stage: string) {
  const u = await requireEditor();
  const defs = await getStageDefs();
  if (!defs.some((s) => s.name === stage)) throw new Error("Unknown stage");
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) throw new Error("Not found");
  await assertSystemEditable(u, instrumentId);
  const has = inst.stages.includes(stage);
  if (has && inst.stages.length === 1) return; // keep at least one stage
  const next = has ? inst.stages.filter((s) => s !== stage) : [...inst.stages, stage];
  await db.update(instruments).set({ stages: next, updatedAt: new Date() }).where(eq(instruments.id, instrumentId));
  await db.insert(stageEvents).values({ instrumentId, stage, kind: has ? "removed" : "added" });
  await audit({
    actor: u.email, instrumentId, entityType: "instrument", entityId: inst.externalId,
    action: `${has ? "removed" : "added"} stage: ${stage}`, field: "stages",
    oldValue: inst.stages.join(", "), newValue: next.join(", "),
  });
  rev(instrumentId);
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
  data: { externalId?: string; client: string; category?: string; priority: number; location?: string; name?: string },
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
  if (!changed.length) return {};
  await db.update(instruments).set({ externalId, client, category, priority, location, name, updatedAt: new Date() }).where(eq(instruments.id, instrumentId));
  for (const [field, oldValue, newValue] of changed) {
    await audit({
      // Log under the new ID so the entry is findable, but the old value is in the row.
      actor: u.email, instrumentId, entityType: "instrument", entityId: externalId,
      action: field === "externalId" ? `renamed ${oldValue} to ${newValue}` : `updated ${field}`,
      field, oldValue, newValue,
    });
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
  if (name) {
    const roster = await db.select().from(people);
    if (!roster.some((p) => p.name === name)) throw new Error("Unknown person");
  }
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
  if (lead) {
    const roster = await db.select().from(people);
    if (!roster.some((p) => p.name === lead)) lead = "";
  }
  const [row] = await db.insert(instruments).values({
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
  await generateCheckout(row.id, { id: null, kind: "system", model: "", serial: "" }, u.email);
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
): Promise<number> {
  const assetType = target.id === null ? "system" : target.kind;
  const items = await db.select().from(procedures)
    .where(and(eq(procedures.assetType, assetType), eq(procedures.runsAtIntake, true)));
  const picked = matchItems(items, assetType, target.model);
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
    await db.insert(tasks).values({
      instrumentId, title: i.name, body: procedureTaskBody(i, parseProcParts(i.parts)), origin: "checkout",
      assetId: target.id, sortOrder: i.position, procedureId: i.id ?? null,
    });
  }
  const label = target.id !== null ? assetLabel(target as { kind: string; model: string; serial: string }) : "the system";
  await audit({
    actor: actorEmail, instrumentId, assetId: target.id, entityType: "task", entityId: target.id ?? instrumentId ?? "",
    action: `generated ${fresh.length} checkout item${fresh.length === 1 ? "" : "s"} for ${label}`,
  });
  return fresh.length;
}

/**
 * Run an asset's checkout on demand - a spare being refurbished for resale
 * gets its tests without ever joining a system.
 */
export async function runAssetCheckout(assetId: number): Promise<{ error?: string; created?: number }> {
  const u = await requireEditor();
  const [a] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!a) return { error: "Not found" };
  const acc = await assetAccess(u, assetId);
  if (!acc.see) return { error: "Not found" };
  if (!acc.edit) return { error: "Read-only access to this asset" };
  const created = await generateCheckout(a.instrumentId, a, u.email);
  revWork({ instrumentId: a.instrumentId, assetId });
  if (!created) return { error: "Nothing new to add - its checkout items are already open (or none are defined for this type)" };
  return { created };
}

export async function createAsset(instrumentId: number | null, data: AssetInput): Promise<{ error?: string; id?: number }> {
  const u = await requireEditor();
  const a = cleanAsset(data);
  if (!a.model && !a.serial) return { error: "Give the asset a model or a serial number" };
  let externalId = "";
  if (instrumentId !== null) {
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
    if (!inst) return { error: "Not found" };
    if (!(await canEditSystem(u, instrumentId))) {
      return { error: (await canSeeSystemSafe(u, instrumentId)) ? "Read-only access to this system" : "Not found" };
    }
    externalId = inst.externalId;
  }
  const siblings = instrumentId !== null
    ? await db.select().from(assets).where(eq(assets.instrumentId, instrumentId)) : [];
  const sortOrder = Math.max(0, ...siblings.map((x) => x.sortOrder)) + 1;
  const [row] = await db.insert(assets).values({
    ...a, instrumentId, sortOrder, status: instrumentId !== null ? "In service" : "Spare",
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
    await generateCheckout(instrumentId, row, u.email);
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
  const failures: { row: number; error: string }[] = [];
  let created = 0;
  for (let i = 0; i < usable.length; i++) {
    const res = await createAsset(instrumentId, usable[i]);
    if (res.error) failures.push({ row: i + 1, error: res.error });
    else created++;
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
  await db.update(assets).set(a).where(eq(assets.id, assetId));
  await audit({
    actor: u.email, instrumentId: before.instrumentId ?? undefined, entityType: "asset", entityId: assetId,
    action: `edited ${assetLabel({ ...before, ...a })}`,
  });
  if (before.instrumentId !== null) rev(before.instrumentId);
  revalidatePath("/assets");
  revalidatePath(`/assets/${assetId}`);
  return {};
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
  await generateCheckout(instrumentId, a, u.email);
  revalidatePath(`/assets/${assetId}`);
  return {};
}

/**
 * Attach several unassigned assets in one go - building a system out of the
 * shelf is normally a list, not one part at a time. Attaches what it can and
 * reports the rest.
 */
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

/** Move an asset straight from one system to another; history follows the asset. */
export async function moveAsset(assetId: number, toInstrumentId: number): Promise<{ error?: string }> {
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
  await generateCheckout(toInstrumentId, a, u.email);
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
    instrumentId: t0.instrumentId, assetId: t0.assetId,
    title: data.title.trim(), body: data.body.trim(), assignee: data.assignee.trim(),
    dueDate: (data.dueDate ?? "").trim(),
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

export async function setTaskState(taskId: number, state: string) {
  const u = await requireEditor();
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t || t.state === state) return;
  // Count open checklist items so a premature Done leaves a trace.
  let suffix = "";
  if (state === "Done") {
    const items = await db.select().from(checklistItems).where(and(eq(checklistItems.taskId, taskId), eq(checklistItems.done, false)));
    if (items.length) suffix = ` (closed with ${items.length} checklist item${items.length > 1 ? "s" : ""} incomplete)`;
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
  const open = await db.select().from(parts).where(
    s.assetId !== null ? eq(parts.assetId, s.assetId) : eq(parts.instrumentId, instrumentId!)
  );
  if (open.some((p) => partOpen(p.status) && p.partNumber.toLowerCase() === want.number.toLowerCase())) {
    return { error: `PN ${want.number} is already requested and not yet installed` };
  }
  const name = want.name || s.title;
  const [p] = await db.insert(parts).values({
    instrumentId, assetId: s.assetId, name, partNumber: want.number,
    qty: "1", status: "Needed", note: `for maintenance '${s.title}'`,
  }).returning();
  await audit({
    actor: u.email, instrumentId, assetId: s.assetId, entityType: "part", entityId: p.id,
    action: `requested part '${name}' (PN ${want.number}) for maintenance '${s.title}'`,
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
  if (!text.trim()) return;
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t) return;
  await assertWorkEditable(u, t);
  await db.insert(checklistItems).values({ taskId, text: text.trim() });
  await audit({
    actor: u.email, instrumentId: t.instrumentId, entityType: "checklist_item", entityId: taskId,
    action: `added checklist item '${text.trim()}' to '${t.title}'`,
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
  if (t) revWork(t);
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

/** Normalize client-supplied kind/specs so only well-formed values are stored. */
function cleanPartInput(data: PartInput): PartInput {
  return {
    ...data,
    kind: data.kind === "consumable" ? "consumable" : "part",
    qty: data.qty.trim(),
    specs: serializeSpecs(parseSpecs(data.specs)),
  };
}

const today = () => shopMonthDay();

/** Auto-stamp the lifecycle date when a part first enters Received / Installed / Removed. */
function partStamps(before: { status: string; receivedAt: string; installedAt: string; removedAt: string }, status: string) {
  return {
    receivedAt: status === "Received" && before.status !== "Received" ? today() : before.receivedAt,
    installedAt: status === "Installed" && before.status !== "Installed" ? today() : before.installedAt,
    removedAt: status === "Removed" && before.status !== "Removed" ? today() : before.removedAt,
  };
}

const partStatusVerb = (status: string) =>
  status === "Installed" ? "installed" : status === "Removed" ? "pulled" : null;

export async function createPart(target: WorkTarget, raw: PartInput): Promise<{ error?: string }> {
  const u = await requireEditor();
  const data = cleanPartInput(raw);
  if (!data.name.trim()) return { error: "Name required" };
  const t0 = await resolveTarget({ instrumentId: target.instrumentId, assetId: raw.assetId ?? target.assetId ?? null });
  if ("error" in t0) return t0;
  if (!isHouse(u.role) && !canSeeCosts(u, await costOwnerOrg(t0))) { data.cost = ""; data.po = ""; }
  const stamps = partStamps({ status: "", receivedAt: "", installedAt: "", removedAt: "" }, data.status);
  const taggedAsset = t0.asset;
  const [p] = await db.insert(parts).values({ ...data, ...stamps, assetId: t0.assetId, name: data.name.trim(), note: data.note.trim(), instrumentId: t0.instrumentId }).returning();
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
  return {};
}

export async function updatePart(partId: number, raw: PartInput) {
  const u = await requireEditor();
  const data = cleanPartInput(raw);
  const [before] = await db.select().from(parts).where(eq(parts.id, partId));
  if (!before) return;
  const stamps = partStamps(before, data.status);
  // Only touch the asset tag when the edit actually changed it - re-validating
  // an unchanged tag would silently clear it if the asset has since detached.
  const retagged = (data.assetId ?? null) !== before.assetId;
  const taggedAsset = retagged ? await validAssetTag(data.assetId, before.instrumentId) : null;
  const assetId = retagged ? taggedAsset?.id ?? null : before.assetId;
  await assertWorkEditable(u, before);
  // An editor who can't see costs must not overwrite them blind.
  if (!isHouse(u.role) && !canSeeCosts(u, await costOwnerOrg(before))) { data.cost = before.cost; data.po = before.po; }
  await db.update(parts).set({ ...data, ...stamps, assetId, name: data.name.trim(), note: data.note.trim() }).where(eq(parts.id, partId));
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
  const t0 = await resolveTarget(target);
  if ("error" in t0) return t0;
  const rows = await db.insert(attachments)
    .values(files.map((f) => ({
      ...f, description: f.description.trim(),
      instrumentId: t0.instrumentId, assetId: t0.instrumentId === null ? t0.assetId : null,
      uploadedBy: u.name,
    })))
    .returning();
  for (const a of rows) {
    await audit({
      actor: u.email, instrumentId: t0.instrumentId, assetId: t0.assetId, entityType: "attachment", entityId: a.id,
      action: `uploaded ${a.kind}: ${a.fileName}${a.description ? ` - ${a.description}` : ""}`,
    });
  }
  revWork({ instrumentId: t0.instrumentId, assetId: t0.assetId });
  return {};
}

export async function updateAttachment(attachmentId: number, data: { fileName: string; kind: string; description: string }) {
  const u = await requireEditor();
  const fileName = data.fileName.trim();
  if (!fileName) throw new Error("File name required");
  const kind = (ATTACH_KINDS as readonly string[]).includes(data.kind) ? data.kind : "Other";
  const description = data.description.trim();
  const [a] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  if (!a || (a.fileName === fileName && a.kind === kind && a.description === description)) return;
  await assertWorkEditable(u, a);
  await db.update(attachments).set({ fileName, kind, description }).where(eq(attachments.id, attachmentId));
  const changes: string[] = [];
  if (a.fileName !== fileName) changes.push(`renamed to '${fileName}'`);
  if (a.kind !== kind) changes.push(`${a.kind} -> ${kind}`);
  if (a.description !== description) changes.push("description updated");
  await audit({
    actor: u.email, instrumentId: a.instrumentId, assetId: a.assetId, entityType: "attachment", entityId: attachmentId,
    action: `edited attachment '${a.fileName}': ${changes.join(", ")}`,
    field: "description", oldValue: a.description, newValue: description,
  });
  revWork(a);
}

/** Best-effort blob removal - never lets a storage hiccup block the record delete. */
async function deleteBlobs(urls: string[]) {
  if (!urls.length) return;
  try {
    const { del } = await import("@vercel/blob");
    await del(urls);
  } catch (e) {
    console.error("[blob] delete failed (orphaned file, harmless but billed):", (e as Error).message);
  }
}

export async function deleteAttachment(attachmentId: number, reason: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [a] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  if (!a) return {};
  await assertWorkEditable(u, a);
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
  if (target.instrumentId !== null) {
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, target.instrumentId));
    if (!inst) throw new Error("Not found");
    await db.insert(eodUpdates)
      .values({ instrumentId: target.instrumentId, date, systemUpdate, actionItem, updatedBy: u.name, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [eodUpdates.instrumentId, eodUpdates.date],
        set: { systemUpdate, actionItem, updatedBy: u.name, updatedAt: new Date() },
      });
  } else if (target.assetId !== null) {
    const [a] = await db.select().from(assets).where(eq(assets.id, target.assetId));
    if (!a) throw new Error("Not found");
    await db.insert(eodUpdates)
      .values({ assetId: target.assetId, date, systemUpdate, actionItem, updatedBy: u.name, updatedAt: new Date() })
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
  const { subject, html, filled, total } = await composeEodEmail(shopToday(), shopTodayMDY(), orgId);
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
      .values({ instrumentId: target.instrumentId, date, skipped, updatedBy: u.name, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [eodUpdates.instrumentId, eodUpdates.date],
        set: { skipped, updatedBy: u.name, updatedAt: new Date() },
      });
  } else if (target.assetId !== null) {
    const [a] = await db.select().from(assets).where(eq(assets.id, target.assetId));
    if (!a) throw new Error("Not found");
    await db.insert(eodUpdates)
      .values({ assetId: target.assetId, date, skipped, updatedBy: u.name, updatedAt: new Date() })
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
}): Promise<string[]> {
  const staff = parseList(process.env.STAFF_EMAILS);
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

/** The viewer as the discussion rules see them: the house, or one organization. */
const partyOf = (u: SessionUser): Viewer => ({ isHouse: isHouse(u.role), orgId: u.orgId });

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

  if (instrumentId !== null) {
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
    if (!inst) throw new Error("Not found");
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
    instrumentId, author: u.name, authorEmail: u.email, body: text, authorOrgId, audience, roomOrgId,
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
    allowedEmails: await postAudience({ instrumentId, audience, authorOrgId, roomOrgId }),
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
  parts: ProcPart[]; modelScope: string[];
};

/** Validate + normalize; returns {error} or clean column values. */
function cleanProcedure(data: ProcedureInput): { error: string } | {
  assetType: string; kind: string; name: string; notes: string;
  resultType: string; target: string | null; tolerancePct: string | null;
  requiresNote: boolean; consumesPart: boolean;
  runsAtIntake: boolean; intervalDays: number | null;
  parts: string; modelScope: string[];
} {
  if (!validProcedureType(data.assetType)) return { error: "Pick an asset type" };
  if (!(CHECKOUT_KINDS as readonly string[]).includes(data.kind)) return { error: "Pick task or test" };
  const name = data.name.trim();
  if (!name || name.length > 120) return { error: "Name must be 1-120 characters" };
  const isTest = data.kind === "test";
  const resultType = isTest && (RESULT_TYPES as readonly string[]).includes(data.resultType) ? data.resultType : "pass_fail";
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
  // Recurring work is scheduled per asset; a system has no asset to schedule.
  if (data.assetType === "system" && intervalDays !== null) {
    return { error: "System procedures run at intake only - recurring work lives on the modules" };
  }
  // System items fire when a system is created, before it has any assets to
  // scope by, so they always apply to every new system.
  const modelScope = data.assetType === "system"
    ? [] : [...new Set(data.modelScope.map((m) => m.trim()).filter(Boolean))];
  return {
    assetType: data.assetType, kind: data.kind, name, notes: data.notes.trim(),
    resultType, target, tolerancePct,
    requiresNote: !isTest && data.requiresNote, consumesPart: !isTest && data.consumesPart,
    runsAtIntake: data.runsAtIntake, intervalDays,
    parts: serializeProcParts(data.parts), modelScope,
  };
}

const procScopeLabel = (scope: string[]) => (scope.length ? ` (${scope.join(", ")} only)` : "");
const procTimingLabel = (p: { runsAtIntake: boolean; intervalDays: number | null }) =>
  p.runsAtIntake && p.intervalDays !== null ? `at intake + ${cadenceLabel(p.intervalDays)}`
    : p.runsAtIntake ? "at intake" : cadenceLabel(p.intervalDays!);

export async function addProcedure(data: ProcedureInput): Promise<{ error?: string; applied?: number }> {
  const u = await requireStaff();
  const clean = cleanProcedure(data);
  if ("error" in clean) return clean;
  const siblings = await db.select().from(procedures).where(eq(procedures.assetType, clean.assetType));
  if (siblings.some((i) => i.kind === clean.kind && i.name.toLowerCase() === clean.name.toLowerCase()
      && i.modelScope.join("|").toLowerCase() === clean.modelScope.join("|").toLowerCase()))
    return { error: `"${clean.name}" already exists for this type` };
  const position = Math.max(0, ...siblings.map((i) => i.position)) + 1;
  const [row] = await db.insert(procedures).values({ ...clean, position }).returning();
  await audit({
    actor: u.email, entityType: "procedure", entityId: row.id,
    action: `added ${clean.kind} procedure "${clean.name}" for ${clean.assetType} - ${procTimingLabel(clean)}${procScopeLabel(clean.modelScope)}`,
  });
  // A new recurring procedure covers the fleet already on the floor, per unit
  // deduped by title so hand-written schedules block the catalog's copy.
  let applied = 0;
  if (clean.intervalDays !== null) applied = await backfillProcedure(clean.assetType, shopToday(), u.email);
  revalidatePath("/settings/procedures");
  revalidatePath("/maintenance");
  return { applied };
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
  const siblings = await db.select().from(procedures).where(eq(procedures.assetType, before.assetType));
  if (siblings.some((i) => i.id !== procedureId && i.kind === clean.kind && i.name.toLowerCase() === clean.name.toLowerCase()
      && i.modelScope.join("|").toLowerCase() === clean.modelScope.join("|").toLowerCase()))
    return { error: `"${clean.name}" already exists for this type` };
  await db.update(procedures).set(clean).where(eq(procedures.id, procedureId));
  await audit({
    actor: u.email, entityType: "procedure", entityId: procedureId,
    action: `edited ${clean.kind} procedure "${clean.name}" for ${before.assetType} - ${procTimingLabel(clean)}${procScopeLabel(clean.modelScope)}`,
    field: "procedure",
    oldValue: `${before.kind} | ${before.name} | ${procTimingLabel(before)} | ${before.modelScope.join(", ")}`,
    newValue: `${clean.kind} | ${clean.name} | ${procTimingLabel(clean)} | ${clean.modelScope.join(", ")}`,
  });

  const addedRepeat = before.intervalDays === null && clean.intervalDays !== null;
  const removedRepeat = before.intervalDays !== null && clean.intervalDays === null;
  const changedInterval = before.intervalDays !== null && clean.intervalDays !== null && before.intervalDays !== clean.intervalDays;
  let applied = 0, retimed = 0, unscheduled = 0;
  if (applyNow && addedRepeat) {
    applied = await backfillProcedure(before.assetType, shopToday(), u.email);
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
  await db.insert(stageDefs).values({ name: n, bg: bg.toUpperCase(), fg: autoFg(bg), sortOrder }).onConflictDoNothing();
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

// ---------------- People roster ----------------
// Task assignees and @mention targets, Sierra + LabZen. Owner-managed in Settings.

export async function addPerson(name: string, email: string, org: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const n = name.trim();
  const e = email.trim().toLowerCase();
  if (!n || n.length > 40) return { error: "Name must be 1-40 characters" };
  if (e && !ALLOW_EMAIL.test(e)) return { error: "Enter a valid email, or leave it blank" };
  // Free-text org name (or blank) - the roster predates real organizations
  // and stays lightweight; the name is only used for labels and the EOD
  // "client-led" rule.
  const o = org.trim().slice(0, 60);
  const existing = await db.select().from(people);
  if (existing.some((p) => p.name.toLowerCase() === n.toLowerCase())) return { error: `"${n}" is already on the roster` };
  await db.insert(people).values({ name: n, email: e, org: o }).onConflictDoNothing();
  await audit({
    actor: u.email, entityType: "settings", entityId: n,
    action: `added person to roster: ${n}${e ? ` <${e}>` : ""}${o ? ` (${o})` : ""}`,
  });
  revalidatePath("/settings");
  return {};
}

export async function removePerson(id: number) {
  const u = await requireOwner();
  const [p] = await db.select().from(people).where(eq(people.id, id));
  if (!p) return;
  await db.delete(people).where(eq(people.id, id));
  await audit({
    actor: u.email, entityType: "settings", entityId: p.name,
    action: `removed person from roster: ${p.name}`,
  });
  revalidatePath("/settings");
}

/** Who the EOD "Send to LabZen" button emails. Comma-separated. */
/** Who receives one organization's daily report. Each client has its own list. */
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
  // The owner invites anyone anywhere; an organization's editors invite their
  // own colleagues - exact emails only, into their own org. Domains stay an
  // operator-level grant.
  const u = await requireEditor();
  const entry = raw.trim().toLowerCase();
  const selfService = u.role !== "owner";
  if (selfService) {
    if (u.role === "staff" || u.orgId === null || orgId !== u.orgId) return { error: "Not found" };
    if (!ALLOW_EMAIL.test(entry)) return { error: 'Enter a colleague\'s email, like "jane@company.com"' };
  } else if (!ALLOW_EMAIL.test(entry) && !ALLOW_DOMAIN.test(entry)) {
    // Returned, not thrown: prod masks thrown server-action messages.
    return { error: 'Enter an email like "jane@company.com" or a domain like "@company.com"' };
  }
  // An entry with no organization would be a login with no scope, so require it.
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Pick which organization they sign in as" };
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

/** Owner-only: flip an entry between editor and viewer. Takes effect on their next page load. */
export async function setClientAccessRole(id: number, canEdit: boolean): Promise<{ error?: string }> {
  const u = await requireOwner();
  const [row] = await db.select().from(clientAllowlist).where(eq(clientAllowlist.id, id));
  if (!row) return { error: "Not found" };
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

export async function setClientAccessOrg(id: number, orgId: number): Promise<{ error?: string }> {
  const u = await requireOwner();
  const [row] = await db.select().from(clientAllowlist).where(eq(clientAllowlist.id, id));
  if (!row) return { error: "Not found" };
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Pick an organization" };
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
  // Owner removes anyone; an org's editors remove their own colleagues
  // (exact-email rows in their own org only).
  const u = await requireEditor();
  const [row] = await db.select().from(clientAllowlist).where(eq(clientAllowlist.id, id));
  if (!row) return;
  if (u.role !== "owner") {
    if (u.role === "staff" || u.orgId === null || row.orgId !== u.orgId || row.entry.trim().startsWith("@")) return;
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
  if (!isHouse(u.role)) {
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

export async function unshareSystem(instrumentId: number, orgId: number): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };
  if (!isHouse(u.role)) {
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
      await db.insert(engagementRecords).values({
        instrumentId, orgId, externalId: inst.externalId, label: dossier.label,
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
 * Whose system it is. Ownership doesn't grant visibility (shares do) - it
 * says which client org's editors decide access requests. Setting it is the
 * house's call, and it's also the claim flow: when the real owner of an
 * unclaimed, provider-created system joins the platform, staff hand it over.
 */
export async function setSystemOwner(instrumentId: number, orgId: number | null): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  let org: typeof orgs.$inferSelect | undefined;
  if (orgId !== null) {
    [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
    if (!org) return { error: "Not found" };
  }
  if (inst.ownerOrgId === orgId) return {};
  await db.update(instruments).set({ ownerOrgId: orgId }).where(eq(instruments.id, instrumentId));
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
  error?: string; results?: ImportRowResult[]; systems?: number; assets?: number;
}> {
  const u = await requireEditor();
  if (!rows.length) return { error: "Nothing to import" };
  if (rows.length > IMPORT_MAX_ROWS) return { error: `Import ${IMPORT_MAX_ROWS} rows at a time (got ${rows.length})` };

  const existing = await db.select({ id: instruments.id, externalId: instruments.externalId }).from(instruments);
  const byExt = new Map(existing.map((i) => [i.externalId.toLowerCase(), i.id]));
  const createdThisRun = new Map<string, number>(); // externalId -> new instrument id
  const results: ImportRowResult[] = [];
  let systemsMade = 0, assetsMade = 0;

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
      await db.insert(vocabTerms).values(newTerms).onConflictDoNothing();
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
  return { results, systems: systemsMade, assets: assetsMade };
}

// ---------------- View as ----------------

/**
 * Walk the portal with an organization's permissions. Gated on the REAL
 * session being the owner's - a persona can't grant itself another one, and it
 * can always be exited even though the persona itself may not reach Settings.
 * Nothing is impersonated but authorization: writes stay audited under the
 * owner's own email.
 */
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
  if (!isHouse(u.role)) {
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
export async function setAssetOwnerOrg(assetId: number, orgId: number | null): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!asset) return { error: "Not found" };
  let org: typeof orgs.$inferSelect | undefined;
  if (orgId !== null) {
    [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
    if (!org) return { error: "Not found" };
  }
  if (asset.ownerOrgId === orgId) return {};
  await db.update(assets).set({ ownerOrgId: orgId }).where(eq(assets.id, assetId));
  await audit({
    actor: u.email, assetId, entityType: "asset", entityId: assetId,
    action: org ? `made ${org.name} the owner of ${assetLabel(asset)}` : `returned ${assetLabel(asset)} to house stewardship`,
    field: "owner", newValue: org?.name ?? "",
  });
  revalidatePath(`/assets/${assetId}`);
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
async function ownerAudience(ownerOrgId: number | null): Promise<string[]> {
  const staff = parseList(process.env.STAFF_EMAILS);
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
  const u = await requireOwner();
  const n = name.trim();
  if (!n || n.length > 60) return { error: "Name must be 1-60 characters" };
  const k = kind === "provider" ? "provider" : "client";
  const existing = await db.select().from(orgs);
  if (existing.some((o) => o.name.toLowerCase() === n.toLowerCase())) return { error: `${n} already exists` };
  const [row] = await db.insert(orgs).values({ name: n, kind: k }).returning();
  await audit({ actor: u.email, entityType: "org", entityId: row.id, action: `created ${k} organization "${n}"` });
  revalidatePath("/settings");
  return { id: row.id };
}

export async function removeOrg(orgId: number, reason: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return {};
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
  const u = await requireOwner();
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
  const u = await requireOwner();
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

/** Optional modules, per instance: the sheet tracker, EOD report and digest. */
export async function setModule(
  moduleKey: "sheetSync" | "eod" | "digest", on: boolean,
): Promise<{ error?: string }> {
  const u = await requireOwner();
  const col = moduleKey === "sheetSync" ? { sheetSyncEnabled: on } : moduleKey === "eod" ? { eodEnabled: on } : { digestEnabled: on };
  await db.update(appSettings).set(col).where(eq(appSettings.id, 1));
  const label = moduleKey === "sheetSync" ? "sheet tracker sync" : moduleKey === "eod" ? "EOD client report" : "daily digest";
  await audit({
    actor: u.email, entityType: "settings", entityId: `module_${moduleKey}`,
    action: `turned the ${label} ${on ? "on" : "off"}`,
  });
  revalidatePath("/", "layout");
  revalidatePath("/settings");
  return {};
}

export async function setSheetOrg(orgId: number | null) {
  const u = await requireOwner();
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
  if (kind !== "category" && kind !== "model" && kind !== "asset_type") return { error: "Unknown vocabulary kind" };
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
    .values({ kind, assetType: at, name: n, categories: cats, manufacturer: kind === "model" ? manufacturer.trim() : "" })
    .returning();
  await audit({
    actor: u.email, entityType: "vocab", entityId: row.id,
    action: kind === "category" ? `defined system category "${n}"`
      : kind === "asset_type" ? `defined asset type "${n}"`
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

/** Who makes a model. Blank is honest for kit whose maker nobody recorded. */
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
  const u = await requireOwner();
  await db.insert(appSettings)
    .values({ id: 1, clientAccessEnabled: data.clientAccessEnabled })
    .onConflictDoUpdate({ target: appSettings.id, set: { clientAccessEnabled: data.clientAccessEnabled } });
  await audit({
    actor: u.email, entityType: "settings", entityId: 1,
    action: `client sign-in ${data.clientAccessEnabled ? "on" : "off"}`,
  });
  revalidatePath("/settings");
}
