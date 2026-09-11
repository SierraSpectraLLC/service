// Whose EOD line is whose. Pure - no db, no next-auth - so the rule that
// decides which line a person may type into is a table of cases rather than
// something discovered on the EOD page, and so client components can ask.
//
// One line per (target, day, author): each person writes their own, and
// every reading of the day says whose. See db/schema.eodUpdates.

export type EodViewer = { email: string; name: string };

/** The fields the ownership rule needs off a saved row. */
export type EodAuthored = { author: string; updatedBy: string; person?: string };

/**
 * Is this the viewer's own line - the one they may type into?
 *
 * A stamped row is theirs when the stamp is their address. A row from before
 * authorship existed has no stamp and belongs to whoever last wrote it, by
 * name: that is the only fact the old row kept, and treating it as nobody's
 * would leave yesterday's engineer looking at their own words in a box they
 * cannot edit.
 */
export function isOwnEodRow(row: EodAuthored, viewer: EodViewer | null | undefined): boolean {
  if (!viewer) return false;
  if (row.author) return row.author === viewer.email.trim().toLowerCase();
  return !!row.updatedBy && row.updatedBy === viewer.name;
}

/**
 * The name a line is attributed to, as a person reads it: who did the work
 * when that was recorded (off-system lines say), else who wrote it. An
 * address is cut at the @ - "joe.vincent" beats "joe.vincent@x.com" on a
 * report - and a row nobody signed is attributed to nobody rather than to a
 * blank.
 */
export function eodAuthorName(row: EodAuthored): string {
  const raw = (row.person || row.updatedBy || row.author || "").trim();
  return raw.includes("@") ? raw.split("@")[0] : raw;
}

/**
 * The lines of a report gathered under the thing each is about, in first-
 * appearance order. A system two people wrote about is one heading with two
 * attributed entries under it, not two numbered systems - and an off-system
 * line, having no record behind it, is always a group of its own.
 */
export function groupEodEntries<T extends { kind: string; id: number }>(entries: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const e of entries) {
    const key = e.kind === "offsystem" ? `off:${e.id}` : `${e.kind}:${e.id}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return [...groups.values()];
}

/**
 * A group and the unit groups that sit inside it: the system's own lines,
 * then each of its modules' lines. A unit whose system is not on this report
 * - one on the shelf, or in a system that is not the client's - stands as a
 * group of its own, as it always did. Numbering follows: a system and its
 * modules are one number.
 */
export type NestedEodGroup<T> = { head: T[]; modules: T[][] };

export function nestEodGroups<T extends { kind: string; id: number; parent?: { id: number } | null }>(
  groups: T[][],
): NestedEodGroup<T>[] {
  const out: NestedEodGroup<T>[] = [];
  const systems = new Map<number, NestedEodGroup<T>>();
  for (const g of groups) {
    const e = g[0];
    if (e.kind === "system") {
      const n = { head: g, modules: [] as T[][] };
      systems.set(e.id, n); out.push(n);
    }
  }
  for (const g of groups) {
    const e = g[0];
    if (e.kind === "system") continue;
    const home = e.kind === "asset" && e.parent ? systems.get(e.parent.id) : undefined;
    if (home) home.modules.push(g);
    else out.push({ head: g, modules: [] });
  }
  return out;
}
