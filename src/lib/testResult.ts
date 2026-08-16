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
};

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
