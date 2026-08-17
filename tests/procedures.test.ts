import { describe, expect, it } from "vitest";
import {
  describeProcedure, parseProcParts, partQty, partsForModel, serializeProcParts, schedulePartsOf, partLabel,
} from "@/lib/procedures";
import { matchItems } from "@/lib/checkout";

const base = { assetType: "Pump", runsAtIntake: false, intervalDays: null as number | null, modelScope: [] as string[], parts: [] };

describe("the live sentence", () => {
  it("covers the four timing shapes", () => {
    expect(describeProcedure({ ...base, runsAtIntake: true })).toBe("Runs once at intake on every pump.");
    expect(describeProcedure({ ...base, intervalDays: 90 })).toBe("Runs quarterly on every pump.");
    expect(describeProcedure({ ...base, runsAtIntake: true, intervalDays: 90 }))
      .toBe("Runs at intake and quarterly on every pump.");
    // Never fires: the caller shows the error, not a sentence.
    expect(describeProcedure(base)).toBeNull();
  });

  it("names the scope and the parts", () => {
    expect(describeProcedure({ ...base, runsAtIntake: true, modelScope: ["LC-20AD"] }))
      .toBe("Runs once at intake on LC-20AD.");
    expect(describeProcedure({
      ...base, intervalDays: 90, modelScope: ["LC-20AD"],
      parts: [{ name: "Plunger seal kit", number: "228-35145-91" }],
    })).toBe("Runs quarterly on LC-20AD. Takes Plunger seal kit PN 228-35145-91.");
    expect(describeProcedure({ ...base, assetType: "system", runsAtIntake: true }))
      .toBe("Runs once at intake on every system.");
  });

  it("narrows a system procedure by category, not by model", () => {
    // A system is not one model, it is a stack of them - so the thing that
    // narrows it is the system's category. Without this an annual LC-MS PM
    // landed on every GC in the workspace.
    expect(describeProcedure({
      ...base, assetType: "system", intervalDays: 365, categoryScope: ["LC-MS"],
    })).toBe("Runs yearly on every LC-MS system.");
    expect(describeProcedure({
      ...base, assetType: "system", intervalDays: 365, categoryScope: ["LC-MS", "GC-MS"],
    })).toBe("Runs yearly on every LC-MS, GC-MS system.");
    // No categories still means all of them, which is what every system
    // procedure meant before the scope existed.
    expect(describeProcedure({ ...base, assetType: "system", intervalDays: 365 }))
      .toBe("Runs yearly on every system.");
  });
});

describe("parts round-trip", () => {
  it("serializes clean and parses tolerantly", () => {
    const round = parseProcParts(serializeProcParts([
      { name: " Seal kit ", number: " 228-35145-91 " },
      { name: "", number: "" }, // an empty row someone forgot to remove
    ]));
    expect(round).toEqual([{ name: "Seal kit", number: "228-35145-91" }]);
    expect(serializeProcParts([])).toBe("");
    expect(parseProcParts("")).toEqual([]);
    expect(parseProcParts("not json")).toEqual([]);
    expect(parseProcParts('{"a":1}')).toEqual([]);
  });

  it("a schedule's parts fall back to the legacy single pair", () => {
    expect(schedulePartsOf({ parts: "", partName: "Seal kit", partNumber: "228" }))
      .toEqual([{ name: "Seal kit", number: "228" }]);
    expect(schedulePartsOf({ parts: '[{"name":"","number":"999"}]', partName: "old", partNumber: "old" }))
      .toEqual([{ name: "", number: "999" }]);
    expect(schedulePartsOf({ parts: "", partName: "", partNumber: "" })).toEqual([]);
    expect(partLabel({ name: "", number: "999" })).toBe("PN 999");
    expect(partLabel({ name: "Ferrule", number: "" })).toBe("Ferrule");
  });
});

