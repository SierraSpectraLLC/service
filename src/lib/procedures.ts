// Pure helpers for the merged procedure catalog. Timing is data
// (runs_at_intake + interval_days), parts are a JSON list in a text column
// (the parts.specs convention), and the sentence a procedure's editor sees is
// built here so it can be tested - it is the page's documentation now.
import { cadenceLabel } from "@/lib/pm";
import { scopeMatches, summarizeItem, type CheckoutItem } from "@/lib/checkout";

/**
 * One consumable a procedure takes. `models` narrows it to the models that
 * actually use that part number - "Inspect plunger seals" is ONE procedure on
 * every pump, but the LC-20's seal kit is not the LC-30's, so each part row
 * says which models it fits. Absent or empty = fits every model the
 * procedure covers, which is what every part meant before this existed.
 *
 * `qty` is how many the job takes: an MS120's annual oil change needs two
 * bottles of AVF Gold, and one bottle arriving is the job not getting done.
 * Absent means one - the overwhelming case, and what every part meant before
 * the number existed.
 */
export type ProcPart = { name: string; number: string; qty?: number; models?: string[] };

const cleanModels = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((m) => String(m).trim()).filter(Boolean) : [];

/**
 * How many this part row takes, as a number you can multiply by.
 *
 * One is the answer to every absent, zero, fractional, negative or unparseable
 * quantity. A part that is on the list is needed, so the failure mode has to be
 * "order one" and never "order none".
 */
export function partQty(p: { qty?: number }): number {
  const n = Math.floor(Number(p.qty));
  return Number.isFinite(n) && n > 1 ? Math.min(n, 999) : 1;
}

/** Key omitted at 1, so pre-quantity rows round-trip byte-identical. */
const qtyKey = (p: { qty?: number }) => (partQty(p) > 1 ? { qty: partQty(p) } : {});

/** Tolerant parse: bad or legacy JSON degrades to "no parts", never a crash. */
export function parseProcParts(raw: string): ProcPart[] {
  if (!raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .map((p) => {
        const models = cleanModels(p?.models);
        const part: ProcPart = {
          name: String(p?.name ?? "").trim(), number: String(p?.number ?? "").trim(),
          ...qtyKey({ qty: p?.qty }),
        };
        // Key omitted rather than [] so pre-models data round-trips unchanged.
        return models.length ? { ...part, models } : part;
      })
      .filter((p) => p.name || p.number);
  } catch {
    return [];
  }
}

export function serializeProcParts(list: ProcPart[]): string {
  const clean = list
    .map((p) => {
      const models = cleanModels(p.models);
      const part: ProcPart = { name: p.name.trim(), number: p.number.trim(), ...qtyKey(p) };
      return models.length ? { ...part, models } : part;
    })
    .filter((p) => p.name || p.number);
  return clean.length ? JSON.stringify(clean) : "";
}

/**
 * The parts that apply to one concrete unit: everything unrestricted, plus
 * whatever is tagged with this unit's model. Used at stamp time - a schedule
 * or task on an LC-30 carries the LC-30's kit, not the whole mapping.
 */
export function partsForModel(parts: ProcPart[], model: string): ProcPart[] {
  return parts.filter((p) => !p.models?.length || scopeMatches(p.models, model));
}

/**
 * A schedule's parts, wherever they were written: the JSON list (stamped by a
 * procedure) or the single name/number pair (hand-made schedules, and every
 * schedule from before the list existed).
 */
export function schedulePartsOf(s: { parts?: string | null; partName: string; partNumber: string }): ProcPart[] {
  const list = parseProcParts(s.parts ?? "");
  if (list.length) return list;
  return s.partName || s.partNumber ? [{ name: s.partName, number: s.partNumber }] : [];
}

/**
 * "2 × AVF Gold PN 228-35145-91", or the name when there's no number.
 *
 * The count leads, because this line is read on a bench by somebody deciding
 * what to carry to the instrument, and "two of these" is the part of it that
 * changes what they pick up. Silent at one, so the common case stays quiet.
 */
export const partLabel = (p: ProcPart) => {
  const what = p.number ? `${p.name ? `${p.name} ` : ""}PN ${p.number}` : p.name;
  const n = partQty(p);
  return n > 1 ? `${n} × ${what}` : what;
};

export type ProcedureTiming = {
  assetType: string;
  runsAtIntake: boolean;
  intervalDays: number | null;
  /** Usage cadence ("every 2000 injections") - displayed, never cron-scheduled. */
  usage?: { every: number; unit: string } | null;
  modelScope: string[];
  /** System-level only: which system categories it covers. [] = all of them. */
  categoryScope?: string[];
  parts: ProcPart[];
};

/**
 * The live sentence in the editor: what this procedure will actually do, in
 * plain language. Returns null when the timing is invalid (never fires) so the
 * caller can show the error instead.
 */
export function describeProcedure(d: ProcedureTiming): string | null {
  const cadences = [
    ...(d.intervalDays !== null ? [cadenceLabel(d.intervalDays)] : []),
    ...(d.usage ? [`every ${d.usage.every} ${d.usage.unit} (tracked by hand)`] : []),
  ];
  const when = d.runsAtIntake && cadences.length
    ? `at intake and ${cadences.join(" and ")}`
    : d.runsAtIntake
      ? "once at intake"
      : cadences.length
        ? cadences.join(" and ")
        : null;
  if (when === null) return null;
  const where = d.assetType === "system"
    // A system procedure is narrowed by CATEGORY, because a system is not one
    // model - it is a stack of them. No categories named means every system,
    // which is what these all meant before the scope existed.
    ? (d.categoryScope?.length ? `on every ${d.categoryScope.join(", ")} system` : "on every system")
    : (d.modelScope.length
      ? `on ${d.modelScope.join(", ")}`
      : `on every ${d.assetType.toLowerCase()}`)
      // A module procedure can be scoped by system type too: the TOC sampler's
      // work is not the LC-MS sampler's, even though both are Autosamplers.
      + (d.categoryScope?.length ? ` in ${d.categoryScope.join(", ")} systems` : "");
  const parts = d.parts.length
    ? ` Takes ${d.parts.map((p) => partLabel(p) + (p.models?.length ? ` (${p.models.join("/")})` : "")).join(", ")}.`
    : "";
  return `Runs ${when} ${where}.${parts}`;
}

/**
 * Body text for work a procedure generates. Intake tasks lead with the
 * pass/target criteria (tests are meaningless without them); either kind
 * carries the steps and the part numbers, so whoever picks the task up has
 * everything in front of them.
 */
export function procedureTaskBody(
  p: CheckoutItem & { notes: string },
  parts: ProcPart[],
): string {
  const partLine = parts.length ? `Part${parts.length === 1 ? "" : "s"}: ${parts.map(partLabel).join(", ")}` : "";
  return [summarizeItem(p), p.notes, partLine].filter(Boolean).join("\n");
}
