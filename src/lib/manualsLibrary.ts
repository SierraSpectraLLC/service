// The manuals library, pure half: the catalog's reference shelf read as a
// drive - Manufacturer > Model > the manuals filed on it.
//
// Nothing here is a new kind of record. The rows are catalog_refs, the same
// rows the Reference panel shows on every system and unit of the model, and
// the manufacturers are what vocab_terms already says about each model. What
// this adds is the ORDER: the shelf had been one long list sliced by model
// name, and a person looking for the TSQ manual thinks "Thermo, then TSQ",
// the way the folders on their drive were laid out before this existed.
//
// Every catalog model is a folder whether or not anything is filed in it yet.
// That is deliberate - an empty folder is an invitation, and a library that
// only shows the makers somebody has already filed under cannot be browsed
// for what is missing.

import { refScopeLabel, type CatalogRef } from "./catalogRefs";

export type ModelTerm = {
  id: number;
  assetType: string;
  name: string;
  manufacturer: string;
};

export type ManualRef = CatalogRef & {
  provenance?: string;
  when?: string;
};

/**
 * Where a model goes when nobody has said who makes it. Also where a
 * reference lands when it names a model the catalog has no entry for - both
 * are the same problem (the catalog does not know enough to shelve it) with
 * the same fix (say so in the Equipment catalog), so they share one bucket at
 * the bottom rather than two near-identical ones.
 */
export const UNSORTED_MAKER = "Not sorted yet";

export type ModelShelf = {
  /** Stable for a URL: the catalog id when there is one, else type|model. */
  key: string;
  termId: number | null;
  assetType: string;
  model: string;
  refs: ManualRef[];
};

export type MakerShelf = {
  name: string;
  models: ModelShelf[];
  /** Manuals across every model of this maker. */
  refCount: number;
};

/** References filed on a whole module type - "any mass spec". */
export type TypeShelf = {
  assetType: string;
  refs: ManualRef[];
};

export type ManualTree = {
  makers: MakerShelf[];
  types: TypeShelf[];
};

const norm = (s: string) => s.trim().toLowerCase();
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

export const modelKey = (assetType: string, model: string) => `${norm(assetType)}|${norm(model)}`;

/**
 * Shelve the catalog and its references.
 *
 * Makers in name order with the unsorted bucket last; models in name order
 * inside each; references in the order they were handed in, which the pages
 * keep as filing order.
 */
export function buildManualTree(models: ModelTerm[], refs: ManualRef[]): ManualTree {
  const shelves = new Map<string, ModelShelf>();
  const makerOf = new Map<string, string>();

  for (const m of models) {
    const name = m.name.trim();
    if (!name || !m.assetType.trim()) continue;
    const key = modelKey(m.assetType, name);
    // The first definition wins. The catalog's unique rule already stops two
    // rows claiming one (type, name), so this is only defensive.
    if (shelves.has(key)) continue;
    shelves.set(key, { key: String(m.id), termId: m.id, assetType: m.assetType.trim(), model: name, refs: [] });
    makerOf.set(key, m.manufacturer.trim() || UNSORTED_MAKER);
  }

  const types = new Map<string, TypeShelf>();
  for (const r of refs) {
    if (!r.model.trim()) {
      const t = norm(r.assetType);
      if (!types.has(t)) types.set(t, { assetType: r.assetType.trim(), refs: [] });
      types.get(t)!.refs.push(r);
      continue;
    }
    const key = modelKey(r.assetType, r.model);
    let shelf = shelves.get(key);
    if (!shelf) {
      // Filed on a model the catalog never defined - a unit's freehand model
      // name, most likely. Shown rather than dropped, under the bucket that
      // says why it is there.
      shelf = { key: `${r.assetType.trim()}|${r.model.trim()}`, termId: null, assetType: r.assetType.trim(), model: r.model.trim(), refs: [] };
      shelves.set(key, shelf);
      makerOf.set(key, UNSORTED_MAKER);
    }
    shelf.refs.push(r);
  }

  const makers = new Map<string, MakerShelf>();
  for (const [key, shelf] of shelves) {
    const maker = makerOf.get(key) ?? UNSORTED_MAKER;
    const mk = norm(maker);
    if (!makers.has(mk)) makers.set(mk, { name: maker, models: [], refCount: 0 });
    const row = makers.get(mk)!;
    row.models.push(shelf);
    row.refCount += shelf.refs.length;
  }
  for (const row of makers.values()) row.models.sort((a, b) => byName(a.model, b.model));

  const sorted = [...makers.values()].sort((a, b) => {
    const au = a.name === UNSORTED_MAKER, bu = b.name === UNSORTED_MAKER;
    if (au !== bu) return au ? 1 : -1;
    return byName(a.name, b.name);
  });

  return {
    makers: sorted,
    types: [...types.values()].sort((a, b) => byName(a.assetType, b.assetType)),
  };
}

