import { describe, it, expect } from "vitest";
import { matchRules, type CheckoutRule } from "@/lib/checkout";

const r = (kind: string, modelMatch: string, title: string, sortOrder = 0): CheckoutRule => ({
  kind,
  modelMatch,
  title,
  criteria: "",
  sortOrder,
});

const RULES = [
  r("Pump", "", "Leak/Pulse Check", 1),
  r("Pump", "", "Flow Check", 2),
  r("Pump", "LC-40", "Leak/Pulse Check (tight spec)", 1),
  r("Autosampler", "", "Temperature Check", 1),
  r("Full system", "", "Caffeine Checkout", 1),
];

describe("matchRules", () => {
  it("applies generic rules when no model filter matches", () => {
    const got = matchRules(RULES, "Pump", "LC-30AD");
    expect(got.map((x) => x.title)).toEqual(["Leak/Pulse Check", "Flow Check"]);
  });

  it("model-filtered rules replace the generic set for that kind", () => {
    const got = matchRules(RULES, "Pump", "LC-40D XR");
    expect(got.map((x) => x.title)).toEqual(["Leak/Pulse Check (tight spec)"]);
  });

  it("matches the model filter case-insensitively as a substring", () => {
    const got = matchRules(RULES, "Pump", "shimadzu lc-40d");
    expect(got.map((x) => x.title)).toEqual(["Leak/Pulse Check (tight spec)"]);
  });

  it("only considers rules for the requested kind", () => {
    const got = matchRules(RULES, "Autosampler", "SIL-40C");
    expect(got.map((x) => x.title)).toEqual(["Temperature Check"]);
  });

  it("returns nothing for kinds without rules", () => {
    expect(matchRules(RULES, "Degasser", "DGU-405")).toEqual([]);
  });

  it("Full system rules are untouched by other kinds' model filters", () => {
    const got = matchRules(RULES, "Full system", "LC-40 stack");
    expect(got.map((x) => x.title)).toEqual(["Caffeine Checkout"]);
  });

  it("sorts by sortOrder", () => {
    const got = matchRules(
      [r("Pump", "", "B", 2), r("Pump", "", "A", 1)],
      "Pump",
      ""
    );
    expect(got.map((x) => x.title)).toEqual(["A", "B"]);
  });
});
