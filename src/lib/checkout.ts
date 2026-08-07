// Checkout rules: which auto-generated tests apply to an asset.
//
// A rule can carry a model filter (case-insensitive substring). When any
// filtered rules match an asset's model, they REPLACE the kind's generic
// rules; otherwise the generic rules apply. "Full system" rules use the
// same shape with the instrument model.

export type CheckoutRule = {
  id?: number;
  kind: string;
  modelMatch: string;
  title: string;
  criteria: string;
  sortOrder: number;
};

export function matchRules<R extends CheckoutRule>(rules: R[], kind: string, model: string): R[] {
  const forKind = rules.filter((r) => r.kind === kind);
  const m = model.trim().toLowerCase();
  const specific = forKind.filter(
    (r) => r.modelMatch.trim() && m.includes(r.modelMatch.trim().toLowerCase())
  );
  const picked = specific.length ? specific : forKind.filter((r) => !r.modelMatch.trim());
  return [...picked].sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
}
