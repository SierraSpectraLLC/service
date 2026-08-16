import { describe, expect, it } from "vitest";
import {
  gasesForSystem, gasesForSystemWithUnits, gasesForUnit, missingGases,
} from "@/lib/catalogGas";

const terms = [
  { kind: "model", assetType: "Mass Spec", name: "Thermo Altis", gases: ["Nitrogen", "Argon"] },
  { kind: "asset_type", assetType: "", name: "Mass Spec", gases: ["Nitrogen"] },
  { kind: "category", assetType: "", name: "LC-MS", gases: ["Nitrogen"] },
  { kind: "model", assetType: "Pump", name: "LC-20ADXR", gases: [] },
];

describe("what the catalog says a unit needs", () => {
  it("takes the model's gases and its type's, not one or the other", () => {
    // "Every mass spec needs nitrogen" and "an Altis also needs argon" are both
    // true; picking one would silently drop the other.
    expect(gasesForUnit(terms, { kind: "Mass Spec", model: "Thermo Altis" }))
      .toEqual(["Nitrogen", "Argon"]);
  });

  it("still covers a model nobody has described, via its type", () => {
    expect(gasesForUnit(terms, { kind: "Mass Spec", model: "TSQ 8000" })).toEqual(["Nitrogen"]);
  });

  it("says nothing for equipment with no declaration", () => {
    expect(gasesForUnit(terms, { kind: "Pump", model: "LC-20ADXR" })).toEqual([]);
    expect(gasesForUnit(terms, { kind: "Degasser", model: "DGU-20A" })).toEqual([]);
  });

  it("matches case-insensitively, like every other catalog lookup", () => {
    expect(gasesForUnit(terms, { kind: "mass spec", model: "thermo altis" }))
      .toEqual(["Nitrogen", "Argon"]);
  });
});

describe("what a system needs", () => {
  it("is its own type's requirement plus everything installed in it", () => {
    // A system is a stack of equipment, so its requirement is the union - and
    // nitrogen named by both the system type and the Altis appears once.
    expect(gasesForSystemWithUnits(terms, "LC-MS", [
      { kind: "Mass Spec", model: "Thermo Altis" },
      { kind: "Pump", model: "LC-20ADXR" },
    ])).toEqual(["Nitrogen", "Argon"]);
  });

  it("covers a system with no modules entered yet", () => {
    expect(gasesForSystem(terms, "LC-MS")).toEqual(["Nitrogen"]);
    expect(gasesForSystem(terms, "GC-MS")).toEqual([]);
    expect(gasesForSystem(terms, "")).toEqual([]);
  });
});

describe("what actually gets added", () => {
  it("is only what the record is missing, so a set status is never rewritten", () => {
    expect(missingGases(["Nitrogen", "Argon"], ["nitrogen"])).toEqual(["Argon"]);
    expect(missingGases(["Nitrogen"], ["Nitrogen"])).toEqual([]);
    expect(missingGases([], ["Helium"])).toEqual([]);
  });
});
