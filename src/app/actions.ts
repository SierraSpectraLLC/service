"use server";

import { revalidatePath } from "next/cache";
import { eq, and, asc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { redirect } from "next/navigation";
import {
  instruments, instrumentGases, tasks, checklistItems, itemNotes, taskNotes, parts, attachments,
  sheetDiffs, appSettings, eodUpdates, clientAllowlist, users, sessions, stageDefs,
  taskTemplates, templateTasks, templateItems, stageEvents, discussionPosts, people, assets, assetEvents, discussionReads,
  checkoutRules,
} from "@/db/schema";
import { matchesEntry, roleForEmail, emailInClientAllowlist } from "@/auth";
import { getStageDefs } from "@/lib/stageDefs";
import { notifyTaskAssigned, notifyGasEmpty, notifyDiscussion, notifySystemAssigned } from "@/lib/notify";
import { audit } from "@/lib/audit";
import { requireUser, requireEditor, requireStaff, requireOwner } from "@/lib/authz";
import { pushValueToSheet, fetchTrackerRows, appendInstrumentToSheet } from "@/lib/sheetSync";
import { GASES, GAS_STATES, ATTACH_KINDS, MODULE_KINDS, ASSET_STATES, autoFg } from "@/lib/stages";
import { shopToday, shopTodayMDY, shopMonthDay } from "@/lib/shopday";
import { composeEodEmail } from "@/lib/eodEmail";
import { parseSpecs, serializeSpecs } from "@/lib/partSpecs";
import { matchRules } from "@/lib/checkout";
import { sendEmail } from "@/lib/email";

const rev = (id?: number) => {
  revalidatePath("/");
  if (id) revalidatePath(`/instruments/${id}`);
};

// ---------------- Instruments ----------------

export async function toggleStage(instrumentId: number, stage: string) {
  const u = await requireEditor();
  const defs = await getStageDefs();
  if (!defs.some((s) => s.name === stage)) throw new Error("Unknown stage");
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) throw new Error("Not found");
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
  await db.update(instruments).set({ notes, updatedAt: new Date() }).where(eq(instruments.id, instrumentId));
  await audit({
    actor: u.email, instrumentId, entityType: "instrument", entityId: inst.externalId,
    action: "updated notes", field: "notes", oldValue: inst.notes, newValue: notes,
  });
  rev(instrumentId);
}

export async function updateInstrument(
  instrumentId: number,
  data: { externalId?: string; client: string; model: string; priority: number;
          manufacturer?: string; serial?: string; location?: string },
): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { error: "Not found" };
  const client = data.client.trim();
  const model = data.model.trim();
  if (!model) return { error: "Model required" };
  const externalId = (data.externalId ?? inst.externalId).trim();
  if (!externalId) return { error: "System ID required" };
  if (externalId.length > 40) return { error: "System ID must be 40 characters or fewer" };
  if (externalId !== inst.externalId) {
    // The column is unique; check first so the user gets a real message.
    const clash = await db.select().from(instruments).where(eq(instruments.externalId, externalId));
    if (clash.length) return { error: `${externalId} is already used by another system` };
  }
  const priority = data.priority || inst.priority;
  const manufacturer = (data.manufacturer ?? inst.manufacturer).trim();
  const serial = (data.serial ?? inst.serial).trim();
  const location = (data.location ?? inst.location).trim();
  const changed: [string, string, string][] = [];
  if (externalId !== inst.externalId) changed.push(["externalId", inst.externalId, externalId]);
  if (manufacturer !== inst.manufacturer) changed.push(["manufacturer", inst.manufacturer, manufacturer]);
  if (serial !== inst.serial) changed.push(["serial", inst.serial, serial]);
  if (location !== inst.location) changed.push(["location", inst.location, location]);
  if (client !== inst.client) changed.push(["client", inst.client, client]);
  if (model !== inst.model) changed.push(["model", inst.model, model]);
  if (priority !== inst.priority) changed.push(["priority", String(inst.priority), String(priority)]);
  if (!changed.length) return {};
  await db.update(instruments).set({ externalId, client, model, priority, manufacturer, serial, location, updatedAt: new Date() }).where(eq(instruments.id, instrumentId));
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

/** Freeform note straight into the activity log - for things that aren't a task or a part order. */
export async function addInstrumentNote(instrumentId: number, text: string) {
  const u = await requireEditor();
  const t = text.trim();
  if (!t) throw new Error("Note text required");
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) throw new Error("Not found");
  await audit({
    actor: u.email, instrumentId, entityType: "instrument", entityId: inst.externalId,
    action: "posted note", field: "note", newValue: t,
  });
  rev(instrumentId);
}

