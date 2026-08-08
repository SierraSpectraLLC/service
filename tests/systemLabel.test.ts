import { describe, it, expect } from "vitest";
import { composeSystemLabel } from "@/lib/systemLabel";

const a = (kind: string, model: string, sortOrder = 0) => ({ kind, model, sortOrder });

describe("composeSystemLabel", () => {
  it("joins asset models in display order", () => {
    expect(composeSystemLabel([
      a("Mass spec", "LCMS-8050", 1),
      a("Pump", "LC-40", 2),
      a("Autosampler", "SIL-40", 3),
    ])).toBe("LCMS-8050 + LC-40 + SIL-40");
  });

  it("respects sort order regardless of input order", () => {
    expect(composeSystemLabel([a("Pump", "LC-40", 2), a("Mass spec", "LCMS-8050", 1)]))
      .toBe("LCMS-8050 + LC-40");
  });

  it("collapses repeats into a count", () => {
    expect(composeSystemLabel([a("Pump", "LC-40D", 1), a("Pump", "LC-40D", 2), a("Detector", "SPD-40", 3)]))
      .toBe("LC-40D x2 + SPD-40");
  });

  it("falls back to the asset kind when it has no model", () => {
    expect(composeSystemLabel([a("Mass spec", ""), a("Pump", "LC-40", 1)])).toBe("Mass spec + LC-40");
  });

  it("uses the legacy description when the system has no assets yet", () => {
    expect(composeSystemLabel([], "Shimadzu LCMS-8050 + LC-40")).toBe("Shimadzu LCMS-8050 + LC-40");
    expect(composeSystemLabel([], "  padded  ")).toBe("padded");
  });

  it("is empty when there is nothing to go on", () => {
    expect(composeSystemLabel([])).toBe("");
    expect(composeSystemLabel([a("", "")], "")).toBe("");
  });
});
