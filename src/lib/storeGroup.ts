// Turn the store's attachment rows into STORED FILES. Pure, so the thing that
// has to add up to the meter can be argued with in tests.
//
// The distinction is the whole point of the page. One document filed onto a
// shelf and three units is four rows and ONE stored file - it is uploaded once,
// stored once, and charged once. A list that showed four rows with four sizes
// would total four times the meter beside it, and the person reading it would
// have no way to tell which number was lying.

export type FileRow = {
  id: number;
  fileName: string;
  url: string;
  size: number;
  kind: string;
  description: string;
  uploadedBy: string;
  instrumentId: number | null;
  externalId: string | null;
  assetId: number | null;
  assetLabel: string | null;
  orgId: number | null;
};

/** Where a stored file sits. `kind` drives the link and who may remove it. */
export type Place =
  | { kind: "shelf"; attachmentId: number }
  | { kind: "system"; attachmentId: number; id: number; label: string }
  | { kind: "unit"; attachmentId: number; id: number; label: string };

export type StoredFile<R> = {
  url: string;
  /** Counted once, however many places point at it. */
  size: number;
  fileName: string;
  description: string;
  kind: string;
  uploadedBy: string;
  places: Place[];
  /** The newest row for this file, for the timestamp and the remove target. */
  newest: R;
};

const placeOf = (r: FileRow): Place =>
  r.instrumentId !== null
    ? { kind: "system", attachmentId: r.id, id: r.instrumentId, label: r.externalId || `system ${r.instrumentId}` }
    : r.assetId !== null
      ? { kind: "unit", attachmentId: r.id, id: r.assetId, label: r.assetLabel || `unit ${r.assetId}` }
      : { kind: "shelf", attachmentId: r.id };

/**
 * Rows must arrive newest-first; the first row seen for a URL is the one whose
 * name and description the file is shown under, because that is the most recent
 * thing anybody called it.
 */
export function groupStoredFiles<R extends FileRow>(rows: R[]): StoredFile<R>[] {
  const out: StoredFile<R>[] = [];
  const byUrl = new Map<string, StoredFile<R>>();
  for (const r of rows) {
    const found = byUrl.get(r.url);
    if (found) { found.places.push(placeOf(r)); continue; }
    const file: StoredFile<R> = {
      url: r.url, size: r.size, fileName: r.fileName, description: r.description,
      kind: r.kind, uploadedBy: r.uploadedBy, places: [placeOf(r)], newest: r,
    };
    byUrl.set(r.url, file);
    out.push(file);
  }
  return out;
}

/** Must equal what the meter says, or one of the two is wrong. */
export function totalBytes<R extends FileRow>(files: StoredFile<R>[]): number {
  return files.reduce((n, f) => n + f.size, 0);
}
