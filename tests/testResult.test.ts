import { describe, expect, it } from "vitest";
import {
  completionBlocked, evaluateResult, firstNumber, resultIsRecorded, toleranceBand,
} from "@/lib/testResult";

const measured = { resultType: "measured", target: "5 mL/min", tolerancePct: "10" };

describe("reading the number off a value written the way it is read", () => {
  it("finds it next to its unit, with a sign or an exponent", () => {
    expect(firstNumber("5 mL/min")).toBe(5);
    expect(firstNumber("-0.4 C")).toBe(-0.4);
    expect(firstNumber("1.2e3 counts")).toBe(1200);
    expect(firstNumber("psi 32")).toBe(32);
  });

  it("gives back nothing rather than a guess", () => {
    expect(firstNumber("")).toBeNull();
    expect(firstNumber(null)).toBeNull();
    expect(firstNumber("no reading")).toBeNull();
  });
});

describe("judging a measured test", () => {
  it("passes inside the band and fails outside it", () => {
    expect(evaluateResult(measured, "5.2 mL/min").passed).toBe(true);
    expect(evaluateResult(measured, "5.5").passed).toBe(true);   // the edge is in
    expect(evaluateResult(measured, "5.6").passed).toBe(false);
    expect(evaluateResult(measured, "4.4").passed).toBe(false);
  });

  it("says which band, so the number means something to whoever reads it later", () => {
    expect(evaluateResult(measured, "5.6").why).toBe("5.6 - outside 4.5 to 5.5");
    expect(toleranceBand(measured)).toBe("4.5 to 5.5");
  });

  it("refuses to invent a band nobody set", () => {
    // Recording the number is still worth doing; calling it a pass would be
    // this code deciding what "close enough" means for an instrument it knows
    // nothing about.
    const v = evaluateResult({ ...measured, tolerancePct: null }, "5.2");
    expect(v.passed).toBeNull();
    expect(v.why).toContain("no tolerance set");
    expect(evaluateResult({ ...measured, target: null }, "5.2").passed).toBeNull();
    expect(toleranceBand({ ...measured, tolerancePct: "0" })).toBe("");
  });

  it("handles a negative target without flipping the band", () => {
    const cold = { resultType: "measured", target: "-40 C", tolerancePct: "10" };
    expect(toleranceBand(cold)).toBe("-44 to -36");
    expect(evaluateResult(cold, "-38").passed).toBe(true);
  });
});

describe("the other result types", () => {
  it("turns pass/fail into a verdict, whatever the casing", () => {
    expect(evaluateResult({ resultType: "pass_fail", target: null, tolerancePct: null }, "PASS").passed).toBe(true);
    expect(evaluateResult({ resultType: "pass_fail", target: null, tolerancePct: null }, "fail").passed).toBe(false);
  });

  it("records a reading or a note without judging it", () => {
    expect(evaluateResult({ resultType: "reading", target: null, tolerancePct: null }, "1240 counts"))
      .toEqual({ passed: null, why: "1240 counts" });
    expect(evaluateResult({ resultType: "note", target: null, tolerancePct: null }, "lamp at 812 h").passed).toBeNull();
  });
});

describe("what counts as recorded", () => {
  it("wants a number where a number is the point", () => {
    expect(resultIsRecorded("measured", "5.2")).toBe(true);
    expect(resultIsRecorded("measured", "looked fine")).toBe(false);
    expect(resultIsRecorded("pass_fail", "Pass")).toBe(true);
    expect(resultIsRecorded("pass_fail", "maybe")).toBe(false);
    expect(resultIsRecorded("note", "lamp at 812 h")).toBe(true);
    expect(resultIsRecorded("note", "   ")).toBe(false);
  });
});

describe("what blocks a task from closing", () => {
  it("is only ever a test with no result", () => {
    expect(completionBlocked({ kind: "test", resultType: "measured" }, null)).not.toBe("");
    expect(completionBlocked({ kind: "test", resultType: "measured" }, { value: "" })).not.toBe("");
    expect(completionBlocked({ kind: "test", resultType: "measured" }, { value: "5.2" })).toBe("");
  });

  it("never blocks ordinary work, and never blocks a failure", () => {
    // A failed test is a finished test - the number is the point, and holding
    // the task open would file the failure somewhere nobody looks.
    expect(completionBlocked({ kind: "task", resultType: "pass_fail" }, null)).toBe("");
    expect(completionBlocked({ kind: "test", resultType: "pass_fail" }, { value: "Fail" })).toBe("");
  });
});
