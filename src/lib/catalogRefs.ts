// The catalog's reference library, pure half: which filed references apply to
// which equipment, and the labels the panel prints. The database rows live in
// catalog_refs; matching is by module type + model, the same shape procedures
// use, so "every Mass Spec" and "the Thermo Altis specifically" are both sayable.
//
// Three scopes, from narrow to wide:
//   model    "ISQ 7610"        - this model and no other
//   series   every ISQ         - every model whose catalog entry is in the family
//   type     any mass spec     - every model of the module type
// A unit picks up everything at every scope that covers it. "All ISQs share
// the ISQ manuals unless otherwise stated" is: file the shared manuals on the
// series, and the one that is only for the 7610 on the model.

export type CatalogRef = {
  id: number;
  assetType: string;
  model: string;        // "" = not filed on one model
  /** "" = not filed on a family. Only read when `model` is blank. */
  series?: string;
  kind: string;         // 'link' | 'note'
  title: string;
  url: string;
  body: string;
  createdBy: string;
};

/** A unit, or a model standing in for one. `series` is its catalog family. */
export type UnitLike = { kind: string; model: string; series?: string };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Does this reference cover this unit? Type must match; then a model-filed
 * reference needs the model, a series-filed one needs the family, and a
 * type-filed one needs nothing more.
 */
export const refCovers = (r: Pick<CatalogRef, "assetType" | "model" | "series">, u: UnitLike): boolean => {
  if (!same(r.assetType, u.kind)) return false;
  if (r.model.trim()) return same(r.model, u.model);
  if (r.series?.trim()) return same(r.series, u.series ?? "");
  return true;
};

/** Every reference that applies to any of these units, in stored order, deduped. */
export function refsForUnits<T extends CatalogRef>(refs: T[], units: UnitLike[]): T[] {
  return refs.filter((r) => units.some((u) => refCovers(r, u)));
}

/**
 * Give units their catalog family, so series-filed references can reach them.
 *
 * A unit row carries a type and a model name and nothing else; the family is
 * said once, on the model's catalog entry. Looked up here by (type, model),
 * case-insensitively, which is how every other catalog match reads. A model
 * the catalog does not know keeps no family and sees no series manuals -
 * there is nothing to say which family it would be in.
 */
export function withSeries<U extends UnitLike>(
  units: U[], models: { assetType: string; name: string; series: string }[],
): (U & { series?: string })[] {
  return units.map((u) => {
    const hit = models.find((m) => same(m.assetType, u.kind) && same(m.name, u.model));
    return hit?.series.trim() ? { ...u, series: hit.series.trim() } : u;
  });
}

/** "Thermo Altis", "every ISQ" or "any Mass Spec" - where a reference is filed. */
export const refScopeLabel = (r: Pick<CatalogRef, "assetType" | "model" | "series">): string =>
  r.model.trim() ? r.model
    : r.series?.trim() ? `every ${r.series.trim()}`
    : `any ${r.assetType.toLowerCase()}`;

/**
 * Crude but honest: enough to decide between a thumbnail and a plain link.
 * Our own file route carries no extension, and everything filed through it
 * comes from the Photos panel - which only accepts images - so it renders as
 * one.
 */
export const looksLikeImage = (url: string): boolean => {
  const u = url.trim();
  return /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(u) || /^\/api\/files\/\d+$/.test(u);
};
