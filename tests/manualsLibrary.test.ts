import { describe, expect, it } from "vitest";
import {
  allModels, buildManualTree, findMaker, findModel, findSeries, findType, makerLine, searchManuals,
  seriesLine, treeTotals, UNSORTED_MAKER, type ManualRef, type ModelTerm,
} from "@/lib/manualsLibrary";

const model = (id: number, assetType: string, name: string, manufacturer = "", series = ""): ModelTerm =>
  ({ id, assetType, name, manufacturer, series });

const ref = (id: number, over: Partial<ManualRef> = {}): ManualRef => ({
  id, assetType: "Mass spec", model: "", kind: "link", title: "", url: "", body: "", createdBy: "", ...over,
});

const CATALOG = [
  model(1, "Mass spec", "Exploris", "Thermo"),
  model(2, "Mass spec", "TSQ Altis", "Thermo", "TSQ"),
  model(7, "Mass spec", "TSQ Quantis", "Thermo", "tsq"),       // the family, spelled down
  model(3, "Autosampler", "TriPlus 500", "thermo"),           // the same maker, spelled down
  model(4, "Pump", "LC-20AD", "Shimadzu"),
  model(5, "Pump", "1260 Quat", "Agilent"),
  model(6, "Detector", "Mystery box"),                        // nobody said who makes it
];

const REFS = [
  ref(10, { model: "Exploris", title: "Exploris hardware manual" }),
  ref(11, { model: "exploris", title: "Exploris site prep" }),          // case differs from the catalog
  ref(12, { model: "TSQ Altis", title: "Altis-only firmware note" }),   // "otherwise stated"
  ref(16, { series: "TSQ", title: "TSQ series hardware manual" }),      // shared by every TSQ
  ref(13, { assetType: "Pump", model: "LC-20AD", title: "LC-20AD service" }),
  ref(14, { title: "Any mass spec: venting procedure" }),              // type-wide
  ref(15, { assetType: "GC", model: "Trace 1310", title: "Trace 1310 manual" }), // model not in the catalog
  ref(17, { assetType: "GC", series: "Trace", title: "Trace series manual" }),   // family nobody is in
];

