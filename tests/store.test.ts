import { describe, expect, it } from "vitest";
import { availabilityLabel, buildStore, cartTotals, filterStore, splitCart } from "@/lib/store";

const cat = (over: Record<string, unknown>) => ({
  id: 1, partNumber: "PN-1", name: "Widget", manufacturer: "Maker",
  kind: "part", assetTypes: [], models: [], archived: false, ...over,
});

describe("buildStore", () => {
  it("prices at resale, never at cost, and unknown stays unknown", () => {
    const [a, b] = buildStore(
      [cat({ id: 1, partNumber: "A" }), cat({ id: 2, partNumber: "B" })],
      { bestCostByPn: new Map([["a", 10000]]), markupBps: 3000, yours: { models: [], types: [] } },
    ).sort((x, y) => x.partNumber.localeCompare(y.partNumber));
    expect(a.priceCents).toBe(13000);
    expect(b.priceCents).toBeNull();
  });

  it("carries nothing a client may not read - no vendor, no cost, no margin", () => {
    const [item] = buildStore([cat({})],
      { bestCostByPn: new Map([["pn-1", 5000]]), markupBps: 2500, yours: { models: [], types: [] } });
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
      { bestCostByPn: new Map(), markupBps: 3000, yours: { models: ["lcms-8060"], types: ["vacuum PUMP"] } },
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
      { bestCostByPn: new Map(), markupBps: 3000, yours: { models: [], types: [] } },
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
    {
      bestCostByPn: new Map([["seal", 4000]]), markupBps: 5000,
      yours: { models: ["LC-20AD"], types: [] },
      stockByPn: new Map([["seal", 3]]),
      etaByPn: new Map([["kit-9", 4]]),
    },
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

describe("availability and the checkout split", () => {
  const items = buildStore(
    [
      cat({ id: 1, partNumber: "SEAL", name: "Plunger seal" }),
      cat({ id: 2, partNumber: "CAP", name: "Capillary" }),
      cat({ id: 3, partNumber: "ODD", name: "Odd bracket" }),
    ],
    {
      bestCostByPn: new Map(), markupBps: 3000, yours: { models: [], types: [] },
      stockByPn: new Map([["seal", 2]]),
      etaByPn: new Map([["cap", 3]]),
    },
  );

  it("says what the shelf knows, in the client's words", () => {
    const by = (pn: string) => items.find((i) => i.partNumber === pn)!;
    expect(availabilityLabel(by("SEAL"))).toBe("In stock - ships now");
    expect(availabilityLabel(by("CAP"))).toBe("Sourced for you - about 3d");
    expect(availabilityLabel(by("ODD"))).toBe("Special order - quoted first");
    // On the shelf floats ahead of sourced, all else equal.
    expect(items[0].partNumber).toBe("SEAL");
  });

  it("splits the cart: in stock orders now, the rest quotes first", () => {
    const { now, quoted } = splitCart(
      [{ partNumber: "seal", qty: 1 }, { partNumber: "CAP", qty: 2 }, { partNumber: "GONE", qty: 1 }],
      items,
    );
    expect(now.map((l) => l.partNumber)).toEqual(["seal"]);
    expect(quoted.map((l) => l.partNumber)).toEqual(["CAP"]);
  });
});
