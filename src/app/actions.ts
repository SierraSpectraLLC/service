"use server";

import { revalidatePath } from "next/cache";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import {
  instruments, tasks, checklistItems, itemNotes, taskNotes, parts, attachments,
  sheetDiffs, appSettings,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireEditor, requireStaff, requireOwner } from "@/lib/authz";
import { STAGES } from "@/lib/stages";

const rev = (id?: number) => {
  revalidatePath("/");
  if (id) revalidatePath(`/instruments/${id}`);
};

// ---------------- Instruments ----------------

export async function toggleStage(instrumentId: number, stage: string) {
  const u = await requireEditor();
  if (!(STAGES as readonly string[]).includes(stage)) throw new Error("Unknown stage");
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) throw new Error("Not found");
  const has = inst.stages.includes(stage);
  if (has && inst.stages.length === 1) return; // keep at least one stage
  const next = has ? inst.stages.filter((s) => s !== stage) : [...inst.stages, stage];
  await db.update(instruments).set({ stages: next, updatedAt: new Date() }).where(eq(instruments.id, instrumentId));
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

export async function updateInstrument(instrumentId: number, data: { client: string; model: string; priority: number }) {
  const u = await requireStaff();
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) throw new Error("Not found");
  const client = data.client.trim();
  const model = data.model.trim();
  if (!model) throw new Error("Model required");
  const priority = data.priority || inst.priority;
  const changed: [string, string, string][] = [];
  if (client !== inst.client) changed.push(["client", inst.client, client]);
  if (model !== inst.model) changed.push(["model", inst.model, model]);
  if (priority !== inst.priority) changed.push(["priority", String(inst.priority), String(priority)]);
  if (!changed.length) return;
  await db.update(instruments).set({ client, model, priority, updatedAt: new Date() }).where(eq(instruments.id, instrumentId));
  for (const [field, oldValue, newValue] of changed) {
    await audit({
      actor: u.email, instrumentId, entityType: "instrument", entityId: inst.externalId,
      action: `updated ${field}`, field, oldValue, newValue,
    });
  }
  rev(instrumentId);
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

export async function createInstrument(data: { externalId: string; client: string; model: string; priority: number }) {
  const u = await requireStaff();
  const [row] = await db.insert(instruments).values({
    externalId: data.externalId.trim(), client: data.client.trim(), model: data.model.trim(),
    priority: data.priority || 99, stages: ["Intake"],
  }).returning();
  await audit({
    actor: u.email, instrumentId: row.id, entityType: "instrument", entityId: row.externalId,
    action: `created instrument ${row.externalId}: ${row.model}`,
  });
  rev(row.id);
  return row.id;
}

// ---------------- Tasks ----------------

export async function createTask(instrumentId: number, data: { title: string; body: string; assignee: string }) {
  const u = await requireEditor();
  if (!data.title.trim()) throw new Error("Title required");
  const [t] = await db.insert(tasks).values({
    instrumentId, title: data.title.trim(), body: data.body.trim(), assignee: data.assignee.trim(),
  }).returning();
  await audit({
    actor: u.email, instrumentId, entityType: "task", entityId: t.id,
    action: `created task '${t.title}'${t.assignee ? ` (assigned ${t.assignee})` : ""}`,
  });
  rev(instrumentId);
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

// ---------------- Parts ----------------

type PartInput = {
  name: string; partNumber: string; vendor: string; po: string; cost: string;
  carrier: string; tracking: string; orderedAt: string; eta: string; status: string;
};

export async function createPart(instrumentId: number, data: PartInput) {
  const u = await requireEditor();
  if (!data.name.trim()) throw new Error("Name required");
  const [p] = await db.insert(parts).values({ ...data, name: data.name.trim(), instrumentId }).returning();
  await audit({
    actor: u.email, instrumentId, entityType: "part", entityId: p.id,
    action: `added part '${p.name}'${p.partNumber ? ` (PN ${p.partNumber})` : ""} - ${p.status}`,
  });
  rev(instrumentId);
}

export async function updatePart(partId: number, data: PartInput) {
  const u = await requireEditor();
  const [before] = await db.select().from(parts).where(eq(parts.id, partId));
  if (!before) return;
  await db.update(parts).set({ ...data, name: data.name.trim() }).where(eq(parts.id, partId));
  const action = before.status !== data.status
    ? `part '${data.name}' status: ${before.status} -> ${data.status}`
    : `edited part '${data.name}'`;
  await audit({
    actor: u.email, instrumentId: before.instrumentId, entityType: "part", entityId: partId,
    action, field: before.status !== data.status ? "status" : "", oldValue: before.status, newValue: data.status,
  });
  rev(before.instrumentId);
}

export async function setPartStatus(partId: number, status: string) {
  const u = await requireEditor();
  const [p] = await db.select().from(parts).where(eq(parts.id, partId));
  if (!p || p.status === status) return;
  const receivedAt = status === "Received" ? new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }) : p.receivedAt;
  await db.update(parts).set({ status, receivedAt }).where(eq(parts.id, partId));
  await audit({
    actor: u.email, instrumentId: p.instrumentId, entityType: "part", entityId: partId,
    action: `part '${p.name}' status: ${p.status} -> ${status}`, field: "status", oldValue: p.status, newValue: status,
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
    action: `removed part '${p.name}'`,
  });
  rev(p.instrumentId);
}

// ---------------- Attachments ----------------

export async function recordAttachment(instrumentId: number, data: { fileName: string; kind: string; url: string; size: number }) {
  const u = await requireEditor();
  const [a] = await db.insert(attachments).values({ ...data, instrumentId, uploadedBy: u.name }).returning();
  await audit({
    actor: u.email, instrumentId, entityType: "attachment", entityId: a.id,
    action: `attached ${data.kind.toLowerCase()}: ${data.fileName}`,
  });
  rev(instrumentId);
}

export async function deleteAttachment(attachmentId: number) {
  const u = await requireStaff();
  const [a] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  if (!a) return;
  await db.delete(attachments).where(eq(attachments.id, attachmentId));
  await audit({
    actor: u.email, instrumentId: a.instrumentId, entityType: "attachment", entityId: attachmentId,
    action: `removed attachment: ${a.fileName}`,
  });
  rev(a.instrumentId);
}

// ---------------- Sheet diffs ----------------

export async function resolveDiff(diffId: number, resolution: "kept_ours" | "accepted_sheet") {
  const u = await requireStaff();
  const [d] = await db.select().from(sheetDiffs).where(eq(sheetDiffs.id, diffId));
  if (!d || d.resolved) return;
  await db.update(sheetDiffs).set({ resolved: true, resolvedBy: u.email, resolution }).where(eq(sheetDiffs.id, diffId));
  // Accepting the sheet's value applies it for the fields we can apply mechanically.
  if (resolution === "accepted_sheet") {
    const [inst] = await db.select().from(instruments).where(eq(instruments.externalId, d.externalId));
    if (inst) {
      if (d.field === "Notes") await db.update(instruments).set({ notes: d.sheetValue, updatedAt: new Date() }).where(eq(instruments.id, inst.id));
      if (d.field === "Priority") await db.update(instruments).set({ priority: parseInt(d.sheetValue) || inst.priority, updatedAt: new Date() }).where(eq(instruments.id, inst.id));
      // Stage diffs are resolved by hand in the UI; too lossy to auto-apply.
    }
  }
  await audit({
    actor: u.email, entityType: "sheet_diff", entityId: diffId,
    action: `resolved sheet diff on ${d.externalId} ${d.field} (${resolution === "kept_ours" ? "kept ours" : "accepted sheet"})`,
  });
  revalidatePath("/parity");
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
