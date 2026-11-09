import { describe, expect, it } from "vitest";
import { refCovers, refsForUnits, refScopeLabel, looksLikeImage, withSeries } from "@/lib/catalogRefs";

const ref = (over: Partial<Parameters<typeof refsForUnits>[0][number]> = {}) => ({
  id: 1, assetType: "Mass Spec", model: "", kind: "link",
  title: "", url: "", body: "", createdBy: "", ...over,
});

describe("which references reach which equipment", () => {
  it("a model-filed reference reaches only that model, case-insensitively", () => {
    const altis = ref({ model: "Thermo Altis" });
    expect(refCovers(altis, { kind: "Mass Spec", model: "thermo altis" })).toBe(true);
    expect(refCovers(altis, { kind: "Mass Spec", model: "TSQ 8000" })).toBe(false);
    expect(refCovers(altis, { kind: "Pump", model: "Thermo Altis" })).toBe(false);
  });

  it("a type-filed reference reaches every model of the type", () => {
    const anyMs = ref({ model: "" });
    expect(refCovers(anyMs, { kind: "Mass Spec", model: "Thermo Altis" })).toBe(true);
    expect(refCovers(anyMs, { kind: "Mass Spec", model: "" })).toBe(true);
    expect(refCovers(anyMs, { kind: "Autosampler", model: "ASI-V" })).toBe(false);
  });

  it("a system's shelf is the union over its modules, kept in stored order", () => {
    const rows = [
      ref({ id: 1, model: "Thermo Altis", title: "Altis service manual" }),
      ref({ id: 2, assetType: "Autosampler", model: "", title: "Sampler prep" }),
      ref({ id: 3, assetType: "Pump", model: "LC-20ADXR", title: "LC-20 seals" }),
    ];
    const units = [
      { kind: "Mass Spec", model: "Thermo Altis" },
      { kind: "Autosampler", model: "TriPlus 500" },
      { kind: "Pump", model: "LC-30ADSF" }, // not the LC-20 - its note stays away
    ];
    expect(refsForUnits(rows, units).map((r) => r.id)).toEqual([1, 2]);
  });

  it("labels where a reference is filed", () => {
    expect(refScopeLabel(ref({ model: "Thermo Altis" }))).toBe("Thermo Altis");
    expect(refScopeLabel(ref({ model: "" }))).toBe("any mass spec");
  });

  it("guesses image-ness from the URL, query strings included", () => {
    expect(looksLikeImage("https://blob.example/x.png")).toBe(true);
    expect(looksLikeImage("https://blob.example/x.JPG?token=1")).toBe(true);
    expect(looksLikeImage("https://thermo.example/manual.pdf")).toBe(false);
  });
});

describe("families: every ISQ shares the ISQ manuals unless otherwise stated", () => {
  const rows = [
    ref({ id: 1, model: "", series: "ISQ", title: "ISQ hardware manual" }),
    ref({ id: 2, model: "ISQ 7610", title: "7610-only firmware note" }),
    ref({ id: 3, model: "", title: "Venting any mass spec" }),
  ];

  it("a series-filed reference reaches every model in the family and no other", () => {
    const shared = rows[0];
    expect(refCovers(shared, { kind: "Mass spec", model: "ISQ 7000", series: "ISQ" })).toBe(true);
    expect(refCovers(shared, { kind: "Mass spec", model: "ISQ 7610", series: "isq" })).toBe(true);
    expect(refCovers(shared, { kind: "Mass spec", model: "TSQ Altis", series: "TSQ" })).toBe(false);
    // A unit with no family sees nothing filed on one.
    expect(refCovers(shared, { kind: "Mass spec", model: "Exploris" })).toBe(false);
    // The type still has to match - a family name is not a type.
    expect(refCovers(shared, { kind: "Autosampler", model: "ISQ thing", series: "ISQ" })).toBe(false);
  });

  it("a model-filed reference stays on its model - that is the 'otherwise stated'", () => {
    expect(refsForUnits(rows, [{ kind: "Mass spec", model: "ISQ 7000", series: "ISQ" }]).map((r) => r.id)).toEqual([1, 3]);
    expect(refsForUnits(rows, [{ kind: "Mass spec", model: "ISQ 7610", series: "ISQ" }]).map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("gives units their family from the catalog, by type and model, case-insensitively", () => {
    const models = [
      { assetType: "Mass spec", name: "ISQ 7000", series: "ISQ" },
      { assetType: "Mass spec", name: "Exploris", series: "" },
    ];
    const units = withSeries(
      [{ kind: "mass spec", model: "isq 7000" }, { kind: "Mass spec", model: "Exploris" }, { kind: "GC", model: "Trace" }],
      models,
    );
    expect(units[0].series).toBe("ISQ");
    expect(units[1].series).toBeUndefined();
    expect(units[2].series).toBeUndefined();
  });

  it("labels the middle scope", () => {
    expect(refScopeLabel(ref({ model: "", series: "ISQ" }))).toBe("every ISQ");
    expect(refScopeLabel(ref({ model: "ISQ 7610", series: "ISQ" }))).toBe("ISQ 7610");
  });
});
