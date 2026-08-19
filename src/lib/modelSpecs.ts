// A model's specification sheet: the numbers somebody reaches for mid-job -
// max pressure, flow range, operating temperature - as name/value rows on the
// catalog model, so "which of these two pumps takes 1300 bar" stops being a
// manual lookup.
//
// Freeform names on purpose: the useful set differs by module type and by
// decade of instrument, and a fixed schema would be wrong for most of them.
// Consistency comes from suggestion instead - the editor offers every name
// already used on sibling models, so "Max pressure" gets one spelling.
//
// Stored as JSON text on vocab_terms.specs, same pattern as procedures.parts:
// order is authored order, because a spec sheet reads top-down.

export type Spec = { name: string; value: string };

export const MAX_SPECS = 40;
export const MAX_SPEC_NAME = 60;
export const MAX_SPEC_VALUE = 200;

const cleanOne = (s: { name?: unknown; value?: unknown }): Spec | null => {
  const name = String(s.name ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SPEC_NAME);
  const value = String(s.value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SPEC_VALUE);
  // A name with no value is a row somebody is still typing; a value with no
  // name is unreadable later. Neither is worth storing.
  if (!name || !value) return null;
  return { name, value };
};

/** Tolerant read: bad JSON or the empty string is an empty sheet, never a throw. */
export function parseModelSpecs(raw: string): Spec[] {
  if (!raw.trim()) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(cleanOne).filter((s): s is Spec => s !== null).slice(0, MAX_SPECS);
  } catch {
    return [];
  }
}

/** Normalize + serialize; duplicate names keep the LAST value (the edit wins). */
export function serializeModelSpecs(specs: { name: string; value: string }[]): string {
  const seen = new Map<string, Spec>();
  for (const raw of specs) {
    const s = cleanOne(raw);
    if (!s) continue;
    // Re-setting an existing key keeps its position but takes the new value.
    const key = s.name.toLowerCase();
    const prior = seen.get(key);
    seen.set(key, prior ? { name: prior.name, value: s.value } : s);
  }
  const list = [...seen.values()].slice(0, MAX_SPECS);
  return list.length ? JSON.stringify(list) : "";
}

/**
 * Copy another model's sheet onto this one: incoming rows fill names this
 * sheet doesn't have yet, and NEVER overwrite ones it does - what somebody
 * already wrote about this model is this model's truth, and the whole point
 * of copying G7116A onto G7116B is to fill the common ground, then edit the
 * differences by hand.
 */
export function mergeModelSpecs(mine: Spec[], incoming: Spec[]): Spec[] {
  const have = new Set(mine.map((s) => s.name.toLowerCase()));
  return [...mine, ...incoming.filter((s) => !have.has(s.name.toLowerCase()))].slice(0, MAX_SPECS);
}

/** Every distinct spec name across sibling sheets - the datalist's rows. */
export function specNameSuggestions(sheets: Spec[][]): string[] {
  const seen = new Map<string, string>();
  for (const sheet of sheets) for (const s of sheet) {
    const key = s.name.toLowerCase();
    if (!seen.has(key)) seen.set(key, s.name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