/** Retire a system from the active fleet (or bring it back). The editor-safe alternative to deleting. */
export async function setInstrumentArchived(instrumentId: number, archived: boolean) {
  const u = await requireEditor();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst || inst.archived === archived) return;
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
  try {
    await appendInstrumentToSheet({
      externalId: inst.externalId, client: inst.client, model: inst.model,
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
  await db.update(instruments).set({ lead: name, updatedAt: new Date() }).where(eq(instruments.id, instrumentId));
  await audit({
    actor: u.email, instrumentId, entityType: "instrument", entityId: inst.externalId,
    action: name ? `assigned ${inst.externalId} to ${name}` : `cleared lead on ${inst.externalId}`,
    field: "lead", oldValue: inst.lead, newValue: name,
  });
  if (name) {
    await notifySystemAssigned({
      actorEmail: u.email, actorName: u.name, lead: name,
      instrumentId, externalId: inst.externalId, model: inst.model,
    });
  }
  rev(instrumentId);
}

export async function createInstrument(
  data: { externalId: string; client: string; model: string; priority: number; lead?: string },
  templateId?: number,
) {
  // Editors, not just staff: LabZen adds their internal systems themselves.
  const u = await requireEditor();
  let lead = (data.lead ?? "").trim();
  if (lead) {
    const roster = await db.select().from(people);
    if (!roster.some((p) => p.name === lead)) lead = "";
  }
  const [row] = await db.insert(instruments).values({
    externalId: data.externalId.trim(), client: data.client.trim(), model: data.model.trim(),
    priority: data.priority || 99, lead, stages: ["Intake"],
  }).returning();
  await db.insert(stageEvents).values({ instrumentId: row.id, stage: "Intake", kind: "added" });
  await audit({
    actor: u.email, instrumentId: row.id, entityType: "instrument", entityId: row.externalId,
    action: `created instrument ${row.externalId}: ${row.model}${lead ? ` (lead ${lead})` : ""}`,
  });
  if (lead) {
    await notifySystemAssigned({
      actorEmail: u.email, actorName: u.name, lead,
      instrumentId: row.id, externalId: row.externalId, model: row.model,
    });
  }
  if (templateId) await copyTemplateOnto(row.id, row.externalId, templateId, u.email);
  await generateCheckout(row.id, { id: null, kind: "Full system", model: row.model, serial: "" }, u.email);
  rev(row.id);
  return row.id;
}

export async function deleteInstrument(instrumentId: number) {
  const u = await requireOwner();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return;
  const files = await db.select({ url: attachments.url }).from(attachments).where(eq(attachments.instrumentId, instrumentId));
  await db.delete(instruments).where(eq(instruments.id, instrumentId)); // tasks, parts, gases, attachments cascade
  await deleteBlobs(files.map((f) => f.url)); // cascade covers rows; blobs need explicit removal
  await audit({
    actor: u.email, instrumentId, entityType: "instrument", entityId: inst.externalId,
    action: `deleted instrument ${inst.externalId}: ${inst.model} (${inst.client})`,
  });
  rev(instrumentId);
  redirect("/");
}

// ---------------- Assets ----------------
// First-class units systems are built from. Work is recorded on the system
// and tagged with the asset; lifecycle rows here give the dossier its spine.

type AssetInput = { kind: string; model: string; serial: string; manufacturer: string; location: string; note: string };

const cleanAsset = (d: AssetInput) => ({
  kind: (MODULE_KINDS as readonly string[]).includes(d.kind) ? d.kind : "Other",
  model: d.model.trim(),
  serial: d.serial.trim(),
  manufacturer: d.manufacturer.trim(),
  location: d.location.trim(),
  note: d.note.trim(),
});

const assetLabel = (a: { kind: string; model: string; serial: string }) =>
  `${a.kind.toLowerCase()} ${a.model || "(no model)"}${a.serial ? ` SN ${a.serial}` : ""}`;

async function logAssetEvent(assetId: number, kind: string, instrumentId: number | null, detail: string, actor: string) {
  await db.insert(assetEvents).values({ assetId, kind, instrumentId, detail, actor });
}

/**
 * Auto-create checkout tests when an asset lands on a system (or, with a
 * "Full system" target, when a system is created). Skips any test that is
 * already open for the same asset on that system, so re-attach churn is safe.
 */
async function generateCheckout(
  instrumentId: number,
  target: { id: number | null; kind: string; model: string; serial: string },
  actorEmail: string,
) {
  const rules = await db.select().from(checkoutRules).where(eq(checkoutRules.kind, target.kind));
  const picked = matchRules(rules, target.kind, target.model);
  if (!picked.length) return;
  const existing = await db.select().from(tasks).where(eq(tasks.instrumentId, instrumentId));
  const openTitles = new Set(
    existing.filter((t) => t.state !== "Done" && t.assetId === target.id).map((t) => t.title.toLowerCase())
  );
  const fresh = picked.filter((r) => !openTitles.has(r.title.toLowerCase()));
  if (!fresh.length) return;
  for (const r of fresh) {
    await db.insert(tasks).values({
      instrumentId, title: r.title, body: r.criteria, origin: "checkout",
      assetId: target.id, sortOrder: r.sortOrder,
    });
  }
  const label = target.id !== null ? assetLabel(target as { kind: string; model: string; serial: string }) : "the system";
  await audit({
    actor: actorEmail, instrumentId, entityType: "task", entityId: target.id ?? instrumentId,
    action: `generated ${fresh.length} checkout test${fresh.length === 1 ? "" : "s"} for ${label}`,
  });
}

export async function createAsset(instrumentId: number | null, data: AssetInput): Promise<{ error?: string; id?: number }> {
  const u = await requireEditor();
  const a = cleanAsset(data);
  if (!a.model && !a.serial) return { error: "Give the asset a model or a serial number" };
  let externalId = "";
  if (instrumentId !== null) {
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
    if (!inst) return { error: "Not found" };
    externalId = inst.externalId;
  }
  const siblings = instrumentId !== null
    ? await db.select().from(assets).where(eq(assets.instrumentId, instrumentId)) : [];
  const sortOrder = Math.max(0, ...siblings.map((x) => x.sortOrder)) + 1;
  const [row] = await db.insert(assets).values({
    ...a, instrumentId, sortOrder, status: instrumentId !== null ? "In service" : "Spare",
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
    await logAssetEvent(row.id, "note", null, "created as spare", u.name);
    await audit({ actor: u.email, entityType: "asset", entityId: row.id, action: `added spare ${assetLabel(row)}` });
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

/** Attach a spare to a system. */
export async function attachAsset(assetId: number, instrumentId: number): Promise<{ error?: string }> {
  const u = await requireEditor();
  const [a] = await db.select().from(assets).where(eq(assets.id, assetId));
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!a || !inst) return { error: "Not found" };
  if (a.instrumentId !== null) return { error: "Already attached to a system - use Move instead" };
  if (a.status === "Decommissioned") return { error: "This asset is decommissioned" };
  await db.update(assets).set({ instrumentId, status: "In service" }).where(eq(assets.id, assetId));
  await logAssetEvent(assetId, "installed", instrumentId, `into ${inst.externalId}`, u.name);
  await audit({
    actor: u.email, instrumentId, entityType: "asset", entityId: assetId,
    action: `installed ${assetLabel(a)}${a.location ? ` (from ${a.location})` : ""}`,
  });
  await generateCheckout(instrumentId, a, u.email);
  rev(instrumentId);
  revalidatePath("/assets");
  revalidatePath(`/assets/${assetId}`);
  return {};
}

/** Take an asset off its system; it becomes a spare. */
export async function detachAsset(assetId: number) {
  const u = await requireEditor();
  const [a] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!a || a.instrumentId === null) return;
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
export async function removeAsset(assetId: number) {
  const u = await requireStaff();
  const [a] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!a) return;
  await db.delete(assets).where(eq(assets.id, assetId)); // events cascade; tags null out
  await audit({
    actor: u.email, instrumentId: a.instrumentId ?? undefined, entityType: "asset", entityId: assetId,
    action: `deleted asset record ${assetLabel(a)}`,
  });
  if (a.instrumentId !== null) rev(a.instrumentId);
  revalidatePath("/assets");
}

// ---------------- Gases ----------------

export async function addInstrumentGas(instrumentId: number, gas: string) {
  const u = await requireEditor();
  if (!(GASES as readonly string[]).includes(gas)) throw new Error("Unknown gas");
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) throw new Error("Not found");
  const existing = await db.select().from(instrumentGases)
    .where(and(eq(instrumentGases.instrumentId, instrumentId), eq(instrumentGases.gas, gas)));
  if (existing.length) return;
  await db.insert(instrumentGases).values({ instrumentId, gas });
  await audit({
    actor: u.email, instrumentId, entityType: "gas", entityId: inst.externalId,
    action: `added gas requirement: ${gas}`, field: "gas", newValue: gas,
  });
  rev(instrumentId);
}

export async function setGasStatus(gasId: number, status: string) {
  const u = await requireEditor();
  if (!(GAS_STATES as readonly string[]).includes(status)) throw new Error("Unknown gas status");
  const [g] = await db.select().from(instrumentGases).where(eq(instrumentGases.id, gasId));
  if (!g) throw new Error("Not found");
  if (g.status === status) return;
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, g.instrumentId));
  await db.update(instrumentGases).set({ status, updatedAt: new Date() }).where(eq(instrumentGases.id, gasId));
  await audit({
    actor: u.email, instrumentId: g.instrumentId, entityType: "gas", entityId: inst?.externalId ?? "",
    action: `${g.gas}: ${g.status} -> ${status}`, field: "status", oldValue: g.status, newValue: status,
  });
  if (status === "Empty") {
    await notifyGasEmpty({
      actorEmail: u.email, actorName: u.name, gas: g.gas,
      instrumentId: g.instrumentId, externalId: inst?.externalId ?? "",
    });
  }
  rev(g.instrumentId);
}

