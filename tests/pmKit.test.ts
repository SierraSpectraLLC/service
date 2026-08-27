// Typing a model and getting its kit.
//
// The worked example is the one asked for: adding an API 5000 to an estimate
// should bring its PM kit and two litres of pump oil with it, priced, without
// anybody retyping a part number into a bid. What is held down hardest is the
// pair of honesty rules - a kit costs what the KIT costs, and a part nobody has
// priced is never quietly worth nothing.
import { describe, expect, it } from "vitest";
import {
  kitForModel, kitIsEmpty, priceOf, proceduresForModel,
  type CatalogEntry, type KitProcedure,
} from "@/lib/pmKit";
import type { PriceEntry } from "@/lib/priceBook";

const proc = (p: Partial<KitProcedure> & { name: string }): KitProcedure => ({
  id: 1, assetType: "system", parts: "", estMinutes: 0, intervalDays: null,
  modelScope: [], categoryScope: [], ...p,
});

const PM_5000 = proc({
  id: 1, name: "API 5000 annual PM", estMinutes: 480, intervalDays: 182,
  modelScope: ["API 5000"], categoryScope: ["LC-MS"],
  parts: JSON.stringify([
    { name: "API 5000 PM kit", number: "PM-5000-KIT" },
    { name: "Pump oil (AVF Gold)", number: "228-35145-91", qty: 2 },
  ]),
});

const FLUSH = proc({
  id: 2, name: "Line flush", estMinutes: 45, intervalDays: 90,
  modelScope: [], categoryScope: ["LC-MS"],
  parts: JSON.stringify([{ name: "Pump oil (AVF Gold)", number: "228-35145-91" }]),
});

const LC_PM = proc({
  id: 3, name: "1260 LC PM", estMinutes: 240, intervalDays: 365,
  modelScope: ["1260 LC"], categoryScope: ["LC"],
  parts: JSON.stringify([{ name: "Seal kit", number: "5067-1234" }]),
});

const CATALOG: CatalogEntry[] = [
  {
    partNumber: "PM-5000-KIT", name: "API 5000 PM kit", kind: "kit",
    lines: [
      { partNumber: "CURT-5000", name: "Curtain plate", qty: 1 },
      { partNumber: "ORING-22", name: "O-ring set", qty: 4 },
    ],
  },
  { partNumber: "228-35145-91", name: "AVF Gold pump oil, 1 L", kind: "consumable" },
];

const PRICES: PriceEntry[] = [
  { partNumber: "PM-5000-KIT", vendor: "SCIEX", isOem: true, priceCents: 94_000 },
  { partNumber: "228-35145-91", vendor: "Krackeler", isOem: false, priceCents: 8_900 },
  { partNumber: "CURT-5000", vendor: "SCIEX", isOem: true, priceCents: 61_000 },
  { partNumber: "ORING-22", vendor: "SCIEX", isOem: true, priceCents: 4_000 },
];

describe("what a model brings with it", () => {
  const kit = kitForModel({
    model: "API 5000", category: "LC-MS",
    procedures: [PM_5000, FLUSH, LC_PM], catalog: CATALOG, prices: PRICES,
  });

  it("brings the kit and the consumable, and leaves another model's work alone", () => {
    expect(kit.lines.map((l) => l.partNumber)).toEqual(["PM-5000-KIT", "228-35145-91"]);
    expect(kit.lines.find((l) => l.partNumber === "5067-1234")).toBeUndefined();
  });

  it("counts each procedure at its OWN rate", () => {
    /*
     * The arithmetic error worth the most money. The PM is twice a year and
     * takes 2 L each time; the flush is quarterly and takes 1 L. That is
     * 2x2 + 4x1 = eight bottles a year, not the three you get by adding one
     * of each and calling it a visit.
     */
    const oil = kit.lines.find((l) => l.partNumber === "228-35145-91")!;
    expect(oil.qty).toBe(8);
    expect(oil.totalCents).toBe(8 * 8_900);
    expect(oil.because).toEqual(["API 5000 annual PM", "Line flush"]);
  });

  it("totals a YEAR of parts and hours, then spreads them over the visits", () => {
    expect(kit.partsCentsPerYear).toBe(2 * 94_000 + 8 * 8_900);
    expect(kit.minutesPerYear).toBe(2 * 480 + 4 * 45);
    // Quarterly work means being there quarterly, however rare the teardown.
    expect(kit.visitsPerYear).toBe(4);
    expect(kit.minutesPerVisit).toBe(Math.round((2 * 480 + 4 * 45) / 4));
    // Visits x per-visit comes back to the year, which is the whole point.
    expect(kit.minutesPerVisit * 4).toBeCloseTo(kit.minutesPerYear, -2);
    expect(kit.untimed).toEqual([]);
    expect(kit.unpriced).toEqual([]);
  });

  it("ignores intake work, which happens once when a system arrives", () => {
    const intake = proc({
      id: 4, name: "Incoming inspection", estMinutes: 90, intervalDays: null,
      modelScope: [], categoryScope: [],
    });
    const withIntake = kitForModel({
      model: "API 5000", category: "LC-MS",
      procedures: [PM_5000, FLUSH, intake], catalog: CATALOG, prices: PRICES,
    });
    expect(withIntake.minutesPerYear).toBe(kit.minutesPerYear);
    expect(withIntake.untimed).toEqual([]);
  });
});

