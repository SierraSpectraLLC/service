import { describe, expect, it } from "vitest";
import { normalizePn, rankPrices, pricesFor, bestPrice, groupByPn } from "@/lib/priceBook";
import { centsToInput } from "@/lib/money";

const entry = (partNumber: string, vendor: string, priceCents: number, isOem = false) =>
  ({ partNumber, vendor, priceCents, isOem });

describe("normalizePn", () => {
  it("ignores case and spaces but keeps dashes", () => {
    expect(normalizePn("228-35145-91 ")).toBe("228-35145-91");
    expect(normalizePn("G6303-80060")).toBe(normalizePn("g6303-80060"));
    expect(normalizePn("228 35145 91")).toBe("2283514591");
    // Dash position is part of the number - these must stay distinct.
    expect(normalizePn("5181-3323")).not.toBe(normalizePn("51813-323"));
  });
});

describe("rankPrices", () => {
  it("sorts cheapest first, OEM winning ties", () => {
    const ranked = rankPrices([
      entry("A", "ThirdParty", 9550),
      entry("A", "Shimadzu", 9550, true),
      entry("A", "Restek", 8000),
    ]);
    expect(ranked.map((r) => r.vendor)).toEqual(["Restek", "Shimadzu", "ThirdParty"]);
  });

  it("leaves the input array alone", () => {
    const rows = [entry("A", "B", 200), entry("A", "A", 100)];
    rankPrices(rows);
    expect(rows[0].vendor).toBe("B");
  });
});

describe("pricesFor / bestPrice", () => {
  const book = [
    entry("228-35145-91", "Shimadzu", 12900, true),
    entry("228-35145-91", "Chrom Tech", 9800),
    entry("G6303-80060", "Agilent", 410000, true),
  ];

  it("matches across case and spacing, best offer first", () => {
    const hits = pricesFor(book, "  228-35145-91");
    expect(hits.map((r) => r.vendor)).toEqual(["Chrom Tech", "Shimadzu"]);
    expect(bestPrice(book, "228-35145-91")?.vendor).toBe("Chrom Tech");
  });

  it("is empty-safe on unknown and blank PNs", () => {
    expect(pricesFor(book, "nope")).toEqual([]);
    expect(bestPrice(book, "")).toBeNull();
  });
});

describe("groupByPn", () => {
  it("folds one PN's offers together, best first", () => {
    const grouped = groupByPn([
      entry("a-1", "X", 300),
      entry("A-1", "Y", 100),
      entry("b-2", "Z", 50),
    ]);
    expect(grouped.size).toBe(2);
    expect(grouped.get("a-1")!.map((r) => r.vendor)).toEqual(["Y", "X"]);
  });
});

describe("centsToInput", () => {
  it("round-trips through a cost field", () => {
    expect(centsToInput(124000)).toBe("1,240");
    expect(centsToInput(9550)).toBe("95.50");
    expect(centsToInput(50)).toBe("0.50");
  });
});
