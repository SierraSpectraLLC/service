// What a test actually measured, and whether that passes.
//
// The catalog has always been able to say a test exists and what it should read
// - "flow, target 5 mL/min, ± 10%" - but there was nowhere to put the number
// you got. So a test was completed with a checkbox, the criteria sat in the
// task body as prose nobody could act on, and the only evidence a signature
// could point at was a file somebody remembered to upload afterwards.
//
// This is the arithmetic half: given the spec and what was observed, does it
// pass. Pure, because the server has to be able to reach the same verdict as
// the browser did - a reading is a claim about an instrument and the record of
// it must not depend on which side of the wire evaluated it.

export type ResultSpec = {
  resultType: string;            // pass_fail | measured | reading | note
  target: string | null;         // the value it should read, e.g. "5 mL/min"
  tolerancePct: string | null;   // allowed deviation, percent of target
  /** The structured spec (JSON, see Acceptance). "" or absent = legacy prose. */
  acceptance?: string | null;
};

/**
 * The structured acceptance spec a test carries (procedures.acceptance) and a
 * result freezes (task_results.acceptance). One shape for all four result
 * types; each type reads only its own keys. Stored as JSON so the fields
 * version together, parsed tolerantly so bad or legacy data degrades to
 * "no structured spec", never a crash.
 */
export type CriterionOp = "gte" | "lte" | "lt" | "gt" | "pm";
export type Criterion = {
  op: CriterionOp;
  value: number;
  unit: string;
  /** pm only: the center the ± band sits on ("± 0.05 of 1.00 mL/min"). */
  center?: number;
};
export type Acceptance = {
  /** Measured: rows joined by OR - the result passes if any one is met. */
  criteria?: Criterion[];
  /** Measured: the standard, tool or method it is measured with. */
  measuredWith?: string;
  /** Measured: the work-order form also records the raw replicates. */
  replicates?: boolean;
  /** Pass/fail: what counts as a pass - guidance for the tech, not a grade. */
  passHint?: string;
  /** Pass/fail: a number is recorded alongside the verdict, ungraded. */
  attachReading?: boolean;
  /** Pass/fail (attachReading) and reading: the number's unit. */
  unit?: string;
  /** Reading: the typical range - a muted hint that never fails anything. */
  typicalLow?: number;
  typicalHigh?: number;
  /** Note: the prompt the tech answers. */
  prompt?: string;
};

const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
};

const OPS: readonly CriterionOp[] = ["gte", "lte", "lt", "gt", "pm"];

export function parseAcceptance(raw: string | null | undefined): Acceptance {
  if (!raw?.trim()) return {};
  try {
    const v = JSON.parse(raw);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const a: Acceptance = {};
    if (Array.isArray(v.criteria)) {
      const rows = v.criteria
        .map((c: Record<string, unknown>): Criterion | null => {
          const op = OPS.includes(c?.op as CriterionOp) ? (c.op as CriterionOp) : null;
          const value = num(c?.value);
          const unit = String(c?.unit ?? "").trim();
          if (!op || value === undefined || !unit) return null;
          const center = op === "pm" ? num(c?.center) : undefined;
          if (op === "pm" && center === undefined) return null;
          return center !== undefined ? { op, value, unit, center } : { op, value, unit };
        })
        .filter((c: Criterion | null): c is Criterion => c !== null);
      if (rows.length) a.criteria = rows;
    }
    if (typeof v.measuredWith === "string" && v.measuredWith.trim()) a.measuredWith = v.measuredWith.trim();
    if (v.replicates === true) a.replicates = true;
    if (typeof v.passHint === "string" && v.passHint.trim()) a.passHint = v.passHint.trim();
    if (v.attachReading === true) a.attachReading = true;
    if (typeof v.unit === "string" && v.unit.trim()) a.unit = v.unit.trim();
    const lo = num(v.typicalLow), hi = num(v.typicalHigh);
    if (lo !== undefined) a.typicalLow = lo;
    if (hi !== undefined) a.typicalHigh = hi;
    if (typeof v.prompt === "string" && v.prompt.trim()) a.prompt = v.prompt.trim();
    return a;
  } catch {
    return {};
  }
}

