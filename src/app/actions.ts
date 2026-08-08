"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { eq, and, asc, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { redirect } from "next/navigation";
import {
  instruments, instrumentGases, tasks, checklistItems, itemNotes, taskNotes, parts, attachments,
  sheetDiffs, appSettings, eodUpdates, clientAllowlist, users, sessions, stageDefs,
  stageEvents, discussionPosts, people, assets, assetEvents, discussionReads, vocabTerms, systemShares, orgs,
  checkoutItems, engagementRecords, accessRequests,
} from "@/db/schema";
import { matchesEntry, roleForEmail, emailInClientAllowlist } from "@/auth";
import { parseList } from "@/lib/allowMatch";
import { getStageDefs } from "@/lib/stageDefs";
import { notifyTaskAssigned, notifyGasEmpty, notifyDiscussion, notifySystemAssigned, notifyAccessRequest } from "@/lib/notify";
import { normalizeSerial, MIN_SERIAL_LOOKUP } from "@/lib/serial";
import { isValidHex } from "@/lib/theme";
import { canSeeCosts } from "@/lib/redact";
import { audit } from "@/lib/audit";
import { requireUser, requireEditor, requireStaff, requireOwner, type SessionUser } from "@/lib/authz";
import { pushValueToSheet, fetchTrackerRows, appendInstrumentToSheet } from "@/lib/sheetSync";
import { GASES, GAS_STATES, ATTACH_KINDS, MODULE_KINDS, ASSET_STATES, autoFg } from "@/lib/stages";
import { shopToday, shopTodayMDY, shopMonthDay } from "@/lib/shopday";
import { composeEodEmail } from "@/lib/eodEmail";
import { parseSpecs, serializeSpecs } from "@/lib/partSpecs";
import { matchItems, summarizeItem, CHECKOUT_KINDS, RESULT_TYPES } from "@/lib/checkout";
import { composeSystemLabel } from "@/lib/systemLabel";
import { composeSystemDossier } from "@/lib/dossier";
import {
  assertSystemEditable, assertSystemVisible, assertWorkEditable, assetAccess,
  canEditSystem, isHouse, visibleSystemIds,
} from "@/lib/tenancy";
import { sendEmail } from "@/lib/email";

/** A system is named by its assets; the stored description is the fallback. */
async function systemLabelFor(inst: { id: number; model: string }) {
  const rows = await db.select().from(assets).where(eq(assets.instrumentId, inst.id));
  return composeSystemLabel(rows, inst.model);
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
  data: { externalId?: string; client: string; category?: string; priority: number; location?: string },
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
  const changed: [string, string, string][] = [];
  if (externalId !== inst.externalId) changed.push(["externalId", inst.externalId, externalId]);
  if (location !== inst.location) changed.push(["location", inst.location, location]);
  if (client !== inst.client) changed.push(["client", inst.client, client]);
  if (category !== inst.category) changed.push(["category", inst.category, category]);
  if (priority !== inst.priority) changed.push(["priority", String(inst.priority), String(priority)]);
  if (!changed.length) return {};
  await db.update(instruments).set({ externalId, client, category, priority, location, updatedAt: new Date() }).where(eq(instruments.id, instrumentId));
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
 */
async function creatorOwns(orgId: number | null): Promise<number | null> {
  if (orgId === null) return null;
  const [org] = await db.select({ kind: orgs.kind }).from(orgs).where(eq(orgs.id, orgId));
  return org?.kind === "client" ? orgId : null;
}

// ---------------- Assets ----------------
// First-class units systems are built from. Work is recorded on the system
// and tagged with the asset; lifecycle rows here give the dossier its spine.

type AssetInput = { kind: string; model: string; serial: string; manufacturer: string; owner: string; asFound?: string; location: string; note: string };

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
  const items = await db.select().from(checkoutItems).where(eq(checkoutItems.assetType, assetType));
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
      instrumentId, title: i.name, body: summarizeItem(i), origin: "checkout",
      assetId: target.id, sortOrder: i.position,
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
  revalidatePath("/assets");
  revalidatePath(`/assets/${row.id}`);
  return { id: row.id };
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
  // Checkout tests are auto-generated, so any editor may clear ones that
  // don't apply; hand-written tasks stay staff-only to delete.
  const u = t.origin === "checkout" ? await requireEditor() : await requireStaff();
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
  revWork(t);
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

/** Upsert today's client-facing update draft for one system. Not audited - it's a draft, not instrument history. */
export async function saveEodUpdate(instrumentId: number, data: { systemUpdate: string; actionItem: string }) {
  const u = await requireStaff();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) throw new Error("Not found");
  const date = shopToday();
  const systemUpdate = data.systemUpdate.trim();
  const actionItem = data.actionItem.trim();
  await db.insert(eodUpdates)
    .values({ instrumentId, date, systemUpdate, actionItem, updatedBy: u.name, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [eodUpdates.instrumentId, eodUpdates.date],
      set: { systemUpdate, actionItem, updatedBy: u.name, updatedAt: new Date() },
    });
  // No revalidatePath here on purpose: autosave fires on every typing pause,
  // and a revalidate would make the client re-fetch the whole page each time
  // (visible jank on mobile). The typist's screen is already current; other
  // viewers get fresh data on page load, which is how the EOD flow works.
}

