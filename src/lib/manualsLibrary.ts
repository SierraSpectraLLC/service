// The manuals library, pure half: the catalog's reference shelf read as a
// drive - Manufacturer > Series > Model > the manuals filed on it.
//
// Nothing here is a new kind of record. The rows are catalog_refs, the same
// rows the Reference panel shows on every system and unit of the model, and
// the manufacturers and families are what vocab_terms already says about each
// model. What this adds is the ORDER: the shelf had been one long list sliced
// by model name, and a person looking for the TSQ manual thinks "Thermo, then
// TSQ", the way the folders on their drive were laid out before this existed.
//
// Every catalog model is a folder whether or not anything is filed in it yet.
// That is deliberate - an empty folder is an invitation, and a library that
// only shows the makers somebody has already filed under cannot be browsed
// for what is missing.
//
// The series level is optional and most models have none. Where it exists it
// is a folder with two things in it: the manuals filed on the whole family
// ("all ISQs share the ISQ manuals") and the models, each with whatever is
// filed on it alone ("unless otherwise stated").

import { refScopeLabel, type CatalogRef } from "./catalogRefs";

export type ModelTerm = {
  id: number;
  assetType: string;
  name: string;
  manufacturer: string;
  /** The family - "ISQ". Blank or absent = none. */
  series?: string;
};

export type ManualRef = CatalogRef & {
  provenance?: string;
  when?: string;
};

/**
 * Where a model goes when nobody has said who makes it. Also where a
 * reference lands when it names a model or a family the catalog has no entry
 * for - all are the same problem (the catalog does not know enough to shelve
 * it) with the same fix (say so in the Equipment catalog), so they share one
 * bucket at the bottom rather than three near-identical ones.
 */
export const UNSORTED_MAKER = "Not sorted yet";

export type ModelShelf = {
  /** Stable for a URL: the catalog id when there is one, else type|model. */
  key: string;
  termId: number | null;
  assetType: string;
  model: string;
  /** The family it is in, or "". */
  series: string;
  /** Filed on this model alone. */
  refs: ManualRef[];
};

export type SeriesShelf = {
  name: string;
  /** The module types its models span - normally one. */
  assetTypes: string[];
  models: ModelShelf[];
  /** Filed on the whole family. */
  refs: ManualRef[];
  /** The family's own manuals plus every model's. */
  refCount: number;
};

export type MakerShelf = {
  name: string;
  /** Models in no family. Models in one are under `series`. */
  models: ModelShelf[];
  series: SeriesShelf[];
  /** Every model, in or out of a family. */
  modelCount: number;
  /** Manuals across every model and family of this maker. */
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
 * Makers in name order with the unsorted bucket last; families and models in
 * name order inside each; references in the order they were handed in, which
 * the pages keep as filing order.
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
    shelves.set(key, {
      key: String(m.id), termId: m.id, assetType: m.assetType.trim(), model: name,
      series: (m.series ?? "").trim(), refs: [],
    });
    makerOf.set(key, m.manufacturer.trim() || UNSORTED_MAKER);
  }

  const types = new Map<string, TypeShelf>();
  const seriesRefs: ManualRef[] = [];
  for (const r of refs) {
    if (!r.model.trim()) {
      if (r.series?.trim()) { seriesRefs.push(r); continue; }
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
      shelf = {
        key: `${r.assetType.trim()}|${r.model.trim()}`, termId: null,
        assetType: r.assetType.trim(), model: r.model.trim(), series: "", refs: [],
      };
      shelves.set(key, shelf);
      makerOf.set(key, UNSORTED_MAKER);
    }
    shelf.refs.push(r);
  }

  // Makers, each holding its loose models and its families.
  const makers = new Map<string, MakerShelf>();
  const makerAt = (name: string) => {
    const mk = norm(name);
    if (!makers.has(mk)) makers.set(mk, { name, models: [], series: [], modelCount: 0, refCount: 0 });
    return makers.get(mk)!;
  };
  const seriesAt = (maker: MakerShelf, name: string) => {
    let s = maker.series.find((x) => norm(x.name) === norm(name));
    if (!s) { s = { name, assetTypes: [], models: [], refs: [], refCount: 0 }; maker.series.push(s); }
    return s;
  };
  for (const [key, shelf] of shelves) {
    const maker = makerAt(makerOf.get(key) ?? UNSORTED_MAKER);
    maker.modelCount += 1;
    maker.refCount += shelf.refs.length;
    if (shelf.series) {
      const s = seriesAt(maker, shelf.series);
      s.models.push(shelf);
      s.refCount += shelf.refs.length;
      if (!s.assetTypes.some((t) => norm(t) === norm(shelf.assetType))) s.assetTypes.push(shelf.assetType);
    } else {
      maker.models.push(shelf);
    }
  }

  // A family's own manuals go to the family that has a model of that type.
  // No such family anywhere means the catalog does not (yet) put any model
  // in it, and the manual waits in the unsorted bucket until it does.
  for (const r of seriesRefs) {
    const want = norm(r.series ?? "");
    let home: SeriesShelf | undefined;
    for (const maker of makers.values()) {
      home = maker.series.find((s) => norm(s.name) === want
        && s.assetTypes.some((t) => norm(t) === norm(r.assetType)));
      if (home) { maker.refCount += 1; break; }
    }
    if (!home) {
      const maker = makerAt(UNSORTED_MAKER);
      home = seriesAt(maker, (r.series ?? "").trim());
      if (!home.assetTypes.some((t) => norm(t) === norm(r.assetType))) home.assetTypes.push(r.assetType.trim());
      maker.refCount += 1;
    }
    home.refs.push(r);
    home.refCount += 1;
  }

  for (const maker of makers.values()) {
    maker.models.sort((a, b) => byName(a.model, b.model));
    maker.series.sort((a, b) => byName(a.name, b.name));
    for (const s of maker.series) s.models.sort((a, b) => byName(a.model, b.model));
  }

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

