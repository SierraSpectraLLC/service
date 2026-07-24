// Custom label/value fields on parts (e.g. a GC column's ID / Length / Film),
// stored as a JSON array of {k, v} string pairs in parts.specs. Pure and
// defensive: garbage input parses to [], and serialization enforces caps so a
// bad client can't bloat rows.

export type SpecPair = { k: string; v: string };

export const SPECS_MAX_PAIRS = 12;
const MAX_KEY = 60;
const MAX_VALUE = 200;

export function parseSpecs(text: string): SpecPair[] {
  if (!text.trim()) return [];
  try {
    const raw = JSON.parse(text);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p): p is { k: unknown; v: unknown } => !!p && typeof p === "object")
      .map((p) => ({ k: String(p.k ?? ""), v: String(p.v ?? "") }))
      .filter((p) => p.k.trim() || p.v.trim())
      .slice(0, SPECS_MAX_PAIRS);
  } catch {
    return [];
  }
}

export function serializeSpecs(pairs: SpecPair[]): string {
  const clean = pairs
    .map((p) => ({ k: p.k.trim().slice(0, MAX_KEY), v: p.v.trim().slice(0, MAX_VALUE) }))
    .filter((p) => p.k || p.v)
    .slice(0, SPECS_MAX_PAIRS);
  return clean.length ? JSON.stringify(clean) : "";
}