/** "" when nothing meaningful is set, so an untouched spec stays untouched. */
export function serializeAcceptance(a: Acceptance): string {
  const clean = parseAcceptance(JSON.stringify(a));
  return Object.keys(clean).length ? JSON.stringify(clean) : "";
}

export const OP_LABEL: Record<CriterionOp, string> = {
  gte: "≥", lte: "≤", lt: "<", gt: ">", pm: "±",
};

/** "≥ 0.15 %RSD", "± 0.05 of 1 mL/min" - the sentence a limit reads as. */
export function criterionLabel(c: Criterion): string {
  if (c.op === "pm") return `${OP_LABEL.pm} ${c.value} of ${c.center} ${c.unit}`;
  return `${OP_LABEL[c.op]} ${c.value} ${c.unit}`;
}

export function criterionMet(c: Criterion, got: number): boolean {
  if (c.op === "gte") return got >= c.value;
  if (c.op === "lte") return got <= c.value;
  if (c.op === "lt") return got < c.value;
  if (c.op === "gt") return got > c.value;
  return Math.abs(got - (c.center ?? 0)) <= Math.abs(c.value);
}

/** The distinct units the criteria mention, in the order they appear. */
export function acceptanceUnits(a: Acceptance): string[] {
  const out: string[] = [];
  for (const c of a.criteria ?? []) {
    if (!out.some((u) => u.toLowerCase() === c.unit.toLowerCase())) out.push(c.unit);
  }
  return out;
}

/**
 * The readings out of a recorded value string, unit and all. The work-order
 * form writes one entry per unit joined by "; " ("0.12 %RSD; 8 nL"); a bare
 * number with no unit is honest too and matches a single-unit spec.
 */
export function parseEntries(value: string): { got: number; unit: string }[] {
  return value.split(";").flatMap((piece) => {
    const got = firstNumber(piece);
    if (got === null) return [];
    const unit = piece.replace(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/, "").trim();
    return [{ got, unit }];
  });
}

/**
 * Whether a legacy test needs its limits moved into structured criteria by
 * hand: a measured test with no criteria whose prose spec (target/tolerance)
 * or wording carries limit syntax. Flagged, never parsed automatically - see
 * the Needs review filter.
 */
export function needsAcceptanceReview(p: {
  kind: string; resultType: string; acceptance?: string | null;
  target?: string | null; tolerancePct?: string | null; name?: string; notes?: string;
}): boolean {
  if (p.kind !== "test") return false;
  if (parseAcceptance(p.acceptance).criteria?.length) return false;
  if (p.resultType === "measured" && (p.target?.trim() || p.tolerancePct?.trim())) return true;
  return /[<>≤≥±]\s*\d/.test(`${p.name ?? ""} ${p.notes ?? ""}`);
}

export type Verdict = {
  /** true/false where the spec supports a verdict, null where it does not. */
  passed: boolean | null;
  /** Why, in the words the tech should see: "5.2 mL/min, within 4.5-5.5". */
  why: string;
};

/**
 * The first number in a string. Targets and readings are written the way they
 * are read off the front panel - "5 mL/min", "1.2e3 counts", "-0.4 C" - so the
 * unit rides along with the value rather than living in its own field.
 */
