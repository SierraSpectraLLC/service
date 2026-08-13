// What counts as a photo, and which one goes on top.
//
// Photos are not a second kind of storage: they are ordinary attachments, which
// is what keeps one file one row - counted against a quota once, served through
// the same authorized proxy, deleted in one place. This module is only the two
// questions that follow from treating them as a set rather than as one picture:
// which attachments are photographs, and which of them is the cover.
//
// Pure, because both answers are read on every system page, every unit page and
// the gallery, and three copies of "is this a photo" would drift by Friday.

/** Extensions a browser will actually render inline. HEIC is here because phones. */
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp)$/i;

export type PhotoLike = {
  id: number;
  fileName: string;
  kind: string;
  createdAt?: string | Date;
};

/**
 * Is this attachment a photograph?
 *
 * Both halves matter. The `kind` is what somebody chose in the upload form and
 * is the stronger signal, but a photo filed as "Test data" is still a photo, and
 * a file named `report.pdf` filed as "Photo" is still not one - so the extension
 * has the final say when the two disagree about whether a browser can show it.
 */
export function isPhotoFile(f: { fileName: string; kind: string }): boolean {
  return IMAGE_EXT.test(f.fileName ?? "");
}

const at = (v: string | Date | undefined) => (v ? new Date(v).getTime() : 0);

/**
 * The photos of one record, cover first, then newest to oldest.
 *
 * A cover that has been deleted falls back to the newest photo rather than to
 * nothing: the pointer is a preference, and losing it should cost the preference
 * and not the picture.
 */
export function orderPhotos<T extends PhotoLike>(photos: T[], coverId: number | null): T[] {
  const rest = [...photos].sort((a, b) => at(b.createdAt) - at(a.createdAt) || b.id - a.id);
  const cover = coverId === null ? undefined : rest.find((p) => p.id === coverId);
  return cover ? [cover, ...rest.filter((p) => p.id !== cover.id)] : rest;
}

/** The one to show on top, or null when there are none at all. */
export function coverPhoto<T extends PhotoLike>(photos: T[], coverId: number | null): T | null {
  return orderPhotos(photos, coverId)[0] ?? null;
}

/** Was this record's cover chosen, or is it just the newest by default? */
export const coverIsChosen = (photos: PhotoLike[], coverId: number | null): boolean =>
  coverId !== null && photos.some((p) => p.id === coverId);

/** "3 photos", for a heading that should not say "3 photo". */
export const photoCount = (n: number) => `${n} photo${n === 1 ? "" : "s"}`;

/**
 * The cover, but only if the file is still there.
 *
 * The pointer outlives the photo: deleting the cover leaves an id on the record
 * addressing an attachment that no longer exists, and the thumbnail at the top
 * of the page then asks for a file that answers 404 - a broken image where a
 * machine should be, and no fall back to the catalog's stand-in either, because
 * as far as the page was concerned there WAS a cover. Resolved on read rather
 * than only on delete, so a pointer left dangling by any path heals itself.
 */
export const livingCover = (photos: PhotoLike[], coverId: number | null): number | null =>
  (coverId !== null && photos.some((p) => p.id === coverId) ? coverId : null);

/**
 * One audit line for removing a set of photos, however big the set.
 *
 * A row per file turned clearing fifteen setup photos into fifteen entries in a
 * history meant to show what happened to the machine. The names are still all
 * there - the point is that removing them was one act by one person, and reads
 * as one.
 */
export function photoRemovalNote(names: string[], reason: string): string {
  const shown = names.slice(0, 8).join(", ");
  const extra = names.length > 8 ? `, and ${names.length - 8} more` : "";
  const what = names.length === 1
    ? `removed photo: ${shown}`
    : `removed ${names.length} photos: ${shown}${extra}`;
  return `${what} (files deleted from storage) - reason: ${reason}`;
}

// ---------------------------------------------------------------------------
// Where a photo comes from
// ---------------------------------------------------------------------------

/** The two doors: a stored file, or a stock photo on a catalog row. */
export const fileSrc = (attachmentId: number) => `/api/files/${attachmentId}`;
export const stockSrc = (termId: number) => `/api/catalog/photo/${termId}`;

// ---------------------------------------------------------------------------
// Stock photos from the catalog
// ---------------------------------------------------------------------------

export type CatalogPhoto = {
  id: number;
  kind: string;          // 'category' | 'asset_type' | 'model'
  assetType: string;     // models only
  name: string;
  photoFraming: string;
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * What this kind of unit looks like, when nobody has photographed THIS one.
 *
 * The catalog already knows an SPD-20A is an SPD-20A; a stock photo of one saves
 * every shop that ever files a unit from photographing the same beige box again.
 * The model wins over the module type, because "Shimadzu SPD-20A" is a better
 * answer to "which one is that" than "Detector".
 *
 * This is a FALLBACK and never evidence. It is not an attachment, it is not in
 * anybody's files or gallery, and nothing bills for it - which is exactly why it
 * has to be labelled as a catalog photo wherever it appears. A stock image
 * standing in silently for a photo of the actual unit would be a lie the record
 * tells on its own.
 */
export function stockPhotoForUnit(
  catalog: CatalogPhoto[], kind: string, model: string,
): CatalogPhoto | null {
  return (model.trim() && catalog.find(
    (c) => c.kind === "model" && same(c.name, model) && (!c.assetType || same(c.assetType, kind)),
  )) || catalog.find((c) => c.kind === "asset_type" && same(c.name, kind)) || null;
}

/** The same, for a system: what a machine of this category looks like. */
export function stockPhotoForSystem(catalog: CatalogPhoto[], category: string): CatalogPhoto | null {
  return (category.trim() && catalog.find((c) => c.kind === "category" && same(c.name, category))) || null;
}

// ---------------------------------------------------------------------------
// A one-unit system and its unit
// ---------------------------------------------------------------------------

/**
 * Are this system and this unit the same physical box?
 *
 * A unit tracked as a system of its own - which is how a single instrument on a
 * bench gets stages, a queue and a sign-off packet - ends up as two records
 * describing one machine. Photographing it twice, once on each page, is work
 * nobody should have to do, so the two share their photos.
 *
 * The test is structural rather than a flag: a system with exactly one unit IS
 * that unit, whether it was created that way or arrived there. It also unwinds
 * itself - attach a second module and the system becomes a bench, whose photo is
 * the bench and not one module of it.
 */
export const sharesPhotos = (unitsOnSystem: number) => unitsOnSystem === 1;

/**
 * The cover for a shared pair. At most one of the two pointers is ever set (see
 * setCoverPhoto), so "whichever is set" is unambiguous rather than a precedence
 * rule somebody has to remember.
 */
export const sharedCover = (own: number | null, twin: number | null) => own ?? twin;
