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

// ── A family's sheet, and a model's place in it ─────────────────────────────
//
// Every ISQ shares most of its numbers; the ISQ-LT differs in one or two. So
// the family (vocab_terms.series) gets a sheet of its own (catalog_series),
// and a model's own sheet holds ONLY what differs. What a reader sees is the
// two merged, the model's row winning wherever both name the same spec.
// Change a shared number on the family and every member changes; change it
// on one model and that model alone does, and keeps doing so until its row is
// taken away again - which is what "allow me to change 1 or 2 at will" means.

const key = (name: string) => name.trim().toLowerCase();

/**
 * One row of the merged sheet, and where it came from:
 *   series    the family's value, this model says nothing of its own
 *   override  the family has a value and this model replaced it
 *   own       this model alone has the row
 * `seriesValue` is what the family says, on an override, so the editor can
 * offer to go back to it.
 */
export type SheetRow = Spec & { source: "series" | "override" | "own"; seriesValue?: string };

/**
 * The sheet a reader sees. Family order first - the shared sheet is the one
 * written to read top-down - then whatever is this model's alone, in its own
 * order. A model in no family is all "own".
 */
export function effectiveSheet(own: Spec[], series: Spec[]): SheetRow[] {
  const mine = new Map(own.map((s) => [key(s.name), s]));
  const shared = new Set(series.map((s) => key(s.name)));
  const fromSeries: SheetRow[] = series.map((s) => {
    const o = mine.get(key(s.name));
    return o
      ? { name: s.name, value: o.value, source: "override", seriesValue: s.value }
      : { name: s.name, value: s.value, source: "series" };
  });
  const onlyMine: SheetRow[] = own.filter((s) => !shared.has(key(s.name))).map((s) => ({ ...s, source: "own" }));
  return [...fromSeries, ...onlyMine].slice(0, MAX_SPECS);
}

/** The same merge as plain name/value rows - for everything that only displays. */
export const effectiveSpecs = (own: Spec[], series: Spec[]): Spec[] =>
  effectiveSheet(own, series).map(({ name, value }) => ({ name, value }));

/**
 * What a model should STORE after its merged sheet has been edited: only the
 * rows that are its own. A row that reads exactly what the family says is not
 * written down - it is inherited, and will follow the family when the family
 * changes. A row the family has that the editor blanked out is dropped too,
 * which puts it back on the family's value: a model cannot subtract a shared
 * spec, only say a different one, and taking a spec off every ISQ is an edit
 * to the ISQ sheet.
 */
export function ownSpecsFrom(edited: { name: string; value: string }[], series: Spec[]): Spec[] {
  const shared = new Map(series.map((s) => [key(s.name), s.value]));
  return edited
    .map(cleanOne)
    .filter((s): s is Spec => s !== null)
    .filter((s) => shared.get(key(s.name)) !== s.value);
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
