import { describe, expect, it } from "vitest";
import { modelsForType, moduleTypeOptions } from "@/lib/moduleTypes";
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

describe("modelsForType", () => {
  const models = [
    { assetType: "Mass Spec", name: "TSQ 8000", manufacturer: "Thermo" },
    { assetType: "mass spec", name: "Quattro Ultima", manufacturer: "Waters" },
    { assetType: "Pump", name: "1290 Quat", manufacturer: "Agilent" },
    { assetType: "Mass Spec", name: "  ", manufacturer: "Thermo" },
  ];

  it("matches the type however either side spelled it", () => {
    expect(modelsForType(models, "mass  spec".replace("  ", " ")).map((m) => m.name))
      .toEqual(["TSQ 8000", "Quattro Ultima"]);
    expect(modelsForType(models, " Pump ").map((m) => m.name)).toEqual(["1290 Quat"]);
  });

  it("groups by maker and drops nameless rows", () => {
    expect(modelsForType(models, "Mass Spec").map((m) => `${m.manufacturer} ${m.name}`))
      .toEqual(["Thermo TSQ 8000", "Waters Quattro Ultima"]);
  });

  it("answers nothing for no type and for a type nobody catalogued", () => {
    expect(modelsForType(models, "")).toEqual([]);
    expect(modelsForType(models, "Degasser")).toEqual([]);
  });
});