describe("how many the job takes", () => {
  // An MS120's annual oil change needs two bottles of AVF Gold. One bottle
  // arriving is the job not getting done.
  const oil = { name: "AVF Gold", number: "AVF-1L", qty: 2 };

  it("carries the count through a round-trip", () => {
    expect(parseProcParts(serializeProcParts([oil]))).toEqual([oil]);
  });

  it("leaves a single-quantity part byte-identical to a pre-quantity one", () => {
    // The key is absent at 1, so every procedure written before this existed
    // serializes exactly as it always did.
    expect(serializeProcParts([{ name: "Ferrule", number: "F-1" }]))
      .toBe('[{"name":"Ferrule","number":"F-1"}]');
    expect(serializeProcParts([{ name: "Ferrule", number: "F-1", qty: 1 }]))
      .toBe('[{"name":"Ferrule","number":"F-1"}]');
  });

  it("reads every nonsense quantity as one, never as none", () => {
    // A part on the list is needed. Ordering zero of it is the one answer that
    // cannot be right, so nothing may produce it.
    for (const qty of [0, -3, 0.5, NaN, Infinity, undefined]) {
      expect(partQty({ qty })).toBe(1);
    }
    expect(partQty({ qty: 2.9 })).toBe(2);
    expect(partQty({ qty: 100000 })).toBe(999);
  });

  it("leads the label with the count, and stays quiet at one", () => {
    expect(partLabel(oil)).toBe("2 × AVF Gold PN AVF-1L");
    expect(partLabel({ name: "Ferrule", number: "F-1" })).toBe("Ferrule PN F-1");
    expect(partLabel({ name: "Ferrule", number: "", qty: 3 })).toBe("3 × Ferrule");
  });

  it("says it in the sentence the editor shows", () => {
    expect(describeProcedure({
      assetType: "Vacuum pump", runsAtIntake: false, intervalDays: 365,
      modelScope: ["MS120"], parts: [oil],
    })).toBe("Runs yearly on MS120. Takes 2 × AVF Gold PN AVF-1L.");
  });
});

describe("per-model parts on one procedure", () => {
  // "Inspect plunger seals" is ONE procedure on every pump; the kit differs by
  // model. Each part row says which models it fits, and stamp time picks the
  // right one for the unit in hand.
  const mapping = [
    { name: "Seal kit", number: "X-10", models: ["LC-10"] },
    { name: "Seal kit", number: "Y-20", models: ["LC-20", "LC-20AD"] },
    { name: "Grease", number: "G-1" }, // untagged = every model
  ];

  it("round-trips the model tags, omitting empty ones", () => {
    const round = parseProcParts(serializeProcParts(mapping));
    expect(round).toEqual(mapping);
    // No tags = the key is absent, so pre-models data is byte-identical.
    expect(serializeProcParts([{ name: "Ferrule", number: "F-1", models: [] }]))
      .toBe('[{"name":"Ferrule","number":"F-1"}]');
  });

  it("a unit gets the parts tagged for its model, plus the untagged ones", () => {
    expect(partsForModel(mapping, "LC-20AD").map((p) => p.number)).toEqual(["Y-20", "G-1"]);
    expect(partsForModel(mapping, "lc-10").map((p) => p.number)).toEqual(["X-10", "G-1"]);
    // A model in nobody's tags still gets the universal parts.
    expect(partsForModel(mapping, "LC-30").map((p) => p.number)).toEqual(["G-1"]);
  });

  it("the live sentence names which models each part fits", () => {
    expect(describeProcedure({
      assetType: "Pump", runsAtIntake: false, intervalDays: 180, modelScope: [],
      parts: [{ name: "Seal kit", number: "X-10", models: ["LC-10"] }],
    })).toBe("Runs every 6 months on every pump. Takes Seal kit PN X-10 (LC-10).");
  });
});

describe("one row, two engines", () => {
  // A merged procedure that runs at intake AND quarterly goes through both
  // generators. Intake keeps checkout's replace-semantics; this locks that a
  // procedures-shaped row still behaves in matchItems.
  const proc = (over: { id: number; name?: string; kind?: string; modelScope?: string[] }) => ({
    assetType: "Pump", kind: "task", name: "Leak check", position: 1,
    resultType: "pass_fail", target: null, tolerancePct: null,
    requiresNote: false, consumesPart: false, modelScope: [] as string[], ...over,
  });

  it("intake matching still replaces all-model rows with scoped ones, per kind", () => {
    const rows = [
      proc({ id: 1, name: "Generic seals" }),
      proc({ id: 2, name: "XR seals", modelScope: ["LC-20ADXR"] }),
      proc({ id: 3, name: "Flow test", kind: "test" }),
    ];
    expect(matchItems(rows, "Pump", "LC-20ADXR").map((r) => r.id)).toEqual([2, 3]);
    expect(matchItems(rows, "Pump", "LC-20AD").map((r) => r.id)).toEqual([1, 3]);
  });
});
