// The frozen copy of a system's record a service provider keeps after its
// share is revoked - their own service reports, GxP-style. Composed once at
// revocation and stored as JSON in engagement_records.data, so later edits to
// the live system can never reach it. Rendered read-only by /records/[id].
import { asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  instruments, instrumentGases, tasks, checklistItems, taskNotes, itemNotes,
  parts, attachments, auditLog, discussionPosts, assets,
} from "@/db/schema";
import { composeSystemLabel } from "@/lib/systemLabel";

export type SystemDossier = {
  version: 1;
  system: {
    externalId: string; client: string; category: string; location: string;
    lead: string; notes: string; stages: string[];
  };
  label: string;
  assets: { kind: string; model: string; serial: string; manufacturer: string; status: string; asFound: string; note: string }[];
  gases: { gas: string; status: string; note: string }[];
  tasks: {
    title: string; body: string; state: string; assignee: string; dueDate: string; origin: string;
    createdAt: string; completedAt: string | null;
    checklist: { text: string; done: boolean; notes: { author: string; text: string; createdAt: string }[] }[];
    notes: { author: string; text: string; createdAt: string }[];
  }[];
  // No cost or po fields: engagement records go to service providers, and
  // pricing is the owner's business data (lib/redact) - it must not be frozen
  // into a copy the provider keeps forever.
  parts: {
    kind: string; name: string; partNumber: string; serial: string; qty: string; specs: string;
    vendor: string; status: string; installedAt: string; removedAt: string;
    note: string; createdAt: string;
  }[];
  // Blob URLs are kept for reference but can go dead if the live file is later
  // deleted - the metadata line is the durable part of the record.
  attachments: { fileName: string; kind: string; description: string; url: string; size: number; uploadedBy: string; createdAt: string }[];
  discussion: { author: string; body: string; createdAt: string }[];
  activity: { actor: string; action: string; field: string; newValue: string; createdAt: string }[];
};

// Enough for years of a busy system's feed; a hard cap keeps the JSON bounded.
const ACTIVITY_CAP = 1000;

export async function composeSystemDossier(instrumentId: number): Promise<SystemDossier | null> {
  const [[inst], assetRows, gasRows, taskRows, partRows, attachRows, discussion, activity] = await Promise.all([
    db.select().from(instruments).where(eq(instruments.id, instrumentId)),
    db.select().from(assets).where(eq(assets.instrumentId, instrumentId)).orderBy(asc(assets.sortOrder), asc(assets.id)),
    db.select().from(instrumentGases).where(eq(instrumentGases.instrumentId, instrumentId)).orderBy(asc(instrumentGases.id)),
    db.select().from(tasks).where(eq(tasks.instrumentId, instrumentId)).orderBy(asc(tasks.sortOrder), asc(tasks.id)),
    db.select().from(parts).where(eq(parts.instrumentId, instrumentId)).orderBy(asc(parts.id)),
    db.select().from(attachments).where(eq(attachments.instrumentId, instrumentId)).orderBy(desc(attachments.createdAt)),
    db.select().from(discussionPosts).where(eq(discussionPosts.instrumentId, instrumentId)).orderBy(asc(discussionPosts.createdAt)),
    db.select().from(auditLog).where(eq(auditLog.instrumentId, instrumentId)).orderBy(desc(auditLog.createdAt)).limit(ACTIVITY_CAP),
  ]);
  if (!inst) return null;

  const taskIds = taskRows.map((t) => t.id);
  const [items, tNotes] = await Promise.all([
    taskIds.length ? db.select().from(checklistItems).where(inArray(checklistItems.taskId, taskIds)).orderBy(asc(checklistItems.sortOrder), asc(checklistItems.id)) : [],
    taskIds.length ? db.select().from(taskNotes).where(inArray(taskNotes.taskId, taskIds)).orderBy(asc(taskNotes.createdAt)) : [],
  ]);
  const itemIds = items.map((i) => i.id);
  const iNotes = itemIds.length
    ? await db.select().from(itemNotes).where(inArray(itemNotes.itemId, itemIds)).orderBy(asc(itemNotes.createdAt))
    : [];

  return {
    version: 1,
    system: {
      externalId: inst.externalId, client: inst.client, category: inst.category,
      location: inst.location, lead: inst.lead, notes: inst.notes, stages: inst.stages,
    },
    label: composeSystemLabel(assetRows, inst.model),
    assets: assetRows.map((a) => ({
      kind: a.kind, model: a.model, serial: a.serial, manufacturer: a.manufacturer,
      status: a.status, asFound: a.asFound, note: a.note,
    })),
    gases: gasRows.map((g) => ({ gas: g.gas, status: g.status, note: g.note })),
    tasks: taskRows.map((t) => ({
      title: t.title, body: t.body, state: t.state, assignee: t.assignee,
      dueDate: t.dueDate, origin: t.origin,
      createdAt: t.createdAt.toISOString(), completedAt: t.completedAt?.toISOString() ?? null,
      checklist: items.filter((c) => c.taskId === t.id).map((c) => ({
        text: c.text, done: c.done,
        notes: iNotes.filter((n) => n.itemId === c.id).map((n) => ({ author: n.author, text: n.text, createdAt: n.createdAt.toISOString() })),
      })),
      notes: tNotes.filter((n) => n.taskId === t.id).map((n) => ({ author: n.author, text: n.text, createdAt: n.createdAt.toISOString() })),
    })),
    parts: partRows.map((p) => ({
      kind: p.kind, name: p.name, partNumber: p.partNumber, serial: p.serial, qty: p.qty,
      specs: p.specs, vendor: p.vendor, status: p.status,
      installedAt: p.installedAt, removedAt: p.removedAt, note: p.note, createdAt: p.createdAt.toISOString(),
    })),
    attachments: attachRows.map((a) => ({
      fileName: a.fileName, kind: a.kind, description: a.description, url: a.url,
      size: a.size, uploadedBy: a.uploadedBy, createdAt: a.createdAt.toISOString(),
    })),
    discussion: discussion.map((p) => ({ author: p.author, body: p.body, createdAt: p.createdAt.toISOString() })),
    activity: activity.map((a) => ({
      actor: a.actor, action: a.action, field: a.field, newValue: a.newValue, createdAt: a.createdAt.toISOString(),
    })),
  };
}
