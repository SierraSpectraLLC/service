import { describe, expect, it } from "vitest";
import { availabilityHint, availabilityLabel, bucketTotals, buildStore, cartTotals, filterStore, hasChoice, linePrice, sourceTag, splitCart } from "@/lib/store";

const cat = (over: Record<string, unknown>) => ({
  id: 1, partNumber: "PN-1", name: "Widget", manufacturer: "Maker",
  kind: "part", assetTypes: [], models: [], archived: false, ...over,
});

describe("buildStore", () => {
  it("prices at resale, never at cost, and unknown stays unknown", () => {
    const [a, b] = buildStore(
      [cat({ id: 1, partNumber: "A" }), cat({ id: 2, partNumber: "B" })],
      { oemCostByPn: new Map(), altCostByPn: new Map([["a", 10000]]), markupBps: 3000, yours: { models: [], types: [] } },
    ).sort((x, y) => x.partNumber.localeCompare(y.partNumber));
    expect(a.priceCents).toBe(13000);
    expect(b.priceCents).toBeNull();
  });

  it("carries nothing a client may not read - no vendor, no cost, no margin", () => {
    const [item] = buildStore([cat({})],
      { oemCostByPn: new Map(), altCostByPn: new Map([["pn-1", 5000]]), markupBps: 2500, yours: { models: [], types: [] } });
    const keys = Object.keys(item).join(" ").toLowerCase();
    expect(keys).not.toMatch(/vendor|cost|margin|lead|drop/);
  });

  /**
   * Reported from a live client account: Modesto Irrigation District runs a
   * TOC analyser, a UV-Vis and the autosampler bolted to the TOC. Under
   * "For your systems" they were offered a Shimadzu AOC-20S attachment kit
   * for a GC-MS and an Agilent needle seat for a G7167B - two autosampler
   * parts for two autosamplers they do not own.
   *
   * The old rule asked "models match OR asset type matches", so a part that
   * said in as many words which model it fits could still be recommended on
   * the strength of the word "Autosampler". A part naming its models has
   * already answered the question; the kind of machine is only the fallback
   * for parts that name none.
   */
  it("does not recommend a part for a model they do not own, whatever kind of machine it is", () => {
    const mid = {
      oemCostByPn: new Map(), altCostByPn: new Map(), markupBps: 3000,
      yours: {
        models: ["ASI-V", "TOC-Vw", "UV-1900"],
        types: ["Autosampler", "TOC", "UV-Vis"],
      },
    };
    const items = buildStore([
      cat({ id: 1, partNumber: "225-10681-91", name: "AOC-20S Attachment Kit for GCMS",
        models: ["AOC-20S"], assetTypes: ["Autosampler"] }),
      cat({ id: 2, partNumber: "G4267-87012", name: "Needle Seat",
        models: ["G7167B"], assetTypes: ["Autosampler"] }),
      cat({ id: 3, partNumber: "ASI-TUBE", name: "Sample tubing",
        models: ["ASI-V"], assetTypes: ["Autosampler"] }),
      cat({ id: 4, partNumber: "TOC-CAT", name: "Catalyst, generic",
        models: [], assetTypes: ["TOC"] }),
    ], mid);
    const fits = (pn: string) => items.find((i) => i.partNumber === pn)!.fitsYours;

    expect(fits("225-10681-91")).toBe(false);
    expect(fits("G4267-87012")).toBe(false);
    // Their own autosampler's part still fits, by name.
    expect(fits("ASI-TUBE")).toBe(true);
    // And a consumable that names no model still falls back to the machine kind.
    expect(fits("TOC-CAT")).toBe(true);
    expect(filterStore(items, "yours", "").map((i) => i.partNumber).sort())
      .toEqual(["ASI-TUBE", "TOC-CAT"]);
  });

  /**
   * The label and the highlight have to agree with the rule. The screenshot
   * showed "Fits AOC-20S" in the green that means "this is for your bench",
   * which is the contradiction stated out loud.
   */
  it("never paints a model they do not own as one of theirs", () => {
    const [item] = buildStore(
      [cat({ partNumber: "KIT", models: ["AOC-20S"], assetTypes: ["Autosampler"] })],
      { oemCostByPn: new Map(), altCostByPn: new Map(), markupBps: 3000,
        yours: { models: ["ASI-V"], types: ["Autosampler"] } },
    );
    expect(item.fitsYours).toBe(false);
    expect(item.fitsLabel).toBe("Fits AOC-20S");
    expect(item.fitsLabel).not.toMatch(/your/i);
  });

  it("knows the client's own bench: model or module-type match, case-insensitive", () => {
    const items = buildStore(
      [
        cat({ id: 1, partNumber: "SEAL", models: ["LCMS-8060"] }),
        cat({ id: 2, partNumber: "FILTER", assetTypes: ["Vacuum pump"] }),
        cat({ id: 3, partNumber: "OTHER", models: ["SQ Detector 2"] }),
      ],
      { oemCostByPn: new Map(), altCostByPn: new Map(), markupBps: 3000, yours: { models: ["lcms-8060"], types: ["vacuum PUMP"] } },
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
      { oemCostByPn: new Map(), altCostByPn: new Map(), markupBps: 3000, yours: { models: [], types: [] } },
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
      oemCostByPn: new Map(), altCostByPn: new Map([["seal", 4000]]), markupBps: 5000,
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
      oemCostByPn: new Map(), altCostByPn: new Map([["seal", 10000], ["cap", 7000]]),
      markupBps: 3000, yours: { models: [], types: [] },
      stockByPn: new Map([["seal", 2]]),
      etaByPn: new Map([["cap", 3]]),
    },
  );

  it("says what the shelf knows, in the client's words", () => {
    const by = (pn: string) => items.find((i) => i.partNumber === pn)!;
    expect(availabilityLabel(by("SEAL"))).toBe("In stock · ships today");
    expect(availabilityLabel(by("CAP"))).toBe("Sourced for you · ~3 d");
    expect(availabilityHint(by("CAP"))).toBe("invoiced when it ships");
    expect(availabilityLabel(by("ODD"))).toBe("Special order · quoted first");
    expect(availabilityHint(by("ODD"))).toBe("price confirmed before anything moves");
    // On the shelf floats ahead of sourced, all else equal.
    expect(items[0].partNumber).toBe("SEAL");
  });

  it("unpriced forces special-order, whatever the shelf says", () => {
    const [stockedUnpriced] = buildStore([cat({ id: 9, partNumber: "MYST" })], {
      oemCostByPn: new Map(), altCostByPn: new Map(),
      markupBps: 3000, yours: { models: [], types: [] },
      stockByPn: new Map([["myst", 4]]),
    });
    expect(availabilityLabel(stockedUnpriced)).toBe("Special order · quoted first");
  });

  it("splits three ways: priced ships or sources on the order, unpriced quotes", () => {
    const { now, sourced, quoted } = splitCart(
      [{ partNumber: "seal", qty: 1 }, { partNumber: "CAP", qty: 2 }, { partNumber: "GONE", qty: 1 }],
      items,
    );
    expect(now.map((l) => l.partNumber)).toEqual(["seal"]);
    expect(sourced.map((l) => l.partNumber)).toEqual(["CAP"]);
    expect(quoted).toEqual([]);
    const t2 = bucketTotals([{ partNumber: "seal", qty: 2 }, { partNumber: "CAP", qty: 1 }], items);
    expect(t2.nowCents).toBe(2 * 13000);
    expect(t2.sourcedCents).toBe(9100);
    expect(t2.count).toBe(3);
  });
});

describe("the genuine-or-equivalent choice", () => {
  const items = buildStore(
    [cat({ id: 1, partNumber: "CAP", name: "Capillary", manufacturer: "Waters" })],
    {
      oemCostByPn: new Map([["cap", 70000]]),
      altCostByPn: new Map([["cap", 60000]]),
      markupBps: 3000, yours: { models: [], types: [] },
    },
  );
  const [cap] = items;

  it("prices each class at its own resale, and 'from' is the better one", () => {
    expect(cap.oemCents).toBe(91000);
    expect(cap.altCents).toBe(78000);
    expect(cap.priceCents).toBe(78000);
    expect(hasChoice(cap)).toBe(true);
  });

  it("a chosen line prices as chosen, and the tags name the classes", () => {
    expect(linePrice(cap, "oem")).toBe(91000);
    expect(linePrice(cap, "alt")).toBe(78000);
    expect(sourceTag(cap, "oem")).toBe("Genuine Waters");
    expect(sourceTag(cap, "alt")).toBe("OEM-equivalent");
    const t2 = cartTotals([{ partNumber: "CAP", qty: 1, source: "oem" }], items);
    expect(t2.subtotalCents).toBe(91000);
  });

  it("a chosen class never ships from the shelf: it sources on the order", () => {
    const { now, sourced, quoted } = splitCart([{ partNumber: "CAP", qty: 1, source: "oem" }], items);
    expect(now).toEqual([]);
    expect(quoted).toEqual([]);
    expect(sourced).toHaveLength(1);
  });

  it("no choice on the shelf: an in-stock box is whatever it is", () => {
    const [stocked] = buildStore(
      [cat({ id: 1, partNumber: "CAP" })],
      {
        oemCostByPn: new Map([["cap", 70000]]), altCostByPn: new Map([["cap", 60000]]),
        markupBps: 3000, yours: { models: [], types: [] },
        stockByPn: new Map([["cap", 1]]),
      },
    );
    expect(hasChoice(stocked)).toBe(false);
  });

  it("one class on file gets a tag, not a choice", () => {
    const [only] = buildStore(
      [cat({ id: 1, partNumber: "X", manufacturer: "Edwards" })],
      { oemCostByPn: new Map([["x", 20000]]), altCostByPn: new Map(), markupBps: 3000, yours: { models: [], types: [] } },
    );
    expect(hasChoice(only)).toBe(false);
    expect(sourceTag(only)).toBe("Genuine Edwards");
  });
});
