import { describe, it, expect } from "vitest";
import { matchItems, summarizeItem, impactLine, type CheckoutItem } from "@/lib/checkout";

let nextId = 1;
const item = (over: Partial<CheckoutItem>): CheckoutItem => ({
  id: nextId++,
  assetType: "Pump",
  kind: "test",
  name: "Test",
  position: 0,
  resultType: "pass_fail",
  target: null,
  tolerancePct: null,
  requiresNote: false,
  consumesPart: false,
  modelScope: [],
  ...over,
});

describe("matchItems", () => {
  const ITEMS = [
    item({ kind: "test", name: "Leak/Pulse Check", position: 1 }),
    item({ kind: "test", name: "Flow Check", position: 2 }),
    item({ kind: "test", name: "LC-40 Tight Spec", position: 1, modelScope: ["LC-40D"] }),
    item({ kind: "task", name: "Swap seals", position: 3 }),
    item({ assetType: "system", name: "Caffeine Checkout", position: 1 }),
  ];

  it("applies all-model items when no scope matches", () => {
    expect(matchItems(ITEMS, "Pump", "LC-30AD").map((i) => i.name))
      .toEqual(["Leak/Pulse Check", "Flow Check", "Swap seals"]);
  });

  it("scoped items replace the all-model items of the SAME kind only", () => {
    // The scoped test wins over generic tests, but the generic task survives.
    expect(matchItems(ITEMS, "Pump", "LC-40D").map((i) => i.name))
      .toEqual(["LC-40 Tight Spec", "Swap seals"]);
  });

  it("a scoped task does not suppress tests either", () => {
    const items = [
      item({ kind: "task", name: "Special prep", modelScope: ["LC-2050"], position: 1 }),
      item({ kind: "test", name: "Generic test", position: 2 }),
      item({ kind: "task", name: "Generic task", position: 3 }),
    ];
    expect(matchItems(items, "Pump", "LC-2050").map((i) => i.name))
      .toEqual(["Special prep", "Generic test"]);
  });

  it("matches scope entries case-insensitively and trimmed, as exact strings", () => {
    expect(matchItems(ITEMS, "Pump", "  lc-40d ").map((i) => i.name)).toContain("LC-40 Tight Spec");
    // substring is NOT enough - scope is exact model names
    expect(matchItems(ITEMS, "Pump", "LC-40D XR").map((i) => i.name)).not.toContain("LC-40 Tight Spec");
  });

  it("takes every system item, since systems have no model to scope by", () => {
    const items = [
      item({ assetType: "system", name: "Caffeine Checkout", position: 1 }),
      item({ assetType: "system", name: "Paperwork", kind: "task", position: 2 }),
      // Legacy rows may still carry a scope; generation passes no model for a
      // system, so they simply never match.
      item({ assetType: "system", name: "Stale scoped item", position: 3, modelScope: ["GC-2030"] }),
    ];
    expect(matchItems(items, "system", "").map((i) => i.name)).toEqual(["Caffeine Checkout", "Paperwork"]);
  });

  it("only considers items of the requested asset type", () => {
    expect(matchItems(ITEMS, "system", "anything").map((i) => i.name)).toEqual(["Caffeine Checkout"]);
    expect(matchItems(ITEMS, "Degasser", "DGU-405")).toEqual([]);
  });

  it("sorts by position", () => {
    const items = [item({ name: "B", position: 2 }), item({ name: "A", position: 1 })];
    expect(matchItems(items, "Pump", "").map((i) => i.name)).toEqual(["A", "B"]);
  });
});

describe("summarizeItem", () => {
  it("summarizes tests by result type", () => {
    expect(summarizeItem(item({ resultType: "pass_fail" }))).toBe("Pass / Fail");
    expect(summarizeItem(item({ resultType: "reading" }))).toBe("Reading");
    expect(summarizeItem(item({ resultType: "note" }))).toBe("Note");
    expect(summarizeItem(item({ resultType: "note", target: "record lamp hours" }))).toBe("Note: record lamp hours");
  });

  it("composes measured targets and tolerances", () => {
    expect(summarizeItem(item({ resultType: "measured", tolerancePct: "10" }))).toBe("Target ± 10%");
    // The target is the value it should read, not a band around it.
    expect(summarizeItem(item({ resultType: "measured", target: "2.0 C" }))).toBe("Target 2.0 C");
    expect(summarizeItem(item({ resultType: "measured", target: "5 mL/min", tolerancePct: "10" }))).toBe("Target 5 mL/min ± 10%");
    expect(summarizeItem(item({ resultType: "measured" }))).toBe("Measured value");
  });

  it("summarizes tasks by their flags", () => {
    expect(summarizeItem(item({ kind: "task" }))).toBe("Done / not done");
    expect(summarizeItem(item({ kind: "task", requiresNote: true }))).toBe("Note required");
    expect(summarizeItem(item({ kind: "task", consumesPart: true }))).toBe("Logs part used");
    expect(summarizeItem(item({ kind: "task", requiresNote: true, consumesPart: true }))).toBe("Note required · Logs part used");
  });
});

describe("impactLine", () => {
  const group = [
    item({ kind: "test", modelScope: [] }),
    item({ kind: "test", modelScope: [] }),
    item({ kind: "task", modelScope: [] }),
  ];

  it("states the no-scope default", () => {
    const r = impactLine("test", "Pump", [], group);
    expect(r).toEqual({ text: "Created on every pump without a model-specific test.", warning: false });
  });

  it("warns when a scope would replace all-model items of the same kind", () => {
    const r = impactLine("test", "Pump", ["LC-2050"], group);
    expect(r.warning).toBe(true);
    expect(r.text).toBe("On LC-2050, this replaces the 2 all-model tests. Everything else stays.");
  });

  it("does not count the other kind as replaced", () => {
    const r = impactLine("task", "Pump", ["LC-2050"], group);
    expect(r.warning).toBe(true);
    expect(r.text).toBe("On LC-2050, this replaces the 1 all-model task. Everything else stays.");
  });

  it("says system items just run on every new system", () => {
    expect(impactLine("test", "system", [], group))
      .toEqual({ text: "Created with every new system.", warning: false });
  });

  it("plain when nothing would be replaced", () => {
    const r = impactLine("test", "Pump", ["LC-2050"], [item({ kind: "task" })]);
    expect(r).toEqual({ text: "Created only on LC-2050. Nothing replaced.", warning: false });
  });
});
