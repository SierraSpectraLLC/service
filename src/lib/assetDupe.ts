// When are two asset rows the same unit? Pure - no db, no tenancy - because the
// import planner, the grid guard and the "select duplicates" button in the
// browser all have to agree, and one of those runs client-side.
//
// Two different questions, deliberately answered two different ways:
//
//   A SERIAL is an identity. One serial is one physical unit, anywhere in the
//   fleet, so a second row carrying it is always a duplicate - including a
//   second row inside the same file.
//
//   NO SERIAL is a quantity. Three identical seal-less pumps on one system are
//   three real pumps, not one pump listed badly. So no-serial rows are
//   reconciled by COUNT: a file asking for three when three exist adds nothing,
//   a file asking for five when three exist adds two. That is what makes
//   re-importing the same sheet a no-op instead of a doubling.
import { normalizeSerial } from "@/lib/serial";

export type DupeFields = {
  /** The owning system's external id, lowercased. "" = on the shelf. */
  systemKey: string;
  kind: string;
  model: string;
  serial: string;
  owner: string;
  location: string;
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The match key. Serial-bearing units key globally on the serial alone: the
 * same unit moved between systems, or retyped with a different model spelling,
 * is still that unit. Serial-less units key on everything that describes them,
 * scoped to the system they sit on.
 */
export function assetDupeKey(a: DupeFields): string {
  const sn = normalizeSerial(a.serial);
  if (sn) return `sn:${sn}`;
  return ["nk", a.systemKey, norm(a.kind), norm(a.model), norm(a.owner), norm(a.location)].join("|");
}

export const isSerialKey = (key: string) => key.startsWith("sn:");

/** How many of each key already exist. */
export function countByKey(existing: DupeFields[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of existing) {
    const k = assetDupeKey(a);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

export type DupeVerdict = { skip: false } | { skip: true; key: string; reason: string };

/**
 * Walk a file's rows in order and decide each one, spending down what already
 * exists. Stateful by design: the answer for row 5 depends on rows 1-4, which
 * is exactly the count reconciliation above.
 */
export function importPlanner(existing: DupeFields[], describe?: (key: string) => string) {
  const remaining = countByKey(existing);
  const madeThisFile = new Set<string>();
  return (row: DupeFields): DupeVerdict => {
    const key = assetDupeKey(row);
    const known = describe?.(key);
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      return {
        skip: true, key,
        reason: isSerialKey(key)
          ? `serial already on file${known ? ` as ${known}` : ""}`
          : `already recorded${known ? ` as ${known}` : ""}`,
      };
    }
    // A serial can't legitimately appear twice, even in a fresh file.
    if (isSerialKey(key) && madeThisFile.has(key)) {
      return { skip: true, key, reason: "the same serial appears earlier in this file" };
    }
    madeThisFile.add(key);
    return { skip: false };
  };
}

/**
 * Which rows of an existing set are redundant copies - everything after the
 * first of each key. Used by "select duplicates" to clean up after an import
 * that ran before this existed: it keeps the oldest of each group, which is the
 * one with the history attached.
 */
export function duplicateIds<T extends DupeFields & { id: number }>(rows: T[]): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  // Oldest first, so the survivor is the original record.
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    const k = assetDupeKey(r);
    if (seen.has(k)) out.push(r.id);
    else seen.add(k);
  }
  return out;
}