export async function updateGasNote(gasId: number, note: string) {
  const u = await requireEditor();
  const [g] = await db.select().from(instrumentGases).where(eq(instrumentGases.id, gasId));
  if (!g) throw new Error("Not found");
  const t = note.trim();
  if (g.note === t) return;
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, g.instrumentId));
  await db.update(instrumentGases).set({ note: t, updatedAt: new Date() }).where(eq(instrumentGases.id, gasId));
  await audit({
    actor: u.email, instrumentId: g.instrumentId, entityType: "gas", entityId: inst?.externalId ?? "",
    action: `updated ${g.gas} note`, field: "note", oldValue: g.note, newValue: t,
  });
  rev(g.instrumentId);
}

export async function removeInstrumentGas(gasId: number) {
  const u = await requireStaff();
  const [g] = await db.select().from(instrumentGases).where(eq(instrumentGases.id, gasId));
  if (!g) throw new Error("Not found");
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, g.instrumentId));
  await db.delete(instrumentGases).where(eq(instrumentGases.id, gasId));
  await audit({
    actor: u.email, instrumentId: g.instrumentId, entityType: "gas", entityId: inst?.externalId ?? "",
    action: `removed gas requirement: ${g.gas}`, field: "gas", oldValue: g.gas,
  });
  rev(g.instrumentId);
}

/** An asset tag is only valid if the asset is currently attached to that system. */
async function validAssetTag(assetId: number | null | undefined, instrumentId: number) {
  if (!assetId) return null;
  const [a] = await db.select().from(assets).where(eq(assets.id, assetId));
  return a && a.instrumentId === instrumentId ? a : null;
}

// ---------------- Tasks ----------------

export async function createTask(instrumentId: number, data: { title: string; body: string; assignee: string; dueDate?: string; assetId?: number | null }) {
  const u = await requireEditor();
  if (!data.title.trim()) throw new Error("Title required");
  const tagged = await validAssetTag(data.assetId, instrumentId);
  const [t] = await db.insert(tasks).values({
    instrumentId, title: data.title.trim(), body: data.body.trim(), assignee: data.assignee.trim(),
    dueDate: (data.dueDate ?? "").trim(), assetId: tagged?.id ?? null,
  }).returning();
  await audit({
    actor: u.email, instrumentId, entityType: "task", entityId: t.id,
    action: `created task '${t.title}'${tagged ? ` [${assetLabel(tagged)}]` : ""}${t.assignee ? ` (assigned ${t.assignee})` : ""}${t.dueDate ? ` due ${t.dueDate}` : ""}`,
  });
  if (t.assignee) {
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
    await notifyTaskAssigned({
      actorEmail: u.email, actorName: u.name, assignee: t.assignee,
      taskTitle: t.title, instrumentId, externalId: inst?.externalId ?? "",
    });
  }
  rev(instrumentId);
}

