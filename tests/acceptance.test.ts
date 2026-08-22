// The structured acceptance spec: parse/serialize round-trips, the criterion
// arithmetic, the OR-of-units grading inside evaluateResult, and the
// needs-review flag for legacy prose limits. Pure functions, no DB.
import { describe, expect, it } from "vitest";
import {
  acceptanceUnits, criterionLabel, criterionMet, evaluateResult,
  needsAcceptanceReview, parseAcceptance, parseEntries, serializeAcceptance,
} from "@/lib/testResult";

describe("parseAcceptance / serializeAcceptance", () => {
  it("round-trips a measured spec", () => {
    const raw = serializeAcceptance({
      criteria: [
        { op: "lt", value: 0.15, unit: "%RSD" },
        { op: "lt", value: 10, unit: "nL" },
      ],
      measuredWith: "Caffeine standard, 6 replicate injections",
      replicates: true,
    });
    const a = parseAcceptance(raw);
    expect(a.criteria).toHaveLength(2);
    expect(a.criteria![0]).toEqual({ op: "lt", value: 0.15, unit: "%RSD" });
    expect(a.measuredWith).toBe("Caffeine standard, 6 replicate injections");
    expect(a.replicates).toBe(true);
  });

  it("keeps pm criteria only with a center", () => {
    const a = parseAcceptance(JSON.stringify({
      criteria: [
        { op: "pm", value: 0.05, unit: "mL/min", center: 1 },
        { op: "pm", value: 0.05, unit: "mL/min" },
      ],
    }));
    expect(a.criteria).toHaveLength(1);
    expect(a.criteria![0].center).toBe(1);
  });

  it("drops half-filled rows and empty specs", () => {
    expect(parseAcceptance(JSON.stringify({ criteria: [{ op: "gte", unit: "psi" }] })).criteria).toBeUndefined();
    expect(serializeAcceptance({})).toBe("");
    expect(parseAcceptance("not json")).toEqual({});
    expect(parseAcceptance("")).toEqual({});
  });

  it("carries reading and note fields", () => {
    const raw = serializeAcceptance({ unit: "counts", typicalLow: 1e5, typicalHigh: 5e5, prompt: "Describe spray stability" });
    const a = parseAcceptance(raw);
    expect(a.unit).toBe("counts");
    expect(a.typicalLow).toBe(1e5);
    expect(a.prompt).toBe("Describe spray stability");
  });
});

describe("criterionMet / labels / units", () => {
  it("judges each operator", () => {
    expect(criterionMet({ op: "gte", value: 5, unit: "x" }, 5)).toBe(true);
    expect(criterionMet({ op: "lte", value: 5, unit: "x" }, 5.1)).toBe(false);
    expect(criterionMet({ op: "lt", value: 5, unit: "x" }, 5)).toBe(false);
    expect(criterionMet({ op: "gt", value: 5, unit: "x" }, 6)).toBe(true);
    expect(criterionMet({ op: "pm", value: 0.05, unit: "x", center: 1 }, 1.04)).toBe(true);
    expect(criterionMet({ op: "pm", value: 0.05, unit: "x", center: 1 }, 1.06)).toBe(false);
  });

  it("labels read as the limit sentence", () => {
    expect(criterionLabel({ op: "lt", value: 0.15, unit: "%RSD" })).toBe("< 0.15 %RSD");
    expect(criterionLabel({ op: "pm", value: 0.05, unit: "mL/min", center: 1 })).toBe("± 0.05 of 1 mL/min");
  });

  it("lists distinct units in order", () => {
    expect(acceptanceUnits({ criteria: [
      { op: "lt", value: 1, unit: "%RSD" },
      { op: "lt", value: 2, unit: "nL" },
      { op: "gt", value: 3, unit: "%rsd" },
    ] })).toEqual(["%RSD", "nL"]);
  });
});

describe("parseEntries", () => {
  it("reads one entry per unit", () => {
    expect(parseEntries("0.12 %RSD; 8 nL")).toEqual([
      { got: 0.12, unit: "%RSD" }, { got: 8, unit: "nL" },
    ]);
  });
  it("reads a bare number", () => {
    expect(parseEntries("5.2")).toEqual([{ got: 5.2, unit: "" }]);
  });
});

describe("evaluateResult with criteria", () => {
  const spec = (criteria: object[]) => ({
    resultType: "measured", target: null, tolerancePct: null,
    acceptance: JSON.stringify({ criteria }),
  });

  it("passes when any OR criterion is met in its unit", () => {
    const s = spec([
      { op: "lt", value: 0.15, unit: "%RSD" },
      { op: "lt", value: 10, unit: "nL" },
    ]);
    const v = evaluateResult(s, "0.4 %RSD; 8 nL");
    expect(v.passed).toBe(true);
    expect(v.why).toContain("< 10 nL");
  });

  it("fails when every criterion misses", () => {
    const s = spec([
      { op: "lt", value: 0.15, unit: "%RSD" },
      { op: "lt", value: 10, unit: "nL" },
    ]);
    const v = evaluateResult(s, "0.4 %RSD; 12 nL");
    expect(v.passed).toBe(false);
    expect(v.why).toContain("outside");
  });

  it("matches a bare number against a single-unit spec", () => {
    const s = spec([{ op: "pm", value: 0.05, unit: "mL/min", center: 1 }]);
    expect(evaluateResult(s, "1.02").passed).toBe(true);
    expect(evaluateResult(s, "1.2").passed).toBe(false);
  });

  it("falls back to target/tolerance when no criteria", () => {
    const s = { resultType: "measured", target: "5 mL/min", tolerancePct: "10", acceptance: "" };
    expect(evaluateResult(s, "5.2").passed).toBe(true);
    expect(evaluateResult(s, "6").passed).toBe(false);
  });
});

describe("needsAcceptanceReview", () => {
  it("flags measured tests with prose limits and no criteria", () => {
    expect(needsAcceptanceReview({ kind: "test", resultType: "measured", target: "5 mL/min", tolerancePct: "10", acceptance: "" })).toBe(true);
  });
  it("flags limit syntax living in the name", () => {
    expect(needsAcceptanceReview({ kind: "test", resultType: "pass_fail", name: "Carryover <0.15 % RSD", acceptance: "" })).toBe(true);
  });
  it("stands down once criteria exist, and ignores tasks", () => {
    const acceptance = JSON.stringify({ criteria: [{ op: "lt", value: 0.15, unit: "%RSD" }] });
    expect(needsAcceptanceReview({ kind: "test", resultType: "measured", target: "x", acceptance })).toBe(false);
    expect(needsAcceptanceReview({ kind: "task", resultType: "pass_fail", name: "Tighten to <5 Nm", acceptance: "" })).toBe(false);
  });
});