/** A maker by name, the way a URL spells it - case and whitespace forgiven. */
export const findMaker = (tree: ManualTree, name: string | undefined): MakerShelf | null =>
  name ? tree.makers.find((m) => norm(m.name) === norm(name)) ?? null : null;

/** A model shelf by its URL key, anywhere in the tree. */
export function findModel(tree: ManualTree, key: string | undefined): { maker: MakerShelf; model: ModelShelf } | null {
  if (!key) return null;
  for (const maker of tree.makers) {
    const model = maker.models.find((m) => m.key === key);
    if (model) return { maker, model };
  }
  return null;
}

export const findType = (tree: ManualTree, assetType: string | undefined): TypeShelf | null =>
  assetType ? tree.types.find((t) => norm(t.assetType) === norm(assetType)) ?? null : null;

export type ManualHit = {
  ref: ManualRef;
  /** Where it is shelved, for the link back: a model's shelf or a type's. */
  maker: string | null;
  modelKey: string | null;
  assetType: string;
  where: string;
};

/**
 * Search the whole library at once - the thing a drive's search does and a
 * folder tree does not. Matches on the manual's own words and on where it is
 * shelved, so "thermo" finds every Thermo manual and "exploris" finds the
 * Exploris shelf even when no title says the word.
 */
export function searchManuals(tree: ManualTree, query: string): ManualHit[] {
  const q = norm(query);
  if (!q) return [];
  const hits: ManualHit[] = [];
  const matches = (hay: string[]) => hay.some((h) => norm(h).includes(q));
  for (const maker of tree.makers) {
    for (const model of maker.models) {
      for (const ref of model.refs) {
        if (matches([ref.title, ref.url, ref.body, model.model, model.assetType, maker.name])) {
          hits.push({ ref, maker: maker.name, modelKey: model.key, assetType: model.assetType, where: `${maker.name} / ${model.model}` });
        }
      }
    }
  }
  for (const type of tree.types) {
    for (const ref of type.refs) {
      if (matches([ref.title, ref.url, ref.body, type.assetType])) {
        hits.push({ ref, maker: null, modelKey: null, assetType: type.assetType, where: refScopeLabel(ref) });
      }
    }
  }
  return hits;
}

/** "3 models · 12 manuals" - a maker's card line. */
export function makerLine(m: MakerShelf): string {
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  return `${n(m.models.length, "model")} · ${n(m.refCount, "manual")}`;
}

/** Totals for the tiles at the top. */
export function treeTotals(tree: ManualTree): { makers: number; models: number; manuals: number } {
  return {
    makers: tree.makers.filter((m) => m.name !== UNSORTED_MAKER).length,
    models: tree.makers.reduce((n, m) => n + m.models.length, 0),
    manuals: tree.makers.reduce((n, m) => n + m.refCount, 0) + tree.types.reduce((n, t) => n + t.refs.length, 0),
  };
}
