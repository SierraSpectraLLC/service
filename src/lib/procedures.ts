// Pure helpers for the merged procedure catalog. Timing is data
// (runs_at_intake + interval_days), parts are a JSON list in a text column
// (the parts.specs convention), and the sentence a procedure's editor sees is
// built here so it can be tested - it is the page's documentation now.
import { cadenceLabel } from "@/lib/pm";
import { summarizeItem, type CheckoutItem } from "@/lib/checkout";

export type ProcPart = { name: string; number: string };

/** Tolerant parse: bad or legacy JSON degrades to "no parts", never a crash. */
export function parseProcParts(raw: string): ProcPart[] {
  if (!raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .map((p) => ({ name: String(p?.name ?? "").trim(), number: String(p?.number ?? "").trim() }))
      .filter((p) => p.name || p.number);
  } catch {
    return [];
  }
}

export function serializeProcParts(list: ProcPart[]): string {
  const clean = list
    .map((p) => ({ name: p.name.trim(), number: p.number.trim() }))
    .filter((p) => p.name || p.number);
  return clean.length ? JSON.stringify(clean) : "";
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

/** "PN 228-35145-91" or the name when there's no number. */
export const partLabel = (p: ProcPart) =>
  p.number ? `${p.name ? `${p.name} ` : ""}PN ${p.number}` : p.name;

export type ProcedureTiming = {
  assetType: string;
  runsAtIntake: boolean;
  intervalDays: number | null;
  modelScope: string[];
  parts: ProcPart[];
};

/**
 * The live sentence in the editor: what this procedure will actually do, in
 * plain language. Returns null when the timing is invalid (never fires) so the
 * caller can show the error instead.
 */
export function describeProcedure(d: ProcedureTiming): string | null {
  const when = d.runsAtIntake && d.intervalDays !== null
    ? `at intake and ${cadenceLabel(d.intervalDays)}`
    : d.runsAtIntake
      ? "once at intake"
      : d.intervalDays !== null
        ? cadenceLabel(d.intervalDays)
        : null;
  if (when === null) return null;
  const where = d.assetType === "system"
    ? "with every new system"
    : d.modelScope.length
      ? `on ${d.modelScope.join(", ")}`
      : `on every ${d.assetType.toLowerCase()}`;
  const parts = d.parts.length
    ? ` Takes ${d.parts.map(partLabel).join(", ")}.`
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