describe("a kit costs what the kit costs", () => {
  it("takes the bag's own listing over its contents", () => {
    // $940 is what the purchase order will say. Its contents come to $770,
    // and quoting that would be quoting a price nobody sells.
    expect(priceOf("PM-5000-KIT", CATALOG, PRICES)).toEqual({ unitCents: 94_000, fromContents: false });
  });

  it("falls back to the contents, and says that is what it did", () => {
    const noKitPrice = PRICES.filter((p) => p.partNumber !== "PM-5000-KIT");
    expect(priceOf("PM-5000-KIT", CATALOG, noKitPrice))
      .toEqual({ unitCents: 61_000 + 4 * 4_000, fromContents: true });
    const kit = kitForModel({
      model: "API 5000", category: "LC-MS",
      procedures: [PM_5000], catalog: CATALOG, prices: noKitPrice,
    });
    expect(kit.lines.find((l) => l.partNumber === "PM-5000-KIT")!.fromContents).toBe(true);
  });

  it("refuses to sum a bag it only half knows", () => {
    /*
     * Three of five contents priced is a number that LOOKS like a price and is
     * not one. Better to come back unpriced and be argued with.
     */
    const half = PRICES.filter((p) => !["PM-5000-KIT", "ORING-22"].includes(p.partNumber));
    expect(priceOf("PM-5000-KIT", CATALOG, half)).toBeNull();
  });
});

describe("an unpriced part is not a free part", () => {
  const kit = kitForModel({
    model: "1260 LC", category: "LC",
    procedures: [LC_PM], catalog: CATALOG, prices: PRICES,
  });

  it("names what it could not price instead of totalling it as nothing", () => {
    expect(kit.unpriced).toEqual(["5067-1234"]);
    expect(kit.partsCentsPerYear).toBe(0);
    expect(kit.lines[0].priced).toBe(false);
  });

  it("names what it could not time", () => {
    const untimed = kitForModel({
      model: "API 5000", category: "LC-MS",
      procedures: [{ ...PM_5000, estMinutes: 0 }], catalog: CATALOG, prices: PRICES,
    });
    expect(untimed.minutesPerYear).toBe(0);
    expect(untimed.untimed).toEqual(["API 5000 annual PM"]);
  });

  it("takes a price that turns up on the second mention", () => {
    // Same consumable, one row with the number and one without. The row that
    // knows the number is the one that should decide the price.
    const vague = proc({
      id: 9, name: "Wipe down", intervalDays: 182,
      parts: JSON.stringify([{ name: "Pump oil (AVF Gold)", number: "" }]),
    });
    const kit = kitForModel({
      model: "API 5000", category: "LC-MS",
      procedures: [vague, PM_5000], catalog: CATALOG, prices: PRICES,
    });
    // The nameless row merges into the priced one rather than sitting beside it.
    expect(kit.lines.filter((l) => l.name.startsWith("Pump oil"))).toHaveLength(1);
    expect(kit.lines.find((l) => l.partNumber === "228-35145-91")!.qty).toBe(2 * 2 + 2);
  });

  it("never merges two different part numbers however alike their names", () => {
    /*
     * The case folding must not get wrong. "Seal kit" is four things, and an
     * LC-20 seal kit priced as an LC-30's is a bid that loses money quietly.
     */
    const a = proc({ id: 7, name: "Pump A", intervalDays: 365, parts: JSON.stringify([{ name: "Seal kit", number: "5067-1234" }]) });
    const b = proc({ id: 8, name: "Pump B", intervalDays: 365, parts: JSON.stringify([{ name: "Seal kit", number: "5067-9999" }]) });
    const kit = kitForModel({
      model: "any", category: "LC", procedures: [a, b], catalog: CATALOG, prices: PRICES,
    });
    expect(kit.lines).toHaveLength(2);
    expect(kit.lines.every((l) => l.qty === 1)).toBe(true);
  });
});

describe("scoping", () => {
  it("empty scope means every model, which is the catalog's convention", () => {
    expect(proceduresForModel([FLUSH], "API 6500", "LC-MS")).toHaveLength(1);
    expect(proceduresForModel([FLUSH], "7890 GC", "GC")).toHaveLength(0);
    expect(proceduresForModel([PM_5000], "API 6500", "LC-MS")).toHaveLength(0);
  });

  it("has nothing to say about a model nobody has written up", () => {
    const empty = kitForModel({
      model: "API 7500", category: "LC-MS", procedures: [PM_5000, LC_PM],
      catalog: CATALOG, prices: PRICES,
    });
    expect(empty.lines).toEqual([]);
    expect(empty.minutesPerYear).toBe(0);
    expect(empty.visitsPerYear).toBeNull();
    expect(kitIsEmpty(empty)).toBe(true);
  });
});