/** Email today's EOD report to the recipients configured in Settings. */
export async function sendEodEmail(): Promise<{ error?: string; sent?: number }> {
  const u = await requireStaff();
  const [s] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  const to = (s?.eodRecipients ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!to.length) return { error: "No recipients configured - add them in Settings first" };
  const { subject, html, filled, total } = await composeEodEmail(shopToday(), shopTodayMDY());
  if (!total) return { error: "No active systems to report on" };
  if (!filled) return { error: "Every system is still blank - fill in at least one update before sending" };
  try {
    await sendEmail(to, subject, html);
  } catch (e) {
    // Explicit user action, so surface the failure instead of swallowing it.
    console.error("[eod] send failed:", (e as Error).message);
    return { error: "Email failed to send - check AUTH_RESEND_KEY / EMAIL_FROM and try again" };
  }
  await audit({
    actor: u.email, entityType: "eod", entityId: shopToday(),
    action: `sent EOD update to ${to.length} recipient${to.length === 1 ? "" : "s"}`,
  });
  revalidatePath("/eod");
  return { sent: to.length };
}

/** Leave a system out of (or bring it back into) today's client email. Keeps any saved text. */
export async function setEodSkip(instrumentId: number, skipped: boolean) {
  const u = await requireStaff();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) throw new Error("Not found");
  await db.insert(eodUpdates)
    .values({ instrumentId, date: shopToday(), skipped, updatedBy: u.name, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [eodUpdates.instrumentId, eodUpdates.date],
      set: { skipped, updatedBy: u.name, updatedAt: new Date() },
    });
  revalidatePath("/eod");
}

// ---------------- Discussions ----------------

/**
 * Who may be emailed about a thread: staff always, plus the sign-in entries of
 * the organizations the system is shared with. The email quotes the post, so a
 * roster @mention must not carry another client's words out of the portal.
 * Null = staff-only (no restriction beyond that), for the General board.
 */
async function threadAudience(instrumentId: number | null): Promise<string[] | null> {
  const staff = parseList(process.env.STAFF_EMAILS);
  if (instrumentId === null) return null;
  const shares = await db.select({ orgId: systemShares.orgId }).from(systemShares)
    .where(eq(systemShares.instrumentId, instrumentId));
  if (!shares.length) return staff;
  const entries = await db.select().from(clientAllowlist);
  const orgIds = new Set(shares.map((s) => s.orgId));
  // Exact-email entries are addressable; a @domain entry names no one in
  // particular, so it can't be a recipient on its own.
  const orgEmails = entries
    .filter((e) => e.orgId !== null && orgIds.has(e.orgId) && !e.entry.trim().startsWith("@"))
    .map((e) => e.entry.toLowerCase());
  return [...new Set([...staff, ...orgEmails])];
}
// Posting only needs a signed-in user: talking is not record-editing, so
// client viewers may post even while the edit toggle is off.

export async function postDiscussion(instrumentId: number | null, body: string) {
  const u = await requireUser();
  const text = body.trim();
  if (!text) throw new Error("Post text required");
  let externalId = "";
  if (instrumentId !== null) {
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
    if (!inst) throw new Error("Not found");
    // A thread lives with its system: you can only post where you can see.
    await assertSystemVisible(u, instrumentId);
    externalId = inst.externalId;
  } else if (u.orgId !== null) {
    // The General board is the house's room with the tracker's organization.
    const [s] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
    if (s?.sheetOrgId !== u.orgId) throw new Error("Not found");
  }
  await db.insert(discussionPosts).values({ instrumentId, author: u.name, authorEmail: u.email, body: text });
  await audit({
    actor: u.email, instrumentId: instrumentId ?? undefined, entityType: "discussion", entityId: externalId || "general",
    action: `posted in ${externalId ? `${externalId} ` : "general "}discussion: "${text.length > 120 ? text.slice(0, 120) + "..." : text}"`,
  });
  await notifyDiscussion({
    actorEmail: u.email, actorName: u.name,
    actorIsClient: u.role === "client_viewer" || u.role === "client_editor",
    body: text, instrumentId, label: externalId || "General",
    allowedEmails: await threadAudience(instrumentId),
  });
  if (instrumentId !== null) rev(instrumentId);
  revalidatePath("/discussions");
}