describe("the manuals tree", () => {
  const tree = buildManualTree(CATALOG, REFS);

  it("shelves makers in name order, merging spellings, with the unsorted bucket last", () => {
    expect(tree.makers.map((m) => m.name)).toEqual(["Agilent", "Shimadzu", "Thermo", UNSORTED_MAKER]);
  });

  it("gives every catalog model a folder, filed or not", () => {
    const agilent = findMaker(tree, "agilent")!;
    expect(agilent.models.map((m) => m.model)).toEqual(["1260 Quat"]);
    expect(agilent.refCount).toBe(0);
    const thermo = findMaker(tree, "Thermo")!;
    // Loose models only here; the TSQs are inside their family.
    expect(thermo.models.map((m) => m.model)).toEqual(["Exploris", "TriPlus 500"]);
    expect(allModels(thermo).map((m) => m.model)).toEqual(["Exploris", "TriPlus 500", "TSQ Altis", "TSQ Quantis"]);
    expect(thermo.modelCount).toBe(4);
  });

  it("files a reference on its model whatever the case, and counts it on the maker", () => {
    const thermo = findMaker(tree, "Thermo")!;
    const exploris = thermo.models.find((m) => m.model === "Exploris")!;
    expect(exploris.refs.map((r) => r.id)).toEqual([10, 11]);
    expect(exploris.termId).toBe(1);
    expect(exploris.key).toBe("1");
    // Two on the Exploris, one on the Altis alone, one on the TSQ family.
    expect(thermo.refCount).toBe(4);
  });

  it("gathers a family: its own manuals, and its models with theirs", () => {
    const thermo = findMaker(tree, "Thermo")!;
    expect(thermo.series.map((s) => s.name)).toEqual(["TSQ"]);
    const tsq = findSeries(tree, "thermo", "TSQ")!.series;
    expect(tsq.assetTypes).toEqual(["Mass spec"]);
    expect(tsq.models.map((m) => m.model)).toEqual(["TSQ Altis", "TSQ Quantis"]);
    // The shared manual is on the family, not copied onto each model.
    expect(tsq.refs.map((r) => r.id)).toEqual([16]);
    // The Altis-only note stays on the Altis.
    expect(tsq.models[0].refs.map((r) => r.id)).toEqual([12]);
    expect(tsq.models[1].refs).toEqual([]);
    expect(tsq.refCount).toBe(2);
    expect(seriesLine(tsq)).toBe("2 models · 2 manuals");
  });

  it("keeps a maker-less model, an uncatalogued model and an orphan family in the unsorted bucket rather than dropping them", () => {
    const unsorted = findMaker(tree, UNSORTED_MAKER)!;
    expect(unsorted.models.map((m) => m.model)).toEqual(["Mystery box", "Trace 1310"]);
    const trace = unsorted.models.find((m) => m.model === "Trace 1310")!;
    expect(trace.termId).toBeNull();
    expect(trace.key).toBe("GC|Trace 1310");
    expect(trace.refs.map((r) => r.id)).toEqual([15]);
    // A family manual with no model in that family waits here too.
    expect(unsorted.series.map((s) => s.name)).toEqual(["Trace"]);
    expect(unsorted.series[0].refs.map((r) => r.id)).toEqual([17]);
    expect(unsorted.series[0].models).toEqual([]);
    expect(unsorted.refCount).toBe(2);
  });

  it("keeps type-wide references on their own shelf", () => {
    expect(tree.types.map((t) => t.assetType)).toEqual(["Mass spec"]);
    expect(findType(tree, "mass spec")!.refs.map((r) => r.id)).toEqual([14]);
    // Not counted against any maker.
    expect(tree.makers.reduce((n, m) => n + m.refCount, 0)).toBe(7);
  });

  it("finds a model by its URL key, with its maker and family", () => {
    const altis = findModel(tree, "2")!;
    expect(altis.maker.name).toBe("Thermo");
    expect(altis.series?.name).toBe("TSQ");
    const exploris = findModel(tree, "1")!;
    expect(exploris.series).toBeNull();
    expect(findModel(tree, "GC|Trace 1310")!.maker.name).toBe(UNSORTED_MAKER);
    expect(findModel(tree, "nope")).toBeNull();
    expect(findModel(tree, undefined)).toBeNull();
    expect(findSeries(tree, "Thermo", "ISQ")).toBeNull();
  });

  it("totals the tiles without counting the unsorted bucket as a maker", () => {
    expect(treeTotals(tree)).toEqual({ makers: 3, models: 8, manuals: 8 });
  });

  it("writes a maker's card line", () => {
    expect(makerLine(findMaker(tree, "Thermo")!)).toBe("4 models · 4 manuals");
    expect(makerLine(findMaker(tree, "Agilent")!)).toBe("1 model · 0 manuals");
  });

  it("builds an empty tree from an empty catalog", () => {
    expect(buildManualTree([], [])).toEqual({ makers: [], types: [] });
  });
});

describe("searching the library", () => {
  const tree = buildManualTree(CATALOG, REFS);

  it("finds by the manual's words and by where it is shelved", () => {
    expect(searchManuals(tree, "site prep").map((h) => h.ref.id)).toEqual([11]);
    // The maker's name reaches every manual under it, family manuals included.
    expect(searchManuals(tree, "thermo").map((h) => h.ref.id).sort()).toEqual([10, 11, 12, 16]);
    // A type-wide reference is found by its type and says where it lives.
    const hit = searchManuals(tree, "venting")[0];
    expect(hit.ref.id).toBe(14);
    expect(hit.maker).toBeNull();
    expect(hit.where).toBe("any mass spec");
  });

  it("says where a hit is shelved so the result can be a door", () => {
    const [hit] = searchManuals(tree, "LC-20AD");
    expect(hit.where).toBe("Shimadzu / LC-20AD");
    expect(hit.maker).toBe("Shimadzu");
    expect(hit.modelKey).toBe("4");
    // The family's name finds its manual and every model manual inside it.
    const tsq = searchManuals(tree, "tsq");
    expect(tsq.map((h) => h.ref.id)).toEqual([16, 12]);
    expect(tsq[0].where).toBe("Thermo / every TSQ");
    expect(tsq[0].series).toBe("TSQ");
    expect(tsq[0].modelKey).toBeNull();
  });

  it("returns nothing for a blank query", () => {
    expect(searchManuals(tree, "  ")).toEqual([]);
  });
});