export async function setTaskAsset(taskId: number, assetId: number | null) {
  const u = await requireEditor();
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t) return;
  const tagged = await validAssetTag(assetId, t.instrumentId);
  const next = tagged?.id ?? null;
  if (t.assetId === next) return;
  await db.update(tasks).set({ assetId: next }).where(eq(tasks.id, taskId));
  await audit({
    actor: u.email, instrumentId: t.instrumentId, entityType: "task", entityId: taskId,
    action: tagged ? `tagged '${t.title}' to ${assetLabel(tagged)}` : `untagged '${t.title}' (whole system)`,
  });
  rev(t.instrumentId);
}

export async function setTaskDue(taskId: number, dueDate: string) {
  const u = await requireEditor();
  const due = dueDate.trim();
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return;
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t || t.dueDate === due) return;
  await db.update(tasks).set({ dueDate: due }).where(eq(tasks.id, taskId));
  await audit({
    actor: u.email, instrumentId: t.instrumentId, entityType: "task", entityId: taskId,
    action: due ? `set '${t.title}' due ${due}` : `cleared the due date on '${t.title}'`,
    field: "dueDate", oldValue: t.dueDate, newValue: due,
  });
  rev(t.instrumentId);
}

export async function updateTask(taskId: number, data: { title: string; body: string }) {
  const u = await requireEditor();
  const title = data.title.trim();
  if (!title) throw new Error("Title required");
  const body = data.body.trim();
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t || (t.title === title && t.body === body)) return;
  await db.update(tasks).set({ title, body }).where(eq(tasks.id, taskId));
  if (t.title !== title) {
    await audit({
      actor: u.email, instrumentId: t.instrumentId, entityType: "task", entityId: taskId,
      action: `renamed task '${t.title}' to '${title}'`, field: "title", oldValue: t.title, newValue: title,
    });
  }
  if (t.body !== body) {
    await audit({
      actor: u.email, instrumentId: t.instrumentId, entityType: "task", entityId: taskId,
      action: `edited task '${title}' description`, field: "body", oldValue: t.body, newValue: body,
    });
  }
  rev(t.instrumentId);
}

export async function deleteTask(taskId: number) {
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t) { await requireStaff(); return; }
  // Checkout tests are auto-generated, so any editor may clear ones that
  // don't apply; hand-written tasks stay staff-only to delete.
  const u = t.origin === "checkout" ? await requireEditor() : await requireStaff();
  await db.delete(tasks).where(eq(tasks.id, taskId)); // checklist + notes cascade
  await audit({
    actor: u.email, instrumentId: t.instrumentId, entityType: "task", entityId: taskId,
    action: `deleted task '${t.title}'${t.state !== "Done" ? ` (was ${t.state})` : ""}`,
  });
  rev(t.instrumentId);
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
  await db.update(tasks).set({ state, completedAt: state === "Done" ? new Date() : null }).where(eq(tasks.id, taskId));
  await audit({
    actor: u.email, instrumentId: t.instrumentId, entityType: "task", entityId: taskId,
    action: `set task '${t.title}' to ${state}${suffix}`, field: "state", oldValue: t.state, newValue: state,
  });
  rev(t.instrumentId);
}

export async function assignTask(taskId: number, assignee: string) {
  const u = await requireEditor();
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t) return;
  await db.update(tasks).set({ assignee }).where(eq(tasks.id, taskId));
  await audit({
    actor: u.email, instrumentId: t.instrumentId, entityType: "task", entityId: taskId,
    action: `assigned '${t.title}' to ${assignee || "nobody"}`, field: "assignee", oldValue: t.assignee, newValue: assignee,
  });
  if (assignee && assignee !== t.assignee) {
    const [inst] = await db.select().from(instruments).where(eq(instruments.id, t.instrumentId));
    await notifyTaskAssigned({
      actorEmail: u.email, actorName: u.name, assignee,
      taskTitle: t.title, instrumentId: t.instrumentId, externalId: inst?.externalId ?? "",
    });
  }
  rev(t.instrumentId);
}

export async function addChecklistItem(taskId: number, text: string) {
  const u = await requireEditor();
  if (!text.trim()) return;
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t) return;
  await db.insert(checklistItems).values({ taskId, text: text.trim() });
  await audit({
    actor: u.email, instrumentId: t.instrumentId, entityType: "checklist_item", entityId: taskId,
    action: `added checklist item '${text.trim()}' to '${t.title}'`,
  });
  rev(t.instrumentId);
}

export async function toggleChecklistItem(itemId: number) {
  const u = await requireEditor();
  const [item] = await db.select().from(checklistItems).where(eq(checklistItems.id, itemId));
  if (!item) return;
  const [t] = await db.select().from(tasks).where(eq(tasks.id, item.taskId));
  await db.update(checklistItems).set({ done: !item.done }).where(eq(checklistItems.id, itemId));
  await audit({
    actor: u.email, instrumentId: t?.instrumentId, entityType: "checklist_item", entityId: itemId,
    action: `${item.done ? "unchecked" : "checked off"} '${item.text}'${t ? ` on '${t.title}'` : ""}`,
    field: "done", oldValue: String(item.done), newValue: String(!item.done),
  });
  if (t) rev(t.instrumentId);
}

export async function deleteChecklistItem(itemId: number) {
  const u = await requireStaff();
  const [item] = await db.select().from(checklistItems).where(eq(checklistItems.id, itemId));
  if (!item) return;
  const [t] = await db.select().from(tasks).where(eq(tasks.id, item.taskId));
  await db.delete(checklistItems).where(eq(checklistItems.id, itemId)); // item notes cascade
  await audit({
    actor: u.email, instrumentId: t?.instrumentId, entityType: "checklist_item", entityId: itemId,
    action: `removed checklist item '${item.text}'${t ? ` from '${t.title}'` : ""}`,
  });
  if (t) rev(t.instrumentId);
}

