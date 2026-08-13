// A unit tracked as a system of its own, and that unit. Server-only (it asks
// the database what is attached to what); the rule itself is the pure
// sharesPhotos in lib/photos.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { assets, attachments, instruments } from "@/db/schema";
import { sharesPhotos } from "@/lib/photos";

export type PhotoRecord = { instrumentId: number | null; assetId: number | null };

/**
 * Which record a photo filed against this target actually lands on. Files follow
 * the system when a caller names both, so covers have to as well.
 */
export const photoRecord = (t: PhotoRecord): PhotoRecord =>
  t.instrumentId !== null
    ? { instrumentId: t.instrumentId, assetId: null }
    : { instrumentId: null, assetId: t.assetId };

/**
 * The other half of a one-box pair, or null.
 *
 * A single instrument on a bench is still a whole engagement, so it gets a
 * system of its own - and then it is two records describing one machine.
 * Photographing it twice, once per page, is work nobody should have to do, so
 * the pair pools its photos.
 *
 * Structural rather than a flag: a system with exactly one unit IS that unit,
 * however it got there, and attaching a second module unwinds it - a bench's
 * photo is the bench, not one module of it.
 */
export async function photoTwin(target: PhotoRecord): Promise<PhotoRecord | null> {
  const me = photoRecord(target);
  if (me.instrumentId !== null) {
    const on = await db.select({ id: assets.id }).from(assets).where(eq(assets.instrumentId, me.instrumentId));
    return sharesPhotos(on.length) ? { instrumentId: null, assetId: on[0].id } : null;
  }
  if (me.assetId === null) return null;
  const [a] = await db.select({ instrumentId: assets.instrumentId }).from(assets).where(eq(assets.id, me.assetId));
  if (!a?.instrumentId) return null;
  const on = await db.select({ id: assets.id }).from(assets).where(eq(assets.instrumentId, a.instrumentId));
  return sharesPhotos(on.length) ? { instrumentId: a.instrumentId, assetId: null } : null;
}

/** That record's cover pointer, whichever kind of record it is. */
export async function coverOf(r: PhotoRecord): Promise<number | null> {
  if (r.instrumentId !== null) {
    const [row] = await db.select({ cover: instruments.photoAttachmentId })
      .from(instruments).where(eq(instruments.id, r.instrumentId));
    return row?.cover ?? null;
  }
  if (r.assetId === null) return null;
  const [row] = await db.select({ cover: assets.photoAttachmentId })
    .from(assets).where(eq(assets.id, r.assetId));
  return row?.cover ?? null;
}

/** The attachments filed on that record, newest first. */
export async function attachmentsOf(r: PhotoRecord) {
  if (r.instrumentId !== null) {
    return db.select().from(attachments).where(eq(attachments.instrumentId, r.instrumentId));
  }
  if (r.assetId === null) return [];
  return db.select().from(attachments).where(eq(attachments.assetId, r.assetId));
}
