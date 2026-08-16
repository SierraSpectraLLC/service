// The catalog's reference library, pure half: which filed references apply to
// which equipment, and the labels the panel prints. The database rows live in
// catalog_refs; matching is by module type + model, the same shape procedures
// use, so "every Mass Spec" and "the Thermo Altis specifically" are both sayable.

export type CatalogRef = {
  id: number;
  assetType: string;
  model: string;        // "" = every model of the type
  kind: string;         // 'link' | 'note'
  title: string;
  url: string;
  body: string;
  createdBy: string;
};

export type UnitLike = { kind: string; model: string };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Does this reference cover this unit? Type must match; blank model covers all. */
export const refCovers = (r: Pick<CatalogRef, "assetType" | "model">, u: UnitLike): boolean =>
  same(r.assetType, u.kind) && (!r.model.trim() || same(r.model, u.model));

/** Every reference that applies to any of these units, in stored order, deduped. */
export function refsForUnits<T extends CatalogRef>(refs: T[], units: UnitLike[]): T[] {
  return refs.filter((r) => units.some((u) => refCovers(r, u)));
}

/** "Thermo Altis" or "any Mass Spec" - where a reference is filed. */
export const refScopeLabel = (r: Pick<CatalogRef, "assetType" | "model">): string =>
  r.model.trim() ? r.model : `any ${r.assetType.toLowerCase()}`;

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