export async function addItemNote(itemId: number, text: string) {
  const u = await requireEditor();
  if (!text.trim()) return;
  const [item] = await db.select().from(checklistItems).where(eq(checklistItems.id, itemId));
  if (!item) return;
  const [t] = await db.select().from(tasks).where(eq(tasks.id, item.taskId));
  await db.insert(itemNotes).values({ itemId, author: u.name, text: text.trim() });
  await audit({
    actor: u.email, instrumentId: t?.instrumentId, entityType: "item_note", entityId: itemId,
    action: `noted on '${item.text}': "${text.trim()}"`,
  });
  if (t) rev(t.instrumentId);
}

export async function addTaskNote(taskId: number, text: string) {
  const u = await requireEditor();
  if (!text.trim()) return;
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t) return;
  await db.insert(taskNotes).values({ taskId, author: u.name, text: text.trim() });
  await audit({
    actor: u.email, instrumentId: t.instrumentId, entityType: "task_note", entityId: taskId,
    action: `commented on '${t.title}': "${text.trim()}"`,
  });
  rev(t.instrumentId);
}

export async function updateTaskNote(noteId: number, text: string) {
  const u = await requireEditor();
  const t = text.trim();
  if (!t) throw new Error("Note text required");
  const [n] = await db.select().from(taskNotes).where(eq(taskNotes.id, noteId));
  if (!n || n.text === t) return;
  const [task] = await db.select().from(tasks).where(eq(tasks.id, n.taskId));
  await db.update(taskNotes).set({ text: t }).where(eq(taskNotes.id, noteId));
  await audit({
    actor: u.email, instrumentId: task?.instrumentId, entityType: "task_note", entityId: noteId,
    action: `edited a note on '${task?.title ?? "?"}'`, field: "text", oldValue: n.text, newValue: t,
  });
  if (task) rev(task.instrumentId);
}

export async function deleteTaskNote(noteId: number) {
  const u = await requireEditor();
  const [n] = await db.select().from(taskNotes).where(eq(taskNotes.id, noteId));
  if (!n) return;
  const [task] = await db.select().from(tasks).where(eq(tasks.id, n.taskId));
  await db.delete(taskNotes).where(eq(taskNotes.id, noteId));
  await audit({
    actor: u.email, instrumentId: task?.instrumentId, entityType: "task_note", entityId: noteId,
    action: `deleted a note by ${n.author} on '${task?.title ?? "?"}'`, field: "text", oldValue: n.text,
  });
  if (task) rev(task.instrumentId);
}

export async function updateItemNote(noteId: number, text: string) {
  const u = await requireEditor();
  const t = text.trim();
  if (!t) throw new Error("Note text required");
  const [n] = await db.select().from(itemNotes).where(eq(itemNotes.id, noteId));
  if (!n || n.text === t) return;
  const [item] = await db.select().from(checklistItems).where(eq(checklistItems.id, n.itemId));
  const [task] = item ? await db.select().from(tasks).where(eq(tasks.id, item.taskId)) : [];
  await db.update(itemNotes).set({ text: t }).where(eq(itemNotes.id, noteId));
  await audit({
    actor: u.email, instrumentId: task?.instrumentId, entityType: "item_note", entityId: noteId,
    action: `edited a note on '${item?.text ?? "?"}'`, field: "text", oldValue: n.text, newValue: t,
  });
  if (task) rev(task.instrumentId);
}

export async function deleteItemNote(noteId: number) {
  const u = await requireEditor();
  const [n] = await db.select().from(itemNotes).where(eq(itemNotes.id, noteId));
  if (!n) return;
  const [item] = await db.select().from(checklistItems).where(eq(checklistItems.id, n.itemId));
  const [task] = item ? await db.select().from(tasks).where(eq(tasks.id, item.taskId)) : [];
  await db.delete(itemNotes).where(eq(itemNotes.id, noteId));
  await audit({
    actor: u.email, instrumentId: task?.instrumentId, entityType: "item_note", entityId: noteId,
    action: `deleted a note by ${n.author} on '${item?.text ?? "?"}'`, field: "text", oldValue: n.text,
  });
  if (task) rev(task.instrumentId);
}

// ---------------- Parts ----------------

type PartInput = {
  kind: string; assetId?: number | null; name: string; partNumber: string; serial: string; qty: string; specs: string;
  vendor: string; po: string; cost: string;
  carrier: string; tracking: string; orderedAt: string; eta: string; status: string; note: string;
};

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

export async function createPart(instrumentId: number, raw: PartInput) {
  const u = await requireEditor();
  const data = cleanPartInput(raw);
  if (!data.name.trim()) throw new Error("Name required");
  const stamps = partStamps({ status: "", receivedAt: "", installedAt: "", removedAt: "" }, data.status);
  const taggedAsset = await validAssetTag(data.assetId, instrumentId);
  const [p] = await db.insert(parts).values({ ...data, ...stamps, assetId: taggedAsset?.id ?? null, name: data.name.trim(), note: data.note.trim(), instrumentId }).returning();
  const verb = partStatusVerb(p.status);
  const noun = p.kind === "consumable" ? "consumable" : "part";
  const pn = p.partNumber ? ` (PN ${p.partNumber})` : "";
  const qty = p.qty ? ` x${p.qty}` : "";
  const note = p.note ? ` - ${p.note}` : "";
  await audit({
    actor: u.email, instrumentId, entityType: "part", entityId: p.id,
    action: (verb
      ? `${verb} ${noun} '${p.name}'${qty}${pn}`
      : `added ${noun} '${p.name}'${qty}${pn} - ${p.status}`) + (taggedAsset ? ` [${assetLabel(taggedAsset)}]` : "") + note,
  });
  rev(instrumentId);
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
  await db.update(parts).set({ ...data, ...stamps, assetId, name: data.name.trim(), note: data.note.trim() }).where(eq(parts.id, partId));
  const verb = partStatusVerb(data.status);
  const action = before.status !== data.status
    ? verb
      ? `${verb} part '${data.name}'${data.note.trim() ? ` - ${data.note.trim()}` : ""}`
      : `part '${data.name}' status: ${before.status} -> ${data.status}`
    : `edited part '${data.name}'`;
  await audit({
    actor: u.email, instrumentId: before.instrumentId, entityType: "part", entityId: partId,
    action, field: before.status !== data.status ? "status" : "", oldValue: before.status, newValue: data.status,
  });
  if (retagged) {
    await audit({
      actor: u.email, instrumentId: before.instrumentId, entityType: "part", entityId: partId,
      action: taggedAsset ? `tagged part '${data.name.trim()}' to ${assetLabel(taggedAsset)}` : `untagged part '${data.name.trim()}' (whole system)`,
    });
  }
  rev(before.instrumentId);
}

