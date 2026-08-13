// What comes back from a file store, in this app's own shape.
//
// Microsoft's driveItem carries about forty fields, half of them null, and its
// folder-ness is expressed by the PRESENCE of a `folder` object rather than by a
// type. Translating that at the boundary means the browser component, the tests
// and any second provider later all deal in one small type that says what it
// means - and it means the shape of somebody else's JSON is pinned in one file
// with tests, instead of spread across a component.
//
// Pure. Nothing here talks to the network.

export type CloudItem = {
  id: string;
  name: string;
  isFolder: boolean;
  /** Bytes. 0 for a folder. */
  size: number;
  /** ISO, or "" when the far end did not say. */
  modified: string;
  /** How many things are in it, for a folder. */
  childCount: number;
  /** Which drive it lives on - a search can return items from several. */
  driveId: string;
};

type GraphItem = {
  id?: string;
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
  parentReference?: { driveId?: string };
  remoteItem?: { id?: string; parentReference?: { driveId?: string }; folder?: { childCount?: number } };
};

/**
 * One driveItem, translated.
 *
 * `remoteItem` is the case worth knowing about: a folder somebody shared with
 * you appears in your own drive as a pointer, and the id that addresses its
 * contents is the one INSIDE remoteItem, on a different drive. Reading the outer
 * id works right up until somebody clicks a shared folder, which on a shop that
 * lives out of shared SharePoint libraries is immediately.
 */
export function toCloudItem(raw: GraphItem, fallbackDriveId = ""): CloudItem | null {
  const remote = raw.remoteItem;
  const id = remote?.id ?? raw.id ?? "";
  const driveId = remote?.parentReference?.driveId ?? raw.parentReference?.driveId ?? fallbackDriveId;
  if (!id) return null;
  const folder = remote?.folder ?? raw.folder;
  return {
    id,
    name: raw.name ?? "(unnamed)",
    isFolder: folder !== undefined,
    size: folder !== undefined ? 0 : Number(raw.size ?? 0),
    modified: raw.lastModifiedDateTime ?? "",
    childCount: folder?.childCount ?? 0,
    driveId,
  };
}

const PDF = /\.pdf$/i;

/** Is this something the studio can actually open? */
export const isPdfItem = (i: CloudItem) => !i.isFolder && PDF.test(i.name);

/**
 * A folder's contents, ready to show: folders first, then files, each A-Z.
 *
 * `pdfOnly` is the studio's rule, not the format's. That browser exists to find
 * a PDF and can open nothing else, so a list padded with spreadsheets is the
 * file dialog somebody came here to avoid - dropped rather than greyed out. The
 * library takes any file at all, so the same browser on that page shows
 * everything; filtering there would hide half of what somebody came to file.
 */
export function browseListing(raw: GraphItem[], fallbackDriveId = "", pdfOnly = true): CloudItem[] {
  const items = raw
    .map((r) => toCloudItem(r, fallbackDriveId))
    .filter((i): i is CloudItem => i !== null)
    .filter((i) => i.isFolder || !pdfOnly || isPdfItem(i));
  return items.sort((a, b) =>
    Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** A search result set: the same rule, but no folders - you searched for a file. */
export const searchListing = (raw: GraphItem[], fallbackDriveId = "", pdfOnly = true): CloudItem[] =>
  browseListing(raw, fallbackDriveId, pdfOnly).filter((i) => !i.isFolder);

export type Crumb = { id: string; name: string; driveId: string };

/**
 * Where you are, as a trail you can click back along.
 *
 * Kept as a stack the caller pushes and truncates rather than parsed out of a
 * path string, because a driveItem's id is what addresses it and its path is not
 * unique across drives - two shared libraries can both have /Reports/2026.
 */
/**
 * The top of the trail is a list of PLACES, not a folder.
 *
 * Files live in at least three different stores: the person's own OneDrive, the
 * things other people shared with them, and the SharePoint library behind every
 * Team they are in. Starting at "my drive" is what made a shop that keeps
 * everything in a Team see an empty browser.
 */
export const PLACES_DRIVE = "\u0000places";
export const ROOT: Crumb = { id: "places", name: "Files", driveId: PLACES_DRIVE };
export const isPlaces = (c: Crumb) => c.driveId === PLACES_DRIVE;

/** Descend: everything up to here, then the new folder. */
export const pushCrumb = (trail: Crumb[], folder: CloudItem): Crumb[] =>
  [...trail, { id: folder.id, name: folder.name, driveId: folder.driveId }];

/** A crumb's identity. Several stores each have a folder called `root`. */
export const crumbKey = (c: Crumb) => `${c.driveId}:${c.id}`;

/** Jump back to a crumb already in the trail. Anything not in it leaves the trail alone. */
export function truncateTo(trail: Crumb[], key: string): Crumb[] {
  const ix = trail.findIndex((c) => crumbKey(c) === key);
  return ix === -1 ? trail : trail.slice(0, ix + 1);
}

/** "12 items" / "4.2 MB" - the one line under a name in the list. */
export function itemNote(i: CloudItem): string {
  if (i.isFolder) return i.childCount === 1 ? "1 item" : `${i.childCount} items`;
  const mb = i.size / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(i.size / 1024))} KB`;
}
