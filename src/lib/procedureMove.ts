// Moving things around the procedure catalog.
//
// Two operations that look similar on screen and are nothing alike underneath,
// because the catalog's tree is only half real. A procedure genuinely belongs to
// a module type - that is a column on the row. Which SYSTEM CATEGORY a module
// type appears under is derived: "LC System" shows beneath "LCMS" because some
// LC System model in the catalog carries the LCMS tag. There is no row that says
// a type belongs to a category.
//
// So copying a procedure writes a procedure, and re-filing a type rewrites the
// tags on that type's models. Both are here, pure, because the second one in
// particular is easy to get subtly wrong in a way that quietly loses a model.

export type ProcedureLike = {
  assetType: string;
  kind: string;
  name: string;
  notes: string;
  resultType: string;
  target: string | null;
  tolerancePct: string | null;
  requiresNote: boolean;
  consumesPart: boolean;
  runsAtIntake: boolean;
  intervalDays: number | null;
  required: boolean;
  qualification: string;
  parts: string;
  checklist: string;
  modelScope: string[];
  categoryScope: string[];
};

/**
 * The same procedure, written against another module type.
 *
 * Everything about the WORK carries: what it is, when it fires, whether it is
 * mandatory, the parts it consumes, the note it demands. That is the point - a
 * leak check is a leak check whether the thing being checked is a pump or a
 * whole LC stack.
 *
 * The model scope does not carry, and cannot: models belong to one module type,
 * so a procedure scoped to two Shimadzu pumps means nothing on an LC System and
 * would silently apply to no unit at all. It arrives scoped to every model of
 * the new type, which is the honest reading of "copy this here".
 */
export function procedureCopy(p: ProcedureLike, toAssetType: string, position: number) {
  return {
    assetType: toAssetType,
    kind: p.kind,
    name: p.name,
    notes: p.notes,
    resultType: p.resultType,
    target: p.target,
    tolerancePct: p.tolerancePct,
    requiresNote: p.requiresNote,
    consumesPart: p.consumesPart,
    runsAtIntake: p.runsAtIntake,
    intervalDays: p.intervalDays,
    required: p.required,
    // A leak check that is OQ work on one module type is OQ work on the next.
    qualification: p.qualification,
    parts: p.parts,
    // The steps carry: a teardown copied to a second module type is the same
    // teardown, and re-typing it is how the two silently diverge.
    checklist: p.checklist,
    modelScope: [] as string[],
    // The system-type scope CARRIES: it names system types (TOC, LC-MS), and
    // those mean the same thing on the new type as on the old one - a TOC
    // procedure copied to another module type is still TOC work.
    categoryScope: [...p.categoryScope],
    position,
  };
}

/** Already there? Copying a leak check onto a type that has one is a duplicate. */
export const alreadyHas = (existing: { assetType: string; name: string }[], assetType: string, name: string) =>
  existing.some((e) => e.assetType === assetType
    && e.name.trim().toLowerCase() === name.trim().toLowerCase());

export type ModelTerm = { id: number; assetType: string; name: string; categories: string[] };

/**
 * Re-file a module type from one system category to another.
 *
 * The move is made on the type's MODELS, because that is where the tag lives.
 * Every model of this type carrying `from` gets `to` instead; the model itself,
 * its name and its manufacturer are not touched, which is the whole requirement
 * - this is a filing mistake being corrected, not a re-entry.
 *
 * Three cases the obvious loop gets wrong:
 *
 *  - A model tagged BOTH already. Swapping blindly leaves a duplicate, so the
 *    result is deduplicated and that model simply loses the old tag.
 *  - A model tagged for a third category as well. It keeps it - the type was
 *    filed in several places and only one of them was the mistake.
 *  - A model tagged with nothing at all. It is universal kit, offered under
 *    every system type, and was never under `from` in the first place. Touching
 *    it would narrow it from everywhere to one place, which nobody asked for.
 */
export function refilePlan(models: ModelTerm[], assetType: string, from: string, to: string): {
  id: number; categories: string[]; name: string;
}[] {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  if (same(from, to)) return [];
  return models
    .filter((m) => same(m.assetType, assetType) && m.categories.some((c) => same(c, from)))
    .map((m) => ({
      id: m.id,
      name: m.name,
      categories: [...new Set(m.categories.map((c) => (same(c, from) ? to : c)))],
    }));
}

/** What the confirmation and the audit line say about a move. */
export function refileSummary(assetType: string, from: string, to: string, models: number): string {
  return models === 0
    ? `nothing to move: no ${assetType} model is filed under ${from}`
    : `moved ${assetType} from ${from} to ${to} (${models} model${models === 1 ? "" : "s"} retagged)`;
}
