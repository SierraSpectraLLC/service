// Pricing a contract off a plan instead of off history.
//
// The worked example throughout is the NIST solicitation this was built for:
// four AB Sciex triple quads and an Agilent LC at Gaithersburg, two more
// systems at Charleston, a base year and four option years, all travel in the
// price. Every number below is an assumption that can be argued with - what is
// being tested is the ARITHMETIC, and above all the one claim the bid rests
// on: a round of PMs is one journey, not one journey per instrument.
import { describe, expect, it } from "vitest";
import {
  allocate, estimate, estimateProblems, periodLabel, siteCost, tripsPerYear,
  type CoverageInput, type CoverageSite,
} from "@/lib/coveragePrice";

const sciex = (name: string, visits = 2) => ({
  name, visitsPerYear: visits, hoursPerVisit: 8, partsCentsPerVisit: 120_000,
});

const GAITHERSBURG: CoverageSite = {
  name: "NIST Gaithersburg",
  tripCostCents: 180_000,   // flights, hotel, car, per diem for the round
  tripHours: 10,
  batched: true,
  systems: [
    sciex("API 4000"), sciex("API 5000"), sciex("API 5500"), sciex("API 6500 SelexION"),
    { name: "Agilent 1260 LC", visitsPerYear: 1, hoursPerVisit: 4, partsCentsPerVisit: 40_000 },
  ],
};

const BASE: CoverageInput = {
  sites: [GAITHERSBURG],
  laborCostPerHourCents: 9_000,
  laborBillPerHourCents: 22_500,
  partsMarkupBps: 3000,
  reserve: { tripsPerYear: 2, hoursPerTrip: 8, tripCostCents: 220_000, partsCents: 300_000 },
  overheadBps: 1200,
  marginBps: 3000,
  periods: 5,
  escalationBps: 300,
};

describe("a round of visits is one journey", () => {
  it("counts journeys off the busiest system, not off the visits", () => {
    /*
     * The claim the whole module exists for. Five systems, nine visits a year
     * between them - and TWO trips to Maryland, because everything in the
     * building is serviced on the same visit and the annual LC rides along on
     * one of them. Counting nine journeys would put roughly $12,600 of travel
     * that will never happen into a firm-fixed price, which is how a bid is
     * lost to an incumbent who knows better.
     */
    expect(tripsPerYear(GAITHERSBURG)).toBe(2);
  });

  it("counts every visit when they cannot be taken together", () => {
    // A client who will not release two mass specs in the same week. Real, and
    // it is the difference between a winnable price and an unfundable one.
    expect(tripsPerYear({ ...GAITHERSBURG, batched: false })).toBe(9);
  });

  it("has no journeys to a site with nothing on it", () => {
    expect(tripsPerYear({ ...GAITHERSBURG, systems: [] })).toBe(0);
  });
});

describe("what the marginal system costs", () => {
  const withLc = siteCost(GAITHERSBURG, 9_000);
  const withoutLc = siteCost(
    { ...GAITHERSBURG, systems: GAITHERSBURG.systems.slice(0, 4) }, 9_000);

  it("adds no travel at all to a site we are already standing in", () => {
    // Why an incumbent can always underbid on the fifth instrument.
    expect(withLc.travelCents).toBe(withoutLc.travelCents);
    expect(withLc.totalCents - withoutLc.totalCents)
      .toBe(1 * 4 * 9_000 + 40_000);   // its hours and its kit, and nothing else
  });

  it("charges the annual system a smaller share of the journeys than a twice-yearly one", () => {
    const lc = withLc.systems.find((s) => s.name === "Agilent 1260 LC")!;
    const ms = withLc.systems.find((s) => s.name === "API 4000")!;
    expect(lc.travelCents).toBeLessThan(ms.travelCents);
    expect(ms.travelCents).toBe(2 * lc.travelCents);
  });

  it("allocates the journeys to the cent", () => {
    const shares = withLc.systems.reduce((a, s) => a + s.travelCents, 0);
    expect(shares).toBe(withLc.travelCents);
  });
});

