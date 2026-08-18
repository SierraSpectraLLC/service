// Folders in a file store.
//
// The one primitive a "true file storage system" has that a list of files does
// not: somewhere to put things so the list stops being the only way to find
// them. Deliberately narrow in scope - folders organize the LOOSE store, the
// files that belong to no system and no unit. A report filed on an instrument
// is already in the only place it should be, and letting somebody move it into
// "Old stuff" would be filing evidence away from the record it proves.
//
// Pure: the actions hand in rows and act on the answers, so a cycle check and a
// breadcrumb read the same on the server and in the browser.

export type FolderLike = { id: number; name: string; parentId: number | null };

export const MAX_FOLDER_NAME = 80;
/** Deep enough for any real filing, shallow enough that a breadcrumb fits. */
export const MAX_DEPTH = 8;

/**
 * A usable folder name, or why not.
 *
 * Slashes are refused rather than substituted: a name containing one reads as
 * two folders to every human who sees it, and quietly keeping it as a single
 * folder called "a/b" is a lie the first time somebody looks for "b".
 */
export function cleanFolderName(raw: string): { error: string } | { name: string } {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return { error: "Give the folder a name" };
  if (name.length > MAX_FOLDER_NAME) return { error: `Keep it under ${MAX_FOLDER_NAME} characters` };
  if (/[/\\]/.test(name)) return { error: "A folder name can't contain / or \\" };
  if (name === "." || name === "..") return { error: "That name means something else" };
  return { name };
}

/** Folders directly inside one, root when `parentId` is null, name order. */
export function childrenOf<T extends FolderLike>(all: T[], parentId: number | null): T[] {
  return all
    .filter((f) => f.parentId === parentId)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/**
 * The chain from the root down to this folder, for a breadcrumb.
 *
 * Stops at MAX_DEPTH rather than looping forever: the actions refuse to create
 * a cycle, but a breadcrumb is not the place to discover that one exists.
 */
export function folderPath<T extends FolderLike>(all: T[], id: number | null): T[] {
  const out: T[] = [];
  let cur = id;
  for (let i = 0; cur !== null && i <= MAX_DEPTH; i++) {
    const f = all.find((x) => x.id === cur);
    if (!f) break;
    out.unshift(f);
    cur = f.parentId;
  }
  return out;
}

/** Every folder inside this one, at any depth. Excludes the folder itself. */
export function descendantIds(all: FolderLike[], id: number): number[] {
  const out: number[] = [];
  const walk = (parent: number) => {
    for (const f of all) {
      if (f.parentId === parent && !out.includes(f.id)) { out.push(f.id); walk(f.id); }
    }
  };
  walk(id);
  return out;
}

/** How deep a folder sits. Root-level is 1. */
export const depthOf = (all: FolderLike[], id: number | null): number => folderPath(all, id).length;

/**
 * May this folder move under that one?
 *
 * The two refusals are different mistakes and say so. Dragging a folder into
 * itself or into its own child would detach the whole branch from the tree -
 * the rows would still exist and nothing would ever list them again.
 */
export function canMoveFolder(
  all: FolderLike[], id: number, intoId: number | null,
): { ok: true } | { ok: false; error: string } {
  if (intoId === id) return { ok: false, error: "A folder can't go inside itself" };
  if (intoId !== null && descendantIds(all, id).includes(intoId)) {
    return { ok: false, error: "That folder is inside this one" };
  }
  if (intoId !== null && !all.some((f) => f.id === intoId)) {
    return { ok: false, error: "That folder is gone" };
  }
  const moving = all.find((f) => f.id === id);
  if (!moving) return { ok: false, error: "That folder is gone" };
  // Depth of the destination, plus the tallest branch being carried in.
  const branch = [id, ...descendantIds(all, id)];
  const tallest = Math.max(...branch.map((b) => depthOf(all, b))) - depthOf(all, id) + 1;
  if (depthOf(all, intoId) + tallest > MAX_DEPTH) {
    return { ok: false, error: `Folders only nest ${MAX_DEPTH} deep` };
  }
  return { ok: true };
}

/** A name already taken by a sibling - case-insensitively, the way people read. */
export const nameTaken = (all: FolderLike[], parentId: number | null, name: string, exceptId?: number) =>
  all.some((f) => f.parentId === parentId && f.id !== exceptId
    && f.name.trim().toLowerCase() === name.trim().toLowerCase());

/**
 * What a folder holds, counted for the confirmation before it is deleted.
 * Empty is the only case that deletes silently; anything else says what is in
 * there, because "delete folder" and "delete forty files" are different acts.
 */
export function folderContents(
  all: FolderLike[], id: number, files: { folderId: number | null }[],
): { folders: number; files: number } {
  const inside = descendantIds(all, id);
  const scope = new Set([id, ...inside]);
  return {
    folders: inside.length,
    files: files.filter((f) => f.folderId !== null && scope.has(f.folderId)).length,
  };
}
