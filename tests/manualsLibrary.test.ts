import { describe, expect, it } from "vitest";
import {
  buildManualTree, findMaker, findModel, findType, makerLine, searchManuals, treeTotals,
  UNSORTED_MAKER, type ManualRef, type ModelTerm,
} from "@/lib/manualsLibrary";

const model = (id: number, assetType: string, name: string, manufacturer = ""): ModelTerm =>
  ({ id, assetType, name, manufacturer });

const ref = (id: number, over: Partial<ManualRef> = {}): ManualRef => ({
  id, assetType: "Mass spec", model: "", kind: "link", title: "", url: "", body: "", createdBy: "", ...over,
});

const CATALOG = [
  model(1, "Mass spec", "Exploris", "Thermo"),
  model(2, "Mass spec", "TSQ", "Thermo"),
  model(3, "Autosampler", "TriPlus 500", "thermo"),   // the same maker, spelled down
  model(4, "Pump", "LC-20AD", "Shimadzu"),
  model(5, "Pump", "1260 Quat", "Agilent"),
  model(6, "Detector", "Mystery box"),               // nobody said who makes it
];

const REFS = [
  ref(10, { model: "Exploris", title: "Exploris hardware manual" }),
  ref(11, { model: "exploris", title: "Exploris site prep" }),          // case differs from the catalog
  ref(12, { model: "TSQ", title: "TSQ Altis manual" }),
  ref(13, { assetType: "Pump", model: "LC-20AD", title: "LC-20AD service" }),
  ref(14, { title: "Any mass spec: venting procedure" }),              // type-wide
  ref(15, { assetType: "GC", model: "Trace 1310", title: "Trace 1310 manual" }), // model not in the catalog
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
    expect(thermo.models.map((m) => m.model)).toEqual(["Exploris", "TriPlus 500", "TSQ"]);
  });

  it("files a reference on its model whatever the case, and counts it on the maker", () => {
    const thermo = findMaker(tree, "Thermo")!;
    const exploris = thermo.models.find((m) => m.model === "Exploris")!;
    expect(exploris.refs.map((r) => r.id)).toEqual([10, 11]);
    expect(exploris.termId).toBe(1);
    expect(exploris.key).toBe("1");
    expect(thermo.refCount).toBe(3);
  });

  it("keeps a maker-less model and an uncatalogued model in the unsorted bucket rather than dropping them", () => {
    const unsorted = findMaker(tree, UNSORTED_MAKER)!;
    expect(unsorted.models.map((m) => m.model)).toEqual(["Mystery box", "Trace 1310"]);
    const trace = unsorted.models.find((m) => m.model === "Trace 1310")!;
    expect(trace.termId).toBeNull();
    expect(trace.key).toBe("GC|Trace 1310");
    expect(trace.refs.map((r) => r.id)).toEqual([15]);
  });

  it("keeps type-wide references on their own shelf", () => {
    expect(tree.types.map((t) => t.assetType)).toEqual(["Mass spec"]);
    expect(findType(tree, "mass spec")!.refs.map((r) => r.id)).toEqual([14]);
    // Not counted against any maker.
    expect(tree.makers.reduce((n, m) => n + m.refCount, 0)).toBe(5);
  });

  it("finds a model by its URL key, with its maker", () => {
    expect(findModel(tree, "2")!.maker.name).toBe("Thermo");
    expect(findModel(tree, "GC|Trace 1310")!.maker.name).toBe(UNSORTED_MAKER);
    expect(findModel(tree, "nope")).toBeNull();
    expect(findModel(tree, undefined)).toBeNull();
  });

  it("totals the tiles without counting the unsorted bucket as a maker", () => {
    expect(treeTotals(tree)).toEqual({ makers: 3, models: 7, manuals: 6 });
  });

  it("writes a maker's card line", () => {
    expect(makerLine(findMaker(tree, "Thermo")!)).toBe("3 models · 3 manuals");
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
    // The maker's name reaches every manual under it.
    expect(searchManuals(tree, "thermo").map((h) => h.ref.id)).toEqual([10, 11, 12]);
    // A type-wide reference is found by its type and says where it lives.
    const hit = searchManuals(tree, "venting")[0];
    expect(hit.ref.id).toBe(14);
    expect(hit.maker).toBeNull();
    expect(hit.where).toBe("any mass spec");
  });

  it("says where a model hit is shelved so the result can be a door", () => {
    const [hit] = searchManuals(tree, "LC-20AD");
    expect(hit.where).toBe("Shimadzu / LC-20AD");
    expect(hit.maker).toBe("Shimadzu");
    expect(hit.modelKey).toBe("4");
  });

  it("returns nothing for a blank query", () => {
    expect(searchManuals(tree, "  ")).toEqual([]);
  });
});