export async function setPartAsset(partId: number, assetId: number | null) {
  const u = await requireEditor();
  const [p] = await db.select().from(parts).where(eq(parts.id, partId));
  if (!p) return;
  const tagged = await validAssetTag(assetId, p.instrumentId);
  const next = tagged?.id ?? null;
  if (p.assetId === next) return;
  await db.update(parts).set({ assetId: next }).where(eq(parts.id, partId));
  await audit({
    actor: u.email, instrumentId: p.instrumentId, entityType: "part", entityId: partId,
    action: tagged ? `tagged part '${p.name}' to ${assetLabel(tagged)}` : `untagged part '${p.name}' (whole system)`,
  });
  rev(p.instrumentId);
}

export async function setPartStatus(partId: number, status: string) {
  const u = await requireEditor();
  const [p] = await db.select().from(parts).where(eq(parts.id, partId));
  if (!p || p.status === status) return;
  const stamps = partStamps(p, status);
  await db.update(parts).set({ status, ...stamps }).where(eq(parts.id, partId));
  const verb = partStatusVerb(status);
  await audit({
    actor: u.email, instrumentId: p.instrumentId, entityType: "part", entityId: partId,
    action: verb ? `${verb} part '${p.name}'` : `part '${p.name}' status: ${p.status} -> ${status}`,
    field: "status", oldValue: p.status, newValue: status,
  });
  rev(p.instrumentId);
}

export async function deletePart(partId: number) {
  const u = await requireStaff();
  const [p] = await db.select().from(parts).where(eq(parts.id, partId));
  if (!p) return;
  await db.delete(parts).where(eq(parts.id, partId));
  await audit({
    actor: u.email, instrumentId: p.instrumentId, entityType: "part", entityId: partId,
    action: `deleted part record '${p.name}'`,
  });
  rev(p.instrumentId);
}

// ---------------- Attachments ----------------

export async function recordAttachment(instrumentId: number, data: { fileName: string; kind: string; url: string; size: number; description?: string }) {
  await recordAttachments(instrumentId, [{ ...data, description: data.description ?? "" }]);
}

/** Batch variant: one insert + one audit entry per file, single revalidation. */
export async function recordAttachments(
  instrumentId: number,
  files: { fileName: string; kind: string; url: string; size: number; description: string }[]
) {
  const u = await requireEditor();
  if (!files.length) return;
  const rows = await db.insert(attachments)
    .values(files.map((f) => ({ ...f, description: f.description.trim(), instrumentId, uploadedBy: u.name })))
    .returning();
  for (const a of rows) {
    await audit({
      actor: u.email, instrumentId, entityType: "attachment", entityId: a.id,
      action: `attached ${a.kind.toLowerCase()}: ${a.fileName}${a.description ? ` - ${a.description}` : ""}`,
    });
  }
  rev(instrumentId);
}

export async function updateAttachment(attachmentId: number, data: { fileName: string; kind: string; description: string }) {
  const u = await requireEditor();
  const fileName = data.fileName.trim();
  if (!fileName) throw new Error("File name required");
  const kind = (ATTACH_KINDS as readonly string[]).includes(data.kind) ? data.kind : "Other";
  const description = data.description.trim();
  const [a] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  if (!a || (a.fileName === fileName && a.kind === kind && a.description === description)) return;
  await db.update(attachments).set({ fileName, kind, description }).where(eq(attachments.id, attachmentId));
  const changes: string[] = [];
  if (a.fileName !== fileName) changes.push(`renamed to '${fileName}'`);
  if (a.kind !== kind) changes.push(`${a.kind} -> ${kind}`);
  if (a.description !== description) changes.push("description updated");
  await audit({
    actor: u.email, instrumentId: a.instrumentId, entityType: "attachment", entityId: attachmentId,
    action: `edited attachment '${a.fileName}': ${changes.join(", ")}`,
    field: "description", oldValue: a.description, newValue: description,
  });
  rev(a.instrumentId);
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

export async function deleteAttachment(attachmentId: number) {
  const u = await requireStaff();
  const [a] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  if (!a) return;
  await db.delete(attachments).where(eq(attachments.id, attachmentId));
  await deleteBlobs([a.url]); // remove the actual file from Vercel Blob, not just our record
  await audit({
    actor: u.email, instrumentId: a.instrumentId, entityType: "attachment", entityId: attachmentId,
    action: `removed attachment: ${a.fileName} (file deleted from storage)`,
  });
  rev(a.instrumentId);
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
    externalId = inst.externalId;
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
  });
  if (instrumentId !== null) rev(instrumentId);
  revalidatePath("/discussions");
}

/** Mark a thread read for the current user (0 = the General board). */
export async function markThreadRead(threadId: number) {
  const u = await requireUser();
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
  await db.update(discussionPosts).set({ body: text }).where(eq(discussionPosts.id, postId));
  await audit({
    actor: u.email, instrumentId: p.instrumentId ?? undefined, entityType: "discussion", entityId: postId,
    action: `edited a discussion post by ${p.author}`, field: "body", oldValue: p.body, newValue: text,
  });
  if (p.instrumentId !== null) rev(p.instrumentId);
  revalidatePath("/discussions");
}