export function firstNumber(s: string | null | undefined): number | null {
  const m = (s ?? "").match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Whether there is enough here to call the test recorded at all. */
export function resultIsRecorded(resultType: string, value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (resultType === "pass_fail") return /^(pass|fail)$/i.test(v);
  if (resultType === "inspect_replace") return /^(inspected|replaced)$/i.test(v);
  if (resultType === "measured" || resultType === "reading") return firstNumber(v) !== null;
  return true; // note: any text is the record
}

/**
 * The verdict for an observed value.
 *
 * A missing tolerance is not a silent pass. Somebody who wrote a target and no
 * band gets the number recorded and no judgement, because inventing a band
 * would be this file deciding what "close enough" means for an instrument it
 * knows nothing about.
 */
export function evaluateResult(spec: ResultSpec, value: string): Verdict {
  const v = value.trim();
  if (!v) return { passed: null, why: "" };

  if (spec.resultType === "pass_fail") {
    if (/^pass$/i.test(v)) return { passed: true, why: "Passed" };
    if (/^fail$/i.test(v)) return { passed: false, why: "Failed" };
    return { passed: null, why: v };
  }

  // Inspected and Replaced are both fine outcomes of the same job - neither is
  // a failure, both are facts the record needs. "Inspect and/or replace the
  // plunger seal" closes as one or the other, never as a bare checkmark.
  if (spec.resultType === "inspect_replace") {
    if (/^inspected$/i.test(v)) return { passed: null, why: "Inspected" };
    if (/^replaced$/i.test(v)) return { passed: null, why: "Replaced" };
    return { passed: null, why: v };
  }

  if (spec.resultType === "measured") {
    // Structured criteria first: OR-joined rows, each judged in its own unit.
    // Criteria with different units mean the tech may enter either - the
    // result passes if any one criterion is met by the entry in its unit.
    const criteria = parseAcceptance(spec.acceptance).criteria;
    if (criteria?.length) {
      const entries = parseEntries(v);
      if (!entries.length) return { passed: null, why: v };
      const only = acceptanceUnits({ criteria }).length === 1;
      const met = criteria.find((c) => {
        const e = entries.find((x) =>
          x.unit.toLowerCase() === c.unit.toLowerCase() || (only && !x.unit));
        return e !== undefined && criterionMet(c, e.got);
      });
      return met
        ? { passed: true, why: `${v} - meets ${criterionLabel(met)}` }
        : { passed: false, why: `${v} - outside ${criteria.map(criterionLabel).join(" or ")}` };
    }
    const got = firstNumber(v);
    const target = firstNumber(spec.target);
    const pct = firstNumber(spec.tolerancePct);
    if (got === null) return { passed: null, why: v };
    if (target === null) return { passed: null, why: `${v} - no target set` };
    if (pct === null || pct <= 0) return { passed: null, why: `${v} - no tolerance set, target ${spec.target}` };
    const band = Math.abs(target * pct) / 100;
    const lo = round(target - band);
    const hi = round(target + band);
    const ok = got >= lo && got <= hi;
    return { passed: ok, why: `${v} - ${ok ? "within" : "outside"} ${lo} to ${hi}` };
  }

  // A reading or a note is a record, not a test against anything.
  return { passed: null, why: v };
}

/** The band a measured test is judged against, for showing beside the input. */
export function toleranceBand(spec: ResultSpec): string {
  const target = firstNumber(spec.target);
  const pct = firstNumber(spec.tolerancePct);
  if (target === null || pct === null || pct <= 0) return "";
  const band = Math.abs(target * pct) / 100;
  return `${round(target - band)} to ${round(target + band)}`;
}

/**
 * Whether recording an outcome is what "done" means for this work: every test,
 * and any task the catalog marked inspect/replace. That marking is why an
 * ordinary task stays an ordinary checkbox.
 */
export const needsResult = (kind: string, resultType: string) =>
  kind === "test" || resultType === "inspect_replace";

/**
 * Whether a task may be called done.
 *
 * Gated only on HAVING a result, never on it being good news. A failed test
 * is a finished test and a replaced seal is a finished inspection: the
 * outcome is the point, and refusing to close the task would just get it
 * recorded somewhere it cannot be found.
 */
export function completionBlocked(
  task: { kind: string; resultType: string },
  result: { value: string } | null,
): string {
  if (!needsResult(task.kind, task.resultType)) return "";
  if (result && resultIsRecorded(task.resultType, result.value)) return "";
  return task.resultType === "inspect_replace"
    ? "Record what happened first - inspected, or replaced. That record is the point of the task."
    : "Record the result first - a test closed without one is a checkbox, not a measurement.";
}