/** A family inside a maker, by both names. */
export function findSeries(
  tree: ManualTree, maker: string | undefined, series: string | undefined,
): { maker: MakerShelf; series: SeriesShelf } | null {
  const mk = findMaker(tree, maker);
  if (!mk || !series) return null;
  const s = mk.series.find((x) => norm(x.name) === norm(series));
  return s ? { maker: mk, series: s } : null;
}

/** A model shelf by its URL key, anywhere in the tree, with where it sits. */
export function findModel(
  tree: ManualTree, key: string | undefined,
): { maker: MakerShelf; series: SeriesShelf | null; model: ModelShelf } | null {
  if (!key) return null;
  for (const maker of tree.makers) {
    const loose = maker.models.find((m) => m.key === key);
    if (loose) return { maker, series: null, model: loose };
    for (const s of maker.series) {
      const model = s.models.find((m) => m.key === key);
      if (model) return { maker, series: s, model };
    }
  }
  return null;
}

export const findType = (tree: ManualTree, assetType: string | undefined): TypeShelf | null =>
  assetType ? tree.types.find((t) => norm(t.assetType) === norm(assetType)) ?? null : null;

/** Every model of a maker, in or out of a family. */
export const allModels = (maker: MakerShelf): ModelShelf[] =>
  [...maker.models, ...maker.series.flatMap((s) => s.models)];

export type ManualHit = {
  ref: ManualRef;
  /** Where it is shelved, for the link back. */
  maker: string | null;
  series: string | null;
  modelKey: string | null;
  assetType: string;
  where: string;
};

/**
 * Search the whole library at once - the thing a drive's search does and a
 * folder tree does not. Matches on the manual's own words and on where it is
 * shelved, so "thermo" finds every Thermo manual and "isq" finds the ISQ
 * shelf even when no title says the word.
 */
export function searchManuals(tree: ManualTree, query: string): ManualHit[] {
  const q = norm(query);
  if (!q) return [];
  const hits: ManualHit[] = [];
  const matches = (hay: string[]) => hay.some((h) => norm(h).includes(q));
  const onModel = (maker: MakerShelf, series: SeriesShelf | null, model: ModelShelf) => {
    for (const ref of model.refs) {
      if (matches([ref.title, ref.url, ref.body, model.model, model.series, model.assetType, maker.name])) {
        hits.push({
          ref, maker: maker.name, series: series?.name ?? null, modelKey: model.key, assetType: model.assetType,
          where: `${maker.name} / ${model.model}`,
        });
      }
    }
  };
  for (const maker of tree.makers) {
    for (const model of maker.models) onModel(maker, null, model);
    for (const s of maker.series) {
      for (const ref of s.refs) {
        if (matches([ref.title, ref.url, ref.body, s.name, ...s.assetTypes, maker.name])) {
          hits.push({
            ref, maker: maker.name, series: s.name, modelKey: null, assetType: ref.assetType,
            where: `${maker.name} / every ${s.name}`,
          });
        }
      }
      for (const model of s.models) onModel(maker, s, model);
    }
  }
  for (const type of tree.types) {
    for (const ref of type.refs) {
      if (matches([ref.title, ref.url, ref.body, type.assetType])) {
        hits.push({ ref, maker: null, series: null, modelKey: null, assetType: type.assetType, where: refScopeLabel(ref) });
      }
    }
  }
  return hits;
}

const count = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;

/** "3 models · 12 manuals" - a maker's card line. */
export const makerLine = (m: MakerShelf): string =>
  `${count(m.modelCount, "model")} · ${count(m.refCount, "manual")}`;

/** "2 models · 5 manuals" - a family's card line. */
export const seriesLine = (s: SeriesShelf): string =>
  `${count(s.models.length, "model")} · ${count(s.refCount, "manual")}`;

/** Totals for the tiles at the top. */
export function treeTotals(tree: ManualTree): { makers: number; models: number; manuals: number } {
  return {
    makers: tree.makers.filter((m) => m.name !== UNSORTED_MAKER).length,
    models: tree.makers.reduce((n, m) => n + m.modelCount, 0),
    manuals: tree.makers.reduce((n, m) => n + m.refCount, 0) + tree.types.reduce((n, t) => n + t.refs.length, 0),
  };
}
