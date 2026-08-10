import { describe, expect, it } from "vitest";
import { assetDupeKey, countByKey, duplicateIds, importPlanner } from "@/lib/assetDupe";

const a = (over: Partial<Parameters<typeof assetDupeKey>[0]> = {}) => ({
  systemKey: "ss-001", kind: "Pump", model: "LC-20AD", serial: "", owner: "LabZen", location: "", ...over,
});

describe("assetDupeKey", () => {
  it("keys a serial-bearing unit on the serial alone, anywhere in the fleet", () => {
    // Same unit, moved to another system and retyped - still the same unit.
    expect(assetDupeKey(a({ serial: "US1234" })))
      .toBe(assetDupeKey(a({ serial: " us1234 ", systemKey: "ss-999", model: "LC-20ADXR", owner: "Acme" })));
  });

  it("keys a serial-less unit on its description, scoped to its system", () => {
    expect(assetDupeKey(a())).toBe(assetDupeKey(a({ model: "  lc-20ad " })));
    expect(assetDupeKey(a())).not.toBe(assetDupeKey(a({ systemKey: "ss-002" })));
    expect(assetDupeKey(a())).not.toBe(assetDupeKey(a({ location: "Bay 2" })));
  });

  it("never confuses a serial-less unit with a serialled one", () => {
    expect(assetDupeKey(a({ serial: "US1234" }))).not.toBe(assetDupeKey(a()));
  });
});

describe("countByKey", () => {
  it("counts identical serial-less units rather than collapsing them", () => {
    expect(countByKey([a(), a(), a({ systemKey: "ss-002" })]).get(assetDupeKey(a()))).toBe(2);
  });
});

describe("importPlanner", () => {
  it("makes re-importing the same file a no-op", () => {
    const file = [a({ serial: "US1" }), a({ serial: "US2" }), a(), a()];
    const plan = importPlanner(file);
    expect(file.map((r) => plan(r).skip)).toEqual([true, true, true, true]);
  });

  it("creates everything on a first import", () => {
    const plan = importPlanner([]);
    expect([a({ serial: "US1" }), a(), a()].map((r) => plan(r).skip)).toEqual([false, false, false]);
  });

  it("reconciles serial-less rows by count, not by presence", () => {
    // Three identical pumps in the file, one already on file: add the other two.
    const plan = importPlanner([a()]);
    expect([a(), a(), a()].map((r) => plan(r).skip)).toEqual([true, false, false]);
  });

  it("refuses the same serial twice inside one file", () => {
    const plan = importPlanner([]);
    expect(plan(a({ serial: "US1" })).skip).toBe(false);
    const second = plan(a({ serial: "US1", model: "LC-20ADXR" }));
    expect(second.skip).toBe(true);
    if (second.skip) expect(second.reason).toContain("earlier in this file");
  });

  it("names what a row matched, when the caller can describe it", () => {
    const existing = [a({ serial: "US1" })];
    const plan = importPlanner(existing, () => "Pump LC-20AD SN US1 (SS-001)");
    const v = plan(a({ serial: "US1" }));
    expect(v.skip).toBe(true);
    if (v.skip) expect(v.reason).toContain("Pump LC-20AD SN US1 (SS-001)");
  });

  it("treats a moved unit as already on file even under a new system", () => {
    const plan = importPlanner([a({ serial: "US1", systemKey: "ss-001" })]);
    expect(plan(a({ serial: "US1", systemKey: "ss-002" })).skip).toBe(true);
  });
});

describe("duplicateIds", () => {
  it("keeps the oldest of each group and returns the rest", () => {
    const rows = [
      { id: 5, ...a({ serial: "US1" }) },
      { id: 9, ...a({ serial: "US1" }) },  // dupe of 5
      { id: 2, ...a() },
      { id: 7, ...a() },                    // dupe of 2
      { id: 8, ...a({ systemKey: "ss-002" }) },
    ];
    expect(duplicateIds(rows).sort((x, y) => x - y)).toEqual([7, 9]);
  });

  it("returns nothing for a clean registry", () => {
    expect(duplicateIds([{ id: 1, ...a() }, { id: 2, ...a({ serial: "US1" }) }])).toEqual([]);
  });

  it("keeps the survivor even when the input arrives newest-first", () => {
    const rows = [{ id: 9, ...a() }, { id: 5, ...a() }];
    expect(duplicateIds(rows)).toEqual([9]);
  });
});
