// A stable name for a piece of work, so two shops doing the same job produce
// the same row in a machine's history.
//
// THE FAILURE: a procedure's identity was its `name` plus whatever scope
// happened to be set on it. One workspace writes "Replace lamp", the next
// writes "Lamp replacement", the same shop writes "Replace the D2 lamp" under a
// second model - three procedures, one job, and nothing anywhere can answer
// "when was the lamp last changed on this machine". That question is the entire
// product on a resale, and it is unanswerable from prose.
//
// Pure and dependency-free so the slug rule can be pinned by a test rather than
// rediscovered every time somebody adds a procedure. The rule must never drift:
// a key is written into events that have already travelled to other people, and
// re-slugging afterwards silently orphans them.

/**
 * Lowercase, hyphenated, ASCII. Punctuation and accents go, digits stay - '5%
 * KOH flush' and 'Replace 6890 liner' both have to survive as something
 * readable, because a human reads these in a URL and on a printed sheet.
 */
export function slug(s: string): string {
  return s
    .normalize("NFKD")
    // Strip combining marks so "Réservoir" and "Reservoir" are one key rather
    // than two that look identical in every list they appear in.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

export type ProcedureScope = {
  assetType: string;
  /** [] = every model. */
  modelScope: string[];
  /** System-level procedures only. [] = every category. */
  categoryScope: string[];
};

/**
 * The half of the key that says WHAT THIS APPLIES TO.
 *
 * Narrowest wins: a procedure scoped to two models is about those models, and
 * saying so in the key is what stops one shop's "6495C lamp change" from
 * colliding with its "1260 lamp change". Sorted, because scope is a set and
 * [A,B] must not key differently from [B,A] - the arrays are edited by hand in
 * a multi-select and their order means nothing.
 */
export function scopeSlug(p: ProcedureScope): string {
  const pick = p.modelScope.length ? p.modelScope
    : p.categoryScope.length ? p.categoryScope
    : [p.assetType];
  const parts = [...pick].map((x) => slug(x)).filter(Boolean).sort();
  // Everything blank is a real state - a procedure on no scope at all - and it
  // needs a word rather than an empty segment, or the key starts with '/'.
  return parts.length ? parts.join("-") : "any";
}

/** `6495c/replace-lamp`. Blank name yields '' - the caller reports, never guesses. */
export function procedureKey(p: ProcedureScope & { name: string }): string {
  const tail = slug(p.name);
  return tail ? `${scopeSlug(p)}/${tail}` : "";
}

export type KeyedRow = { id: number; tenantOrgId: number | null; name: string } & ProcedureScope;
export type Collision = { tenantOrgId: number | null; key: string; ids: number[]; names: string[] };

/**
 * Two rows in one workspace that would key the same.
 *
 * REPORTED, never auto-suffixed. A '-2' on the end is a decision about which of
 * two procedures is the real one, taken by a script at 3am on a workspace it
 * has never seen; the duplicates are usually a genuine data problem somebody
 * should look at, and the ones that are not are still theirs to resolve.
 */
export function keyCollisions(rows: KeyedRow[]): Collision[] {
  const byKey = new Map<string, KeyedRow[]>();
  for (const r of rows) {
    const key = procedureKey(r);
    if (!key) continue;
    const k = `${r.tenantOrgId ?? "none"}|${key}`;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const out: Collision[] = [];
  for (const [k, group] of byKey) {
    if (group.length < 2) continue;
    out.push({
      tenantOrgId: group[0].tenantOrgId,
      key: k.slice(k.indexOf("|") + 1),
      ids: group.map((r) => r.id),
      names: group.map((r) => r.name),
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Which set version a row belongs to, given the published sets for its model. */
export type SetRow = { id: number; assetType: string; modelScope: string[]; version: number; publishedAt: Date | null };

/**
 * The set a piece of work should be recorded against: the highest PUBLISHED
 * version whose scope covers this asset type and model.
 *
 * A draft never wins. A sheet printed from an unpublished set is a sheet whose
 * steps can still change under it, which is the one thing paper cannot survive.
 */
export function currentSet(sets: SetRow[], assetType: string, model: string): SetRow | null {
  const fits = sets.filter((s) =>
    s.publishedAt !== null
    && (s.assetType === "" || s.assetType === assetType)
    && (s.modelScope.length === 0 || s.modelScope.includes(model)));
  if (!fits.length) return null;
  // A model-scoped set beats a catch-all at the same version: it was written
  // about this machine, and the general one was written about its type.
  return fits.sort((a, b) =>
    b.version - a.version
    || (b.modelScope.length ? 1 : 0) - (a.modelScope.length ? 1 : 0))[0];
}
