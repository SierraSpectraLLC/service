import { MODULE_KINDS } from "@/lib/stages";

/**
 * The module types the "Arrives as" and intake pickers offer.
 *
 * The shop's own catalog is the source of truth: a tenant that has curated
 * nineteen module types should see those nineteen, not our starter list, and
 * a tenant that has curated none should still get a usable picker rather than
 * an empty one. `current` is whatever the record already says - kept
 * selectable even after somebody removed that type from the catalog, so
 * editing an old part never silently rewrites what it arrives as.
 */
export function moduleTypeOptions(catalog: readonly string[], current = ""): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };
  const curated = catalog.map((c) => c.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
  // The starter list keeps its curated order; a catalog reads alphabetically,
  // because at nineteen entries hunting beats any order we invented for them.
  (curated.length ? curated : [...MODULE_KINDS]).forEach(push);
  push(current);
  return out;
}

export type CatalogModel = { assetType: string; name: string; manufacturer: string };

/**
 * The catalog's models for one module type, for the picker that fills a new
 * unit's name and maker in one tap.
 *
 * Matching is case-insensitive on purpose: a catalog carrying "Mass spec" and
 * a unit recorded as "Mass Spec" are the same type to everyone but a string
 * comparison, and a picker that silently offered nothing would read as an
 * empty catalog rather than a spelling difference.
 */
export function modelsForType(models: readonly CatalogModel[], type: string): CatalogModel[] {
  const want = type.trim().toLowerCase();
  if (!want) return [];
  return models
    .filter((m) => m.assetType.trim().toLowerCase() === want && m.name.trim())
    .sort((a, b) => (a.manufacturer || "~").localeCompare(b.manufacturer || "~") || a.name.localeCompare(b.name));
}
