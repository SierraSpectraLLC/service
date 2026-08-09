import { describe, expect, it } from "vitest";
import {
  describeProcedure, parseProcParts, serializeProcParts, schedulePartsOf, partLabel,
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
      .toBe("Runs once at intake with every new system.");
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