/** Mark a thread read for the current user (0 = the General board). */
export async function markThreadRead(threadId: number) {
  const u = await requireUser();
  // 0 is the General board; anything else must be a system the caller can see,
  // so a read marker can't be used to probe which system ids exist.
  if (threadId !== 0) await assertSystemVisible(u, threadId);
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
  // Editing someone else's words was possible for any editor - your own posts
  // (or staff) only.
  if (!isHouse(u.role) && p.authorEmail.toLowerCase() !== u.email.toLowerCase()) {
    throw new Error("You can only edit your own posts");
  }
  if (p.instrumentId !== null) await assertSystemVisible(u, p.instrumentId);
  await db.update(discussionPosts).set({ body: text }).where(eq(discussionPosts.id, postId));
  await audit({
    actor: u.email, instrumentId: p.instrumentId ?? undefined, entityType: "discussion", entityId: postId,
    action: `edited a discussion post by ${p.author}`, field: "body", oldValue: p.body, newValue: text,
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
  if (!isHouse(u.role) && p.authorEmail.toLowerCase() !== u.email.toLowerCase()) {
    return { error: "You can only delete your own posts" };
  }
  if (p.instrumentId !== null) await assertSystemVisible(u, p.instrumentId);
  await db.delete(discussionPosts).where(eq(discussionPosts.id, postId));
  await audit({
    actor: u.email, instrumentId: p.instrumentId ?? undefined, entityType: "discussion", entityId: postId,
    action: `deleted a discussion post by ${p.author} - reason: ${why}`, field: "body", oldValue: p.body, newValue: why,
  });
  if (p.instrumentId !== null) rev(p.instrumentId);
  revalidatePath("/discussions");
  return {};
}

// ---------------- Checkout items ----------------
// Tasks and tests auto-created when an asset lands on a system (assetType
// "system" items fire when a system is created). Per kind, model-scoped
// items replace the type's all-model items for matching models.

/** "system" plus any nonempty type name - asset kinds are an open vocabulary. */
const validCheckoutType = (t: string) => t === "system" || (!!t.trim() && t.trim().length <= 40);

type CheckoutItemInput = {
  assetType: string; kind: string; name: string;
  resultType: string; target: string; tolerancePct: string;
  requiresNote: boolean; consumesPart: boolean;
  modelScope: string[];
};

/** Validate + normalize a checkout item; returns {error} or clean values. */
function cleanCheckoutItem(data: CheckoutItemInput): { error: string } | {
  assetType: string; kind: string; name: string;
  resultType: string; target: string | null; tolerancePct: string | null;
  requiresNote: boolean; consumesPart: boolean; modelScope: string[];
} {
  if (!validCheckoutType(data.assetType)) return { error: "Pick an asset type" };
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
  // System items fire when a system is created, before it has any assets to
  // scope by, so they always apply to every new system.
  const modelScope = data.assetType === "system"
    ? [] : [...new Set(data.modelScope.map((m) => m.trim()).filter(Boolean))];
  return {
    assetType: data.assetType, kind: data.kind, name, resultType, target, tolerancePct,
    requiresNote: !isTest && data.requiresNote, consumesPart: !isTest && data.consumesPart, modelScope,
  };
}

const checkoutScopeLabel = (scope: string[]) => (scope.length ? ` (${scope.join(", ")} only)` : "");

export async function addCheckoutItem(data: CheckoutItemInput): Promise<{ error?: string }> {
  const u = await requireStaff();
  const clean = cleanCheckoutItem(data);
  if ("error" in clean) return clean;
  const siblings = await db.select().from(checkoutItems).where(eq(checkoutItems.assetType, clean.assetType));
  if (siblings.some((i) => i.kind === clean.kind && i.name.toLowerCase() === clean.name.toLowerCase()
      && i.modelScope.join("|").toLowerCase() === clean.modelScope.join("|").toLowerCase()))
    return { error: `"${clean.name}" already exists for this type` };
  const position = Math.max(0, ...siblings.map((i) => i.position)) + 1;
  const [row] = await db.insert(checkoutItems).values({ ...clean, position }).returning();
  await audit({
    actor: u.email, entityType: "checkout", entityId: row.id,
    action: `added checkout ${clean.kind} "${clean.name}" for ${clean.assetType}${checkoutScopeLabel(clean.modelScope)}`,
  });
  revalidatePath("/checkout");
  return {};
}

export async function updateCheckoutItem(itemId: number, data: CheckoutItemInput): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [before] = await db.select().from(checkoutItems).where(eq(checkoutItems.id, itemId));
  if (!before) return { error: "Not found" };
  const clean = cleanCheckoutItem({ ...data, assetType: before.assetType }); // type is fixed at creation
  if ("error" in clean) return clean;
  const siblings = await db.select().from(checkoutItems).where(eq(checkoutItems.assetType, before.assetType));
  if (siblings.some((i) => i.id !== itemId && i.kind === clean.kind && i.name.toLowerCase() === clean.name.toLowerCase()
      && i.modelScope.join("|").toLowerCase() === clean.modelScope.join("|").toLowerCase()))
    return { error: `"${clean.name}" already exists for this type` };
  await db.update(checkoutItems).set({
    kind: clean.kind, name: clean.name, resultType: clean.resultType, target: clean.target,
    tolerancePct: clean.tolerancePct, requiresNote: clean.requiresNote, consumesPart: clean.consumesPart,
    modelScope: clean.modelScope,
  }).where(eq(checkoutItems.id, itemId));
  await audit({
    actor: u.email, entityType: "checkout", entityId: itemId,
    action: `edited checkout ${clean.kind} "${clean.name}" for ${before.assetType}${checkoutScopeLabel(clean.modelScope)}`,
    field: "item", oldValue: `${before.kind} | ${before.name} | ${before.modelScope.join(", ")}`,
    newValue: `${clean.kind} | ${clean.name} | ${clean.modelScope.join(", ")}`,
  });
  revalidatePath("/checkout");
  return {};
}

export async function deleteCheckoutItem(itemId: number) {
  const u = await requireStaff();
  const [i] = await db.select().from(checkoutItems).where(eq(checkoutItems.id, itemId));
  if (!i) return;
  await db.delete(checkoutItems).where(eq(checkoutItems.id, itemId));
  await audit({
    actor: u.email, entityType: "checkout", entityId: itemId,
    action: `removed checkout ${i.kind} "${i.name}" for ${i.assetType}${checkoutScopeLabel(i.modelScope)}`,
  });
  revalidatePath("/checkout");
}

/** Persist a drag-reorder within one asset type's list. */
export async function reorderCheckoutItems(assetType: string, orderedIds: number[]) {
  const u = await requireStaff();
  if (!validCheckoutType(assetType)) return;
  const siblings = await db.select().from(checkoutItems).where(eq(checkoutItems.assetType, assetType));
  const known = new Map(siblings.map((i) => [i.id, i]));
  let position = 1;
  for (const id of orderedIds) {
    const item = known.get(id);
    if (!item) continue; // ignore ids from other types or stale UIs
    if (item.position !== position) {
      await db.update(checkoutItems).set({ position }).where(eq(checkoutItems.id, id));
    }
    position++;
  }
  await audit({
    actor: u.email, entityType: "checkout", entityId: assetType,
    action: `reordered the ${assetType} checkout list`,
  });
  revalidatePath("/checkout");
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
  const o = org === "labzen" ? "labzen" : "sierra";
  const existing = await db.select().from(people);
  if (existing.some((p) => p.name.toLowerCase() === n.toLowerCase())) return { error: `"${n}" is already on the roster` };
  await db.insert(people).values({ name: n, email: e, org: o }).onConflictDoNothing();
  await audit({
    actor: u.email, entityType: "settings", entityId: n,
    action: `added ${o === "labzen" ? "LabZen" : "Sierra"} person to roster: ${n}${e ? ` <${e}>` : ""}`,
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
export async function updateEodRecipients(value: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const entries = value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = entries.find((e) => !ALLOW_EMAIL.test(e));
  if (bad) return { error: `"${bad}" doesn't look like an email` };
  const eodRecipients = entries.join(", ");
  await db.insert(appSettings)
    .values({ id: 1, eodRecipients })
    .onConflictDoUpdate({ target: appSettings.id, set: { eodRecipients } });
  await audit({
    actor: u.email, entityType: "settings", entityId: 1,
    action: `EOD recipients: ${eodRecipients || "(none)"}`,
  });
  revalidatePath("/settings");
  revalidatePath("/eod");
  return {};
}

// ---------------- Client sign-in allowlist ----------------

/** "jane@labzenllc.com" (one person) or "@labzenllc.com" (whole domain). */
const ALLOW_EMAIL = /^[^\s@]+@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;
const ALLOW_DOMAIN = /^@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;

export async function addClientAccess(raw: string, orgId: number): Promise<{ error?: string }> {
  const u = await requireOwner();
  const entry = raw.trim().toLowerCase();
  if (!ALLOW_EMAIL.test(entry) && !ALLOW_DOMAIN.test(entry)) {
    // Returned, not thrown: prod masks thrown server-action messages.
    return { error: 'Enter an email like "jane@labzenllc.com" or a domain like "@labzenllc.com"' };
  }
  // An entry with no organization would be a login with no scope, so require it.
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Pick which organization they sign in as" };
  await db.insert(clientAllowlist).values({ entry, orgId, addedBy: u.name }).onConflictDoNothing();
  await audit({
    actor: u.email, entityType: "settings", entityId: entry,
    action: `allowed client sign-in: ${entry} as ${org.name}`,
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
  const u = await requireOwner();
  const [row] = await db.select().from(clientAllowlist).where(eq(clientAllowlist.id, id));
  if (!row) return;
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
    const dossier = await composeSystemDossier(instrumentId);
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
    if (org.kind !== "client") return { error: "Only a client organization can own a system" };
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

export async function setAttachmentListed(attachmentId: number, on: boolean): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [file] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  if (!file || file.instrumentId === null) return { error: "Not found" }; // listings are per-system
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, file.instrumentId));
  if (!inst) return { error: "Not found" };
  if (!canSell(u, inst)) {
    return { error: (await canSeeSystemSafe(u, file.instrumentId)) ? "Only the system's owner curates the listing" : "Not found" };
  }
  await db.update(attachments).set({ showOnListing: on }).where(eq(attachments.id, attachmentId));
  await audit({
    actor: u.email, instrumentId: file.instrumentId, entityType: "attachment", entityId: attachmentId,
    action: `${on ? "added" : "removed"} '${file.fileName}' ${on ? "to" : "from"} the public listing`,
  });
  rev(file.instrumentId);
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
  // Only a client organization can own a system, so only a client may claim one.
  const want = kind === "claim" ? "claim" : "access";
  if (want === "claim" && u.orgKind !== "client") {
    return { error: "Only a client organization can claim ownership" };
  }
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
  if (org.kind !== "client") return { error: "Only a client organization can own a system" };
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

export async function addVocabTerm(kind: string, assetType: string, name: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  if (kind !== "category" && kind !== "model") return { error: "Unknown vocabulary kind" };
  const at = kind === "model" ? assetType.trim() : "";
  if (kind === "model" && !at) return { error: "Pick which asset type the model belongs to" };
  const n = name.trim();
  if (!n || n.length > 60) return { error: "Name must be 1-60 characters" };
  const existing = await db.select().from(vocabTerms).where(eq(vocabTerms.kind, kind));
  if (existing.some((t) => t.assetType.toLowerCase() === at.toLowerCase() && t.name.toLowerCase() === n.toLowerCase()))
    return { error: `${n} is already defined` };
  const [row] = await db.insert(vocabTerms).values({ kind, assetType: at, name: n }).returning();
  await audit({
    actor: u.email, entityType: "vocab", entityId: row.id,
    action: kind === "category" ? `defined system category "${n}"` : `defined model "${n}" for ${at}`,
  });
  revalidatePath("/settings");
  revalidatePath("/checkout");
  rev();
  return {};
}

export async function deleteVocabTerm(termId: number) {
  const u = await requireOwner();
  const [t] = await db.select().from(vocabTerms).where(eq(vocabTerms.id, termId));
  if (!t) return;
  await db.delete(vocabTerms).where(eq(vocabTerms.id, termId));
  await audit({
    actor: u.email, entityType: "vocab", entityId: termId,
    action: t.kind === "category"
      ? `removed system category "${t.name}" from the vocabulary (systems using it keep it)`
      : `removed model "${t.name}" (${t.assetType}) from the vocabulary`,
  });
  revalidatePath("/settings");
  revalidatePath("/checkout");
  rev();
}

// ---------------- Settings ----------------

export async function updateSettings(data: { clientAccessEnabled: boolean; clientCanEdit: boolean }) {
  const u = await requireOwner();
  const clientCanEdit = data.clientAccessEnabled ? data.clientCanEdit : false;
  await db.insert(appSettings)
    .values({ id: 1, clientAccessEnabled: data.clientAccessEnabled, clientCanEdit })
    .onConflictDoUpdate({ target: appSettings.id, set: { clientAccessEnabled: data.clientAccessEnabled, clientCanEdit } });
  await audit({
    actor: u.email, entityType: "settings", entityId: 1,
    action: `client access: view ${data.clientAccessEnabled ? "on" : "off"}, edit ${clientCanEdit ? "on" : "off"}`,
  });
  revalidatePath("/settings");
}
