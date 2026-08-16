// Which gases a piece of equipment needs, according to the catalog.
//
// A Thermo Altis needs nitrogen and argon whoever owns it and whichever system
// it lands in, so that fact belongs to the catalog rather than being typed onto
// each record. Declared on a model, a module type, or a system type; read here
// and applied by the actions that create equipment.
//
// Pure: callers hand in the catalog rows, this decides what applies.

export type GasTerm = {
  kind: string;        // 'category' | 'asset_type' | 'model'
  assetType: string;   // models only: which module type
  name: string;
  gases: string[];
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const uniq = (list: string[]) => {
  const out: string[] = [];
  for (const g of list.map((x) => x.trim()).filter(Boolean)) {
    if (!out.some((o) => same(o, g))) out.push(g);
  }
  return out;
};

/**
 * The gases a unit needs: its model's, plus its module type's.
 *
 * Both, not one or the other - "every autosampler needs nitrogen" and "this
 * model also needs argon" are both true, and picking one would silently drop
 * the other.
 */
export function gasesForUnit(terms: GasTerm[], unit: { kind: string; model: string }): string[] {
  return uniq(terms.flatMap((t) => {
    if (t.kind === "model" && unit.model && same(t.name, unit.model)
      && (!t.assetType || same(t.assetType, unit.kind))) return t.gases;
    if (t.kind === "asset_type" && same(t.name, unit.kind)) return t.gases;
    return [];
  }));
}

/** The gases a system needs by virtue of its type. */
export function gasesForSystem(terms: GasTerm[], category: string): string[] {
  if (!category.trim()) return [];
  return uniq(terms.flatMap((t) => (t.kind === "category" && same(t.name, category) ? t.gases : [])));
}

/**
 * Everything a system needs: its own type's gases and those of every unit
 * installed in it. A system is a stack of equipment, so its requirement is the
 * union of what the stack needs.
 */
export function gasesForSystemWithUnits(
  terms: GasTerm[], category: string, units: { kind: string; model: string }[],
): string[] {
  return uniq([...gasesForSystem(terms, category), ...units.flatMap((u) => gasesForUnit(terms, u))]);
}

/** Which of these are not on the record yet - what actually needs adding. */
export const missingGases = (required: string[], existing: string[]): string[] =>
  required.filter((g) => !existing.some((e) => same(e, g)));
