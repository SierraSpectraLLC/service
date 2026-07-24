import { describe, it, expect } from "vitest";
import { parseSpecs, serializeSpecs, SPECS_MAX_PAIRS } from "@/lib/partSpecs";

describe("parseSpecs / serializeSpecs", () => {
  it("round-trips label/value pairs", () => {
    const pairs = [{ k: "ID", v: "0.25 mm" }, { k: "Length", v: "30 m" }];
    expect(parseSpecs(serializeSpecs(pairs))).toEqual(pairs);
  });
  it("parses garbage to an empty list", () => {
    expect(parseSpecs("not json")).toEqual([]);
    expect(parseSpecs('{"k":"a"}')).toEqual([]);
    expect(parseSpecs("")).toEqual([]);
  });
  it("drops empty rows and coerces non-strings", () => {
    expect(parseSpecs('[{"k":"","v":""},{"k":"Film","v":0.25}]')).toEqual([{ k: "Film", v: "0.25" }]);
    expect(serializeSpecs([{ k: "  ", v: "" }, { k: "ID", v: " 0.25 mm " }])).toBe('[{"k":"ID","v":"0.25 mm"}]');
  });
  it("caps the number of pairs", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ k: `k${i}`, v: "x" }));
    expect(parseSpecs(serializeSpecs(many))).toHaveLength(SPECS_MAX_PAIRS);
  });
  it("serializes an empty list to an empty string (column default)", () => {
    expect(serializeSpecs([])).toBe("");
  });
});
