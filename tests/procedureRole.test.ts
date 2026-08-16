import { describe, expect, it } from "vitest";
import { coversSystem, procedureRole, ROLE_LABEL, scopeLabel } from "@/lib/procedureRole";

describe("what a procedure is, in one word", () => {
  it("names the three the shop actually says", () => {
    expect(procedureRole({ runsAtIntake: true, intervalDays: null })).toBe("checkout");
    expect(procedureRole({ runsAtIntake: false, intervalDays: 90 })).toBe("maintenance");
    expect(procedureRole({ runsAtIntake: true, intervalDays: 90 })).toBe("both");
  });

  it("says so when a procedure would never run at all", () => {
    // The form refuses to save one, but a row can predate that rule. A badge
    // is how somebody finds it; silence is how it sits there for a year.
    expect(procedureRole({ runsAtIntake: false, intervalDays: null })).toBe("none");
    expect(ROLE_LABEL.none).toBe("Never runs");
  });

  it("reads a zero-day interval as a real cadence, not as absent", () => {
    // 0 is falsy and null is not. Getting this wrong would label a daily check
    // "Checkout" and stop it being counted as maintenance anywhere.
    expect(procedureRole({ runsAtIntake: false, intervalDays: 0 })).toBe("maintenance");
  });
});

describe("which systems a system-level procedure covers", () => {
  it("covers only its categories once it has any", () => {
    expect(coversSystem(["LC-MS"], "LC-MS")).toBe(true);
    // The bug this exists to fix: an annual LC-MS PM landing on every GC.
    expect(coversSystem(["LC-MS"], "GC-MS")).toBe(false);
  });

  it("covers everything when nothing is named", () => {
    // Every system procedure defined before the scope column meant this, so the
    // default has to keep meaning it or a deploy unschedules real work.
    expect(coversSystem([], "GC-MS")).toBe(true);
    expect(coversSystem([], "")).toBe(true);
  });

  it("matches case- and space-blind, because categories are typed by hand", () => {
    expect(coversSystem([" lc-ms "], "LC-MS")).toBe(true);
    expect(coversSystem(["LC-MS", "GC"], "gc")).toBe(true);
  });

  it("does not cover an uncategorized system when a scope is named", () => {
    expect(coversSystem(["LC-MS"], "")).toBe(false);
  });
});

describe("how the scope reads", () => {
  it("names the categories, or says it is everything", () => {
    expect(scopeLabel(["LC-MS"], "all systems")).toBe(" (LC-MS only)");
    expect(scopeLabel([], "all systems")).toBe(" (all systems)");
  });
});
