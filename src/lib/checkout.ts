// Checkout items: which auto-generated tasks and tests apply to an asset (or,
// with assetType "system", to a whole instrument).
//
// An item can carry a model scope (a list of exact model names; empty = all
// models). Per kind INDEPENDENTLY - a scoped test never suppresses tasks, and
// vice versa - scoped items REPLACE the type's all-model items when any match
// the asset's model. System items are never model-scoped: a system has no
// model of its own (it is the sum of its assets) and its items are created
// before any asset is attached.

export const CHECKOUT_KINDS = ["task", "test"] as const;
export const RESULT_TYPES = ["pass_fail", "measured", "reading", "note"] as const;

export const RESULT_LABEL: Record<string, string> = {
  pass_fail: "Pass / Fail",
  measured: "Measured value",
  reading: "Reading",
  note: "Note",
  // Task outcome, not a test type: "inspect and/or replace X" closes as one
  // or the other, recorded. See lib/testResult.
  inspect_replace: "Inspected / Replaced",
};

export type CheckoutItem = {
  id?: number;
  assetType: string;   // MODULE_KINDS entry or "system"
  kind: string;        // 'task' | 'test'
  name: string;
  position: number;
  resultType: string;  // pass_fail | measured | reading | note (tests)
  target: string | null;
  tolerancePct: string | null; // numeric column; drizzle reads as string
  requiresNote: boolean;
  consumesPart: boolean;
  modelScope: string[]; // [] = all models
};

/** Case-insensitive model-scope match; PM templates share the semantics. */
export const scopeMatches = (scope: string[], model: string) => {
  const m = model.trim().toLowerCase();
  return scope.some((s) => s.trim().toLowerCase() === m);
};

export function matchItems<I extends CheckoutItem>(items: I[], assetType: string, model: string): I[] {
  const forType = items.filter((i) => i.assetType === assetType);
  const picked: I[] = [];
  for (const kind of CHECKOUT_KINDS) {
    const ofKind = forType.filter((i) => i.kind === kind);
    const scoped = ofKind.filter((i) => i.modelScope.length > 0 && scopeMatches(i.modelScope, model));
    picked.push(...(scoped.length ? scoped : ofKind.filter((i) => i.modelScope.length === 0)));
  }
  return picked.sort((a, b) => a.position - b.position || (a.id ?? 0) - (b.id ?? 0));
}

/**
 * Pretty "5 mL/min ± 10%" criteria for a measured test.
 *
 * The target is a value, not a band - it used to be printed as "± 5 mL/min",
 * which read as a tolerance and contradicted the pass band shown next to the
 * result entry. A target already written as a band ("+/- 2.0 C") is left alone.
 */
const measuredSpec = (item: Pick<CheckoutItem, "target" | "tolerancePct">) => {
  const parts: string[] = [];
  if (item.target) parts.push(item.target);
  if (item.tolerancePct != null && item.tolerancePct !== "") {
    const n = parseFloat(item.tolerancePct);
    parts.push(`± ${Number.isNaN(n) ? item.tolerancePct : n}%`);
  }
  return parts.join(" ");
};

/**
 * One-line criteria summary: the mono chip in the backend UI and the body of
 * the generated task.
 */
export function summarizeItem(item: CheckoutItem): string {
  if (item.kind === "test") {
    if (item.resultType === "measured") {
      const spec = measuredSpec(item);
      return spec ? `Target ${spec}` : "Measured value";
    }
    if (item.resultType === "note") return item.target ? `Note: ${item.target}` : "Note";
    return RESULT_LABEL[item.resultType] ?? item.resultType;
  }
  const flags: string[] = [];
  if (item.resultType === "inspect_replace") flags.push("Records inspected / replaced");
  if (item.requiresNote) flags.push("Note required");
  if (item.consumesPart) flags.push("Logs part used");
  return flags.length ? flags.join(" · ") : "Done / not done";
}

/**
 * The live consequence line in the item sheet. `groupItems` are the other
 * items of the same assetType (the one being edited excluded); `scope` is the
 * draft's current model scope.
 */
export function impactLine(
  kind: string,
  assetType: string,
  scope: string[],
  groupItems: Pick<CheckoutItem, "kind" | "modelScope">[],
): { text: string; warning: boolean } {
  const noun = kind === "task" ? "task" : "test";
  const scopeLabel = scope.join(", ");
  if (assetType === "system") return { text: "Created with every new system.", warning: false };
  const thing = assetType.toLowerCase();
  if (scope.length === 0) {
    return { text: `Created on every ${thing} without a model-specific ${noun}.`, warning: false };
  }
  const replaced = groupItems.filter((i) => i.kind === kind && i.modelScope.length === 0).length;
  if (replaced > 0) {
    return {
      text: `On ${scopeLabel}, this replaces the ${replaced} all-model ${noun}${replaced === 1 ? "" : "s"}. Everything else stays.`,
      warning: true,
    };
  }
  return { text: `Created only on ${scopeLabel}. Nothing replaced.`, warning: false };
}
