import { describe, expect, it } from "vitest";
import { buildStore, cartTotals, filterStore } from "@/lib/store";

const cat = (over: Record<string, unknown>) => ({
  id: 1, partNumber: "PN-1", name: "Widget", manufacturer: "Maker",
  kind: "part", assetTypes: [], models: [], archived: false, ...over,
});

describe("buildStore", () => {
  it("prices at resale, never at cost, and unknown stays unknown", () => {
    const [a, b] = buildStore(
      [cat({ id: 1, partNumber: "A" }), cat({ id: 2, partNumber: "B" })],
      new Map([["a", 10000]]), 3000, { models: [], types: [] },
    ).sort((x, y) => x.partNumber.localeCompare(y.partNumber));
    expect(a.priceCents).toBe(13000);
    expect(b.priceCents).toBeNull();
  });

  it("carries nothing a client may not read - no vendor, no cost, no margin", () => {
    const [item] = buildStore([cat({})], new Map([["pn-1", 5000]]), 2500, { models: [], types: [] });
    const keys = Object.keys(item).join(" ").toLowerCase();
    expect(keys).not.toMatch(/vendor|cost|margin|lead|drop|oem/);
  });

  it("knows the client's own bench: model or module-type match, case-insensitive", () => {
    const items = buildStore(
      [
        cat({ id: 1, partNumber: "SEAL", models: ["LCMS-8060"] }),
        cat({ id: 2, partNumber: "FILTER", assetTypes: ["Vacuum pump"] }),
        cat({ id: 3, partNumber: "OTHER", models: ["SQ Detector 2"] }),
      ],
      new Map(), 3000, { models: ["lcms-8060"], types: ["vacuum PUMP"] },
    );
    expect(items.find((i) => i.partNumber === "SEAL")?.fitsYours).toBe(true);
    expect(items.find((i) => i.partNumber === "FILTER")?.fitsYours).toBe(true);
    expect(items.find((i) => i.partNumber === "OTHER")?.fitsYours).toBe(false);
    // What fits floats to the front of the shelf.
    expect(items[items.length - 1].partNumber).toBe("OTHER");
  });

  it("keeps archived and numberless rows off the shelf", () => {
    const items = buildStore(
      [cat({ archived: true }), cat({ id: 2, partNumber: "  " })],
      new Map(), 3000, { models: [], types: [] },
    );
    expect(items).toHaveLength(0);
  });
});

describe("filterStore and cartTotals", () => {
  const items = buildStore(
    [
      cat({ id: 1, partNumber: "SEAL", name: "Plunger seal", kind: "consumable", models: ["LC-20AD"] }),
      cat({ id: 2, partNumber: "KIT-9", name: "PM kit", kind: "kit" }),
    ],
    new Map([["seal", 4000]]), 5000, { models: ["LC-20AD"], types: [] },
  );

  it("facets by fit and by kind, and searches the readable fields", () => {
    expect(filterStore(items, "yours", "").map((i) => i.partNumber)).toEqual(["SEAL"]);
    expect(filterStore(items, "kit", "").map((i) => i.partNumber)).toEqual(["KIT-9"]);
    expect(filterStore(items, "all", "plunger")).toHaveLength(1);
  });

  it("totals the priced lines and counts the ones awaiting a price", () => {
    const t = cartTotals(
      [{ partNumber: "seal", qty: 2 }, { partNumber: "KIT-9", qty: 1 }, { partNumber: "GONE", qty: 5 }],
      items,
    );
    // Seal resells at 4000 * 1.5 = 6000; two of them.
    expect(t.subtotalCents).toBe(12000);
    expect(t.unpriced).toBe(1);
    expect(t.count).toBe(3);
  });
});
