import { describe, expect, it } from "vitest";
import { moduleTypeOptions } from "@/lib/moduleTypes";
import { MODULE_KINDS } from "@/lib/stages";

describe("moduleTypeOptions", () => {
  it("offers the shop's own catalog, alphabetically", () => {
    expect(moduleTypeOptions(["Mass Spec", "Autosampler", "Column Oven"]))
      .toEqual(["Autosampler", "Column Oven", "Mass Spec"]);
  });

  it("falls back to the starter list when the catalog is empty", () => {
    expect(moduleTypeOptions([])).toEqual([...MODULE_KINDS]);
    expect(moduleTypeOptions(["", "   "])).toEqual([...MODULE_KINDS]);
  });

  it("keeps a value the catalog no longer defines selectable", () => {
    const out = moduleTypeOptions(["Pump", "Detector"], "N2 generator");
    expect(out).toEqual(["Detector", "Pump", "N2 generator"]);
  });

  it("never lists the current value twice, whatever its case", () => {
    expect(moduleTypeOptions(["Pump", "Detector"], "pump")).toEqual(["Detector", "Pump"]);
    expect(moduleTypeOptions(["Pump", "Pump ", "Detector"])).toEqual(["Detector", "Pump"]);
  });
});