export async function deleteDiscussionPost(postId: number) {
  const u = await requireEditor();
  const [p] = await db.select().from(discussionPosts).where(eq(discussionPosts.id, postId));
  if (!p) return;
  await db.delete(discussionPosts).where(eq(discussionPosts.id, postId));
  await audit({
    actor: u.email, instrumentId: p.instrumentId ?? undefined, entityType: "discussion", entityId: postId,
    action: `deleted a discussion post by ${p.author}`, field: "body", oldValue: p.body,
  });
  if (p.instrumentId !== null) rev(p.instrumentId);
  revalidatePath("/discussions");
}

// ---------------- SOP templates ----------------
// Shop-wide SOPs, so staff (not just owner) manage them. Applying a template
// copies its tasks + checklist items onto an instrument.

export async function createTemplate(name: string): Promise<{ error?: string; id?: number }> {
  const u = await requireStaff();
  const n = name.trim();
  if (!n || n.length > 80) return { error: "Template name must be 1-80 characters" };
  const existing = await db.select().from(taskTemplates);
  if (existing.some((t) => t.name.toLowerCase() === n.toLowerCase())) return { error: `"${n}" already exists` };
  const [row] = await db.insert(taskTemplates).values({ name: n }).returning();
  await audit({ actor: u.email, entityType: "template", entityId: row.id, action: `created template "${n}"` });
  revalidatePath("/templates");
  return { id: row.id };
}

export async function renameTemplate(templateId: number, name: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const n = name.trim();
  if (!n || n.length > 80) return { error: "Template name must be 1-80 characters" };
  const [t] = await db.select().from(taskTemplates).where(eq(taskTemplates.id, templateId));
  if (!t || t.name === n) return {};
  const existing = await db.select().from(taskTemplates);
  if (existing.some((x) => x.id !== templateId && x.name.toLowerCase() === n.toLowerCase())) return { error: `"${n}" already exists` };
  await db.update(taskTemplates).set({ name: n }).where(eq(taskTemplates.id, templateId));
  await audit({
    actor: u.email, entityType: "template", entityId: templateId,
    action: `renamed template "${t.name}" to "${n}"`, field: "name", oldValue: t.name, newValue: n,
  });
  revalidatePath("/templates");
  return {};
}

export async function deleteTemplate(templateId: number) {
  const u = await requireStaff();
  const [t] = await db.select().from(taskTemplates).where(eq(taskTemplates.id, templateId));
  if (!t) return;
  await db.delete(taskTemplates).where(eq(taskTemplates.id, templateId)); // tasks + items cascade
  await audit({ actor: u.email, entityType: "template", entityId: templateId, action: `deleted template "${t.name}"` });
  revalidatePath("/templates");
}

export async function addTemplateTask(templateId: number, data: { title: string; body: string }) {
  const u = await requireStaff();
  const title = data.title.trim();
  if (!title) return;
  const [t] = await db.select().from(taskTemplates).where(eq(taskTemplates.id, templateId));
  if (!t) return;
  const siblings = await db.select().from(templateTasks).where(eq(templateTasks.templateId, templateId));
  const sortOrder = Math.max(0, ...siblings.map((x) => x.sortOrder)) + 1;
  await db.insert(templateTasks).values({ templateId, title, body: data.body.trim(), sortOrder });
  await audit({
    actor: u.email, entityType: "template", entityId: templateId,
    action: `added task "${title}" to template "${t.name}"`,
  });
  revalidatePath("/templates");
}

export async function updateTemplateTask(taskId: number, data: { title: string; body: string }) {
  const u = await requireStaff();
  const title = data.title.trim();
  if (!title) return;
  const [tt] = await db.select().from(templateTasks).where(eq(templateTasks.id, taskId));
  if (!tt || (tt.title === title && tt.body === data.body.trim())) return;
  await db.update(templateTasks).set({ title, body: data.body.trim() }).where(eq(templateTasks.id, taskId));
  await audit({
    actor: u.email, entityType: "template", entityId: tt.templateId,
    action: `edited template task "${title}"`,
  });
  revalidatePath("/templates");
}

export async function deleteTemplateTask(taskId: number) {
  const u = await requireStaff();
  const [tt] = await db.select().from(templateTasks).where(eq(templateTasks.id, taskId));
  if (!tt) return;
  await db.delete(templateTasks).where(eq(templateTasks.id, taskId)); // items cascade
  await audit({
    actor: u.email, entityType: "template", entityId: tt.templateId,
    action: `removed template task "${tt.title}"`,
  });
  revalidatePath("/templates");
}

export async function addTemplateItem(templateTaskId: number, text: string) {
  const u = await requireStaff();
  const t = text.trim();
  if (!t) return;
  const [tt] = await db.select().from(templateTasks).where(eq(templateTasks.id, templateTaskId));
  if (!tt) return;
  const siblings = await db.select().from(templateItems).where(eq(templateItems.templateTaskId, templateTaskId));
  const sortOrder = Math.max(0, ...siblings.map((x) => x.sortOrder)) + 1;
  await db.insert(templateItems).values({ templateTaskId, text: t, sortOrder });
  await audit({
    actor: u.email, entityType: "template", entityId: tt.templateId,
    action: `added checklist item "${t}" to template task "${tt.title}"`,
  });
  revalidatePath("/templates");
}

export async function deleteTemplateItem(itemId: number) {
  const u = await requireStaff();
  const [item] = await db.select().from(templateItems).where(eq(templateItems.id, itemId));
  if (!item) return;
  const [tt] = await db.select().from(templateTasks).where(eq(templateTasks.id, item.templateTaskId));
  await db.delete(templateItems).where(eq(templateItems.id, itemId));
  await audit({
    actor: u.email, entityType: "template", entityId: tt?.templateId,
    action: `removed checklist item "${item.text}" from template task "${tt?.title ?? "?"}"`,
  });
  revalidatePath("/templates");
}

