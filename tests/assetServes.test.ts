import { describe, expect, it } from "vitest";
import {
  checkServes, cleanRole, isServed, moveFallout, serveCandidates, serversOf, servesLine, unitLabel,
} from "@/lib/assetServes";

// G-010's stack: a mass spec with two roughing pumps, an autosampler, and a
// pump sitting on the shelf.
const MS = { id: 1, instrumentId: 10, servesAssetId: null };
const ROUGH_A = { id: 2, instrumentId: 10, servesAssetId: 1 };
const ROUGH_B = { id: 3, instrumentId: 10, servesAssetId: 1 };
const SAMPLER = { id: 4, instrumentId: 10, servesAssetId: null };
const SPARE = { id: 5, instrumentId: null, servesAssetId: null };
const OTHER_SYSTEM = { id: 6, instrumentId: 99, servesAssetId: null };
const ALL = [MS, ROUGH_A, ROUGH_B, SAMPLER, SPARE, OTHER_SYSTEM];

describe("who serves what", () => {
  it("finds every unit pointing at a module - two pumps on one spec is ordinary", () => {
    expect(serversOf(1, ALL).map((a) => a.id)).toEqual([2, 3]);
    expect(serversOf(4, ALL)).toEqual([]);
    expect(isServed(1, ALL)).toBe(true);
    expect(isServed(4, ALL)).toBe(false);
  });
});

describe("what a unit may be pointed at", () => {
  it("offers the modules on its own system, and not itself", () => {
    expect(serveCandidates(ROUGH_A, ALL).map((a) => a.id)).toEqual([1, 4]);
  });

  it("never offers something that is already serving - depth stays at one", () => {
    // ROUGH_B serves the spec, so it is not somewhere ROUGH_A may point.
    expect(serveCandidates(ROUGH_A, ALL).map((a) => a.id)).not.toContain(3);
  });

  it("offers nothing to a spare - what it serves is a fact about a system", () => {
    expect(serveCandidates(SPARE, ALL)).toEqual([]);
  });
});

describe("refusing a link, in words", () => {
  it("takes the ordinary case", () => {
    expect(checkServes(SAMPLER, 1, ALL)).toEqual({ ok: true, servesAssetId: 1 });
  });

  it("always allows clearing one", () => {
    expect(checkServes(ROUGH_A, null, ALL)).toEqual({ ok: true, servesAssetId: null });
  });

  it("refuses itself, another system, and a unit off any system", () => {
    expect(checkServes(SAMPLER, 4, ALL)).toEqual({ ok: false, error: "A unit can't serve itself." });
    expect("error" in checkServes(SAMPLER, 6, ALL)).toBe(true);
    expect("error" in checkServes(SPARE, 1, ALL)).toBe(true);
  });

  it("refuses both directions of a second level, distinctly", () => {
    // Pointing AT a server.
    const a = checkServes(SAMPLER, 2, ALL);
    expect(a).toEqual({ ok: false, error: "That module already serves something else - a support unit can't have one of its own." });
    // Pointing FROM something already served.
    const b = checkServes(MS, 4, ALL);
    expect(b).toEqual({ ok: false, error: "Something already serves this unit, so it can't also serve a module." });
  });

  it("refuses a target that isn't there at all", () => {
    expect("error" in checkServes(SAMPLER, 404, ALL)).toBe(true);
  });
});

describe("what moving breaks", () => {
  it("brings the servers you asked for and cuts the ones you didn't", () => {
    expect(moveFallout(1, ALL, [2])).toEqual({ bring: [2], orphan: [3], clearOwn: false });
  });

  it("cuts every link when nothing comes along", () => {
    expect(moveFallout(1, ALL)).toEqual({ bring: [], orphan: [2, 3], clearOwn: false });
  });

  it("ignores an id that doesn't actually serve this unit", () => {
    // A stale id from the browser must not drag an unrelated asset onto
    // another system.
    expect(moveFallout(1, ALL, [4, 99]).bring).toEqual([]);
  });

  it("clears the unit's own link when it is the one leaving", () => {
    expect(moveFallout(2, ALL)).toEqual({ bring: [], orphan: [], clearOwn: true });
  });
});

describe("reading it back", () => {
  it("names each server, with its role when it has one", () => {
    expect(servesLine([
      { kind: "Vacuum pump", model: "nXDS15i", serial: "", servesRole: "fore-line" },
      { kind: "Vacuum pump", model: "nXDS15i", serial: "", servesRole: "interface" },
    ])).toBe("nXDS15i (fore-line), nXDS15i (interface)");
  });

  it("falls back through serial to the type when a model isn't recorded", () => {
    expect(servesLine([{ kind: "Vacuum pump", model: "", serial: "SN-9", servesRole: "" }])).toBe("SN-9");
    expect(servesLine([{ kind: "Vacuum pump", model: "", serial: "", servesRole: "" }])).toBe("Vacuum pump");
  });

  it("names a unit so two identical ones can be told apart", () => {
    // A system with two Altis units is ordinary; picking which one a pump
    // serves out of two options reading the same thing is picking at random.
    expect(unitLabel({ kind: "Mass Spec", model: "Thermo Altis", serial: "SN-ALTIS-1" }))
      .toBe("Mass Spec · Thermo Altis · SN SN-ALTIS-1");
    expect(unitLabel({ kind: "Vacuum pump", model: "", serial: "" })).toBe("Vacuum pump");
    expect(unitLabel({ kind: "", model: "", serial: "" })).toBe("Unit");
  });

  it("bounds a role", () => {
    expect(cleanRole("  fore-line  ")).toBe("fore-line");
    expect(cleanRole("x".repeat(80))).toHaveLength(40);
  });
});
