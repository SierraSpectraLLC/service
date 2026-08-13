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