/** Shared copy step for applyTemplate and createInstrument-with-template. */
async function copyTemplateOnto(instrumentId: number, externalId: string, templateId: number, actor: string) {
  const [tpl] = await db.select().from(taskTemplates).where(eq(taskTemplates.id, templateId));
  if (!tpl) throw new Error("Template not found");
  const tplTasks = await db.select().from(templateTasks).where(eq(templateTasks.templateId, templateId))
    .orderBy(asc(templateTasks.sortOrder), asc(templateTasks.id));
  const taskIds = tplTasks.map((t) => t.id);
  const tplItems = taskIds.length
    ? await db.select().from(templateItems).where(inArray(templateItems.templateTaskId, taskIds))
      .orderBy(asc(templateItems.sortOrder), asc(templateItems.id))
    : [];
  for (const tt of tplTasks) {
    const [task] = await db.insert(tasks).values({
      instrumentId, title: tt.title, body: tt.body, sortOrder: tt.sortOrder,
    }).returning();
    const items = tplItems.filter((i) => i.templateTaskId === tt.id);
    for (const item of items) {
      await db.insert(checklistItems).values({ taskId: task.id, text: item.text, sortOrder: item.sortOrder });
    }
  }
  await audit({
    actor, instrumentId, entityType: "template", entityId: externalId,
    action: `applied template "${tpl.name}": ${tplTasks.length} task${tplTasks.length === 1 ? "" : "s"}, ${tplItems.length} checklist item${tplItems.length === 1 ? "" : "s"}`,
  });
}

/** Copy a template's tasks + checklists onto an instrument. */
export async function applyTemplate(instrumentId: number, templateId: number) {
  const u = await requireEditor();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) throw new Error("Not found");
  await copyTemplateOnto(instrumentId, inst.externalId, templateId, u.email);
  rev(instrumentId);
}

// ---------------- Checkout rules ----------------
// Tests auto-created when an asset lands on a system ("Full system" rules
// fire when a system is created). A rule with a model filter replaces the
// kind's generic rules for matching models.

const CHECKOUT_KINDS: readonly string[] = [...MODULE_KINDS, "Full system"];

export async function addCheckoutRule(
  data: { kind: string; modelMatch: string; title: string; criteria: string },
): Promise<{ error?: string }> {
  const u = await requireStaff();
  if (!CHECKOUT_KINDS.includes(data.kind)) return { error: "Pick an asset type" };
  const title = data.title.trim();
  if (!title || title.length > 120) return { error: "Test name must be 1-120 characters" };
  const modelMatch = data.modelMatch.trim();
  const criteria = data.criteria.trim();
  const siblings = await db.select().from(checkoutRules).where(eq(checkoutRules.kind, data.kind));
  if (siblings.some((r) => r.title.toLowerCase() === title.toLowerCase() && r.modelMatch.toLowerCase() === modelMatch.toLowerCase()))
    return { error: `"${title}" already exists for ${data.kind}${modelMatch ? ` (${modelMatch})` : ""}` };
  const sortOrder = Math.max(0, ...siblings.map((r) => r.sortOrder)) + 1;
  const [row] = await db.insert(checkoutRules).values({ kind: data.kind, modelMatch, title, criteria, sortOrder }).returning();
  await audit({
    actor: u.email, entityType: "checkout", entityId: row.id,
    action: `added checkout test "${title}" for ${data.kind}${modelMatch ? ` (${modelMatch} models only)` : ""}`,
  });
  revalidatePath("/templates");
  return {};
}

export async function updateCheckoutRule(
  ruleId: number,
  data: { modelMatch: string; title: string; criteria: string },
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [r] = await db.select().from(checkoutRules).where(eq(checkoutRules.id, ruleId));
  if (!r) return { error: "Not found" };
  const title = data.title.trim();
  if (!title || title.length > 120) return { error: "Test name must be 1-120 characters" };
  const modelMatch = data.modelMatch.trim();
  const criteria = data.criteria.trim();
  if (r.title === title && r.modelMatch === modelMatch && r.criteria === criteria) return {};
  const siblings = await db.select().from(checkoutRules).where(eq(checkoutRules.kind, r.kind));
  if (siblings.some((x) => x.id !== ruleId && x.title.toLowerCase() === title.toLowerCase() && x.modelMatch.toLowerCase() === modelMatch.toLowerCase()))
    return { error: `"${title}" already exists for ${r.kind}${modelMatch ? ` (${modelMatch})` : ""}` };
  await db.update(checkoutRules).set({ title, modelMatch, criteria }).where(eq(checkoutRules.id, ruleId));
  await audit({
    actor: u.email, entityType: "checkout", entityId: ruleId,
    action: `edited checkout test "${title}" for ${r.kind}`,
    field: "rule", oldValue: `${r.title} | ${r.modelMatch} | ${r.criteria}`, newValue: `${title} | ${modelMatch} | ${criteria}`,
  });
  revalidatePath("/templates");
  return {};
}

export async function deleteCheckoutRule(ruleId: number) {
  const u = await requireStaff();
  const [r] = await db.select().from(checkoutRules).where(eq(checkoutRules.id, ruleId));
  if (!r) return;
  await db.delete(checkoutRules).where(eq(checkoutRules.id, ruleId));
  await audit({
    actor: u.email, entityType: "checkout", entityId: ruleId,
    action: `removed checkout test "${r.title}" for ${r.kind}${r.modelMatch ? ` (${r.modelMatch} models only)` : ""}`,
  });
  revalidatePath("/templates");
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

export async function addClientAccess(raw: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const entry = raw.trim().toLowerCase();
  if (!ALLOW_EMAIL.test(entry) && !ALLOW_DOMAIN.test(entry)) {
    // Returned, not thrown: prod masks thrown server-action messages.
    return { error: 'Enter an email like "jane@labzenllc.com" or a domain like "@labzenllc.com"' };
  }
  await db.insert(clientAllowlist).values({ entry, addedBy: u.name }).onConflictDoNothing();
  await audit({
    actor: u.email, entityType: "settings", entityId: entry,
    action: `allowed client sign-in: ${entry}`,
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