describe("splitting a pot exactly", () => {
  it("never loses or invents a penny", () => {
    expect(allocate(100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(100);
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(7, [2, 1])).toEqual([5, 2]);
  });

  it("gives nothing away when there is nothing to weigh it by", () => {
    expect(allocate(500, [0, 0])).toEqual([0, 0]);
    expect(allocate(500, [])).toEqual([]);
  });
});

describe("cost to price", () => {
  it("treats margin as margin, not as markup", () => {
    /*
     * A 30% markup on $70,000 is $91,000. A 30% MARGIN is $100,000. Quoting
     * the first while believing the second is the commonest way a contract
     * that looked profitable turns out not to be, so it gets a test.
     */
    const flat = estimate({
      ...BASE, periods: 1, overheadBps: 0, escalationBps: 0, marginBps: 3000,
      reserve: { tripsPerYear: 0, hoursPerTrip: 0, tripCostCents: 0, partsCents: 0 },
    });
    expect(flat.priceCents).toBe(Math.round((flat.costCents / 0.7) / 100) * 100);
    expect(flat.priceCents).toBeGreaterThan(flat.costCents * 1.3);
  });

  it("compounds the option years rather than repeating the base", () => {
    const e = estimate(BASE);
    expect(e.periods).toHaveLength(5);
    expect(e.periods.map((p) => p.label))
      .toEqual(["Base year", "Option year 1", "Option year 2", "Option year 3", "Option year 4"]);
    expect(e.periods[1].priceCents).toBeGreaterThan(e.periods[0].priceCents);
    // 3% a year compounded, to the dollar.
    expect(e.periods[4].priceCents).toBe(Math.round((e.priceCents * 1.03 ** 4) / 100) * 100);
    expect(e.totalCents).toBe(e.periods.reduce((a, p) => a + p.priceCents, 0));
  });

  it("prices in whole dollars", () => {
    for (const p of estimate(BASE).periods) expect(p.priceCents % 100).toBe(0);
  });

  it("compares like with like on the reserve", () => {
    /*
     * The wrong version of this compared a price CARRYING the response reserve
     * against a T&M year without one, so the contract lost by construction. A
     * client with no contract still has the emergencies - they pay per call
     * when they happen - so the reserve's work is on both sides or neither.
     */
    const withReserve = estimate(BASE);
    const without = estimate({
      ...BASE, reserve: { tripsPerYear: 0, hoursPerTrip: 0, tripCostCents: 0, partsCents: 0 },
    });
    expect(withReserve.tmCents).toBeGreaterThan(without.tmCents);
    expect(withReserve.priceCents).toBeGreaterThan(without.priceCents);
  });

  it("says so when the fixed price lands above what the year would bill per call", () => {
    // The number that decides whether to bid. Never silently omitted.
    const dear = estimate({ ...BASE, marginBps: 7000 });
    expect(dear.savingBps).toBeLessThan(0);
    expect(dear.line).toContain("ABOVE the same year billed per call");
  });

  it("bills parts at a markup on the time-and-materials side", () => {
    const at30 = estimate(BASE);
    const atCost = estimate({ ...BASE, partsMarkupBps: 0 });
    expect(at30.tmCents).toBeGreaterThan(atCost.tmCents);
  });
});

describe("more than one place of performance", () => {
  const CHARLESTON: CoverageSite = {
    name: "Hollings Marine Laboratory",
    tripCostCents: 210_000, tripHours: 12, batched: true,
    systems: [sciex("API 5500 (HML)"), sciex("API 6500 (HML)")],
  };

  it("pays for each building's journeys separately", () => {
    const e = estimate({ ...BASE, sites: [GAITHERSBURG, CHARLESTON] });
    expect(e.sites.map((s) => s.trips)).toEqual([2, 2]);
    // Two addresses, four journeys - not one itinerary that magically covers both.
    expect(e.directCents).toBeGreaterThan(estimate(BASE).directCents);
  });
});

describe("an estimate that cannot be trusted says so", () => {
  it("names a site whose travel has not been costed", () => {
    const problems = estimateProblems({
      ...BASE, sites: [{ ...GAITHERSBURG, tripCostCents: 0 }],
    });
    expect(problems.some((p) => p.includes("NIST Gaithersburg"))).toBe(true);
  });

  it("refuses free labour and an impossible margin", () => {
    expect(estimateProblems({ ...BASE, laborCostPerHourCents: 0 })
      .some((p) => p.includes("costs nothing"))).toBe(true);
    expect(estimateProblems({ ...BASE, marginBps: 10000 })
      .some((p) => p.includes("100%"))).toBe(true);
  });

  it("is happy with the real one", () => {
    expect(estimateProblems({ ...BASE, sites: [GAITHERSBURG] })).toEqual([]);
    expect(periodLabel(0)).toBe("Base year");
  });
});
