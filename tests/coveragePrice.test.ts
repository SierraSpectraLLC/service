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
  allocate, estimate, estimateProblems, periodLabel, periodWindows, reserveCost, reserveTerms,
  siteCost, tripsPerYear,
  type CoverageInput, type CoverageSite, type ResponseReserve,
} from "@/lib/coveragePrice";

const CAPPED: ResponseReserve = {
  tripsPerYear: 2, hoursPerTrip: 8, tripCostCents: 220_000, partsCents: 300_000,
  unlimitedTrips: false, unlimitedParts: false, uncappedLoadBps: 0,
};
const NO_RESERVE: ResponseReserve = { ...CAPPED, tripsPerYear: 0, hoursPerTrip: 0, tripCostCents: 0, partsCents: 0 };

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
  reserve: CAPPED,
  overheadBps: 1200,
  marginBps: 3000,
  periods: 5,
  escalationBps: 300,
  deescalationBps: 0,
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
      reserve: NO_RESERVE,
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

  it("reports hours as a number a person would write", () => {
    // 4 visits x 5.8 h is 23.200000000000003 in binary floating point, and a
    // site strip saying "57.599999999999994h" makes every other figure on the
    // page look untrustworthy.
    const odd = siteCost({
      name: "x", tripCostCents: 100, tripHours: 8, batched: true,
      systems: [{ name: "a", visitsPerYear: 4, hoursPerVisit: 5.8, partsCentsPerVisit: 0 }],
    }, 9_000);
    expect(odd.onsiteHours).toBe(23.2);
    expect(String(odd.onsiteHours)).not.toContain("0000");
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
    const without = estimate({ ...BASE, reserve: NO_RESERVE });
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

describe("an uncapped promise", () => {
  const unlimited: ResponseReserve = {
    ...CAPPED, unlimitedTrips: true, unlimitedParts: true, uncappedLoadBps: 5000,
  };

  it("prices off the year we expect, plus what absorbing the tail is worth", () => {
    /*
     * Unlimited does not mean unpriced. Two callouts and $3,000 of emergency
     * stock is still what a normal year is expected to bring - the toggle only
     * says the client is not cut off at that point - so the expectation is
     * unchanged and a 50% loading is what we charge for owning the bad year.
     */
    const capped = reserveCost(CAPPED, 9_000);
    const open = reserveCost(unlimited, 9_000);
    expect(open.expectedCents).toBe(capped.expectedCents);
    expect(capped.loadCents).toBe(0);
    expect(open.loadCents).toBe(Math.round(capped.expectedCents / 2));
    expect(open.totalCents).toBe(open.expectedCents + open.loadCents);
  });

  it("loads only the leg that is actually uncapped", () => {
    const partsOnly = reserveCost({ ...unlimited, unlimitedTrips: false }, 9_000);
    const full = reserveCost(unlimited, 9_000);
    expect(partsOnly.loadCents).toBe(Math.round(partsOnly.partsCents / 2));
    expect(partsOnly.loadCents).toBeLessThan(full.loadCents);
  });

  it("puts the loading in the price and NOT in the time-and-materials comparison", () => {
    /*
     * The one that matters. A client without a contract pays for the callouts
     * they have, not a premium for a promise nobody made them - so loading the
     * T&M side would flatter the contract by pretending both carry the same
     * risk, when absorbing that risk is the thing being sold.
     */
    const capped = estimate(BASE);
    const open = estimate({ ...BASE, reserve: unlimited });
    expect(open.uncappedLoadCents).toBeGreaterThan(0);
    expect(open.reserveCents).toBe(capped.reserveCents + open.uncappedLoadCents);
    expect(open.priceCents).toBeGreaterThan(capped.priceCents);
    expect(open.tmCents).toBe(capped.tmCents);
    expect(open.savingBps).toBeLessThan(capped.savingBps);
  });

  it("says on the quote what the client actually bought", () => {
    expect(reserveTerms(CAPPED)).toBe("");
    expect(reserveTerms(unlimited)).toBe("unlimited callouts · unlimited emergency parts");
    expect(reserveTerms({ ...unlimited, unlimitedParts: false })).toBe("unlimited callouts");
    expect(estimate({ ...BASE, reserve: unlimited }).line).toContain("unlimited callouts");
  });

  it("refuses to price unlimited off nothing", () => {
    // The most expensive thing this form could let somebody do: a promise
    // costed at zero, discovered on the first emergency of the base year.
    const empty = estimateProblems({ ...BASE, reserve: { ...unlimited, tripsPerYear: 0, partsCents: 0 } });
    expect(empty.some((x) => x.includes("Unlimited callouts, but the price expects none"))).toBe(true);
    expect(empty.some((x) => x.includes("Unlimited emergency parts"))).toBe(true);

    const free = estimateProblems({ ...BASE, reserve: { ...unlimited, uncappedLoadBps: 0 } });
    expect(free.some((x) => x.includes("no loading"))).toBe(true);
    expect(estimateProblems({ ...BASE, reserve: unlimited })).toEqual([]);
  });

  it("leaves a capped reserve exactly as it was", () => {
    // A loading typed and then switched off must not leak into the price.
    expect(estimate({ ...BASE, reserve: { ...CAPPED, uncappedLoadBps: 5000 } }).priceCents)
      .toBe(estimate(BASE).priceCents);
  });
});

describe("de-escalating a multi-year term", () => {
  const TERM = { ...BASE, deescalationBps: 200 };

  it("leaves the base year alone and discounts each option year further", () => {
    const e = estimate(TERM);
    const flat = estimate(BASE);
    expect(e.periods[0].priceCents).toBe(flat.periods[0].priceCents);
    expect(e.periods[0].discountCents).toBe(0);
    for (let i = 1; i < 5; i++) {
      expect(e.periods[i].priceCents).toBeLessThan(flat.periods[i].priceCents);
      expect(e.periods[i].discountCents).toBeGreaterThan(e.periods[i - 1].discountCents);
    }
    // 3% up and 2% back, compounded, to the dollar.
    expect(e.periods[4].priceCents).toBe(Math.round((e.priceCents * 1.03 ** 4 * 0.98 ** 4) / 100) * 100);
  });

  it("comes off the price and not off what the year costs us", () => {
    /*
     * The distinction the field exists on. Nobody's flights get cheaper because
     * a client signed for five years - the give-back is margin, and pretending
     * it is a cost saving is how an option year quietly prices below cost.
     */
    const e = estimate(TERM);
    const flat = estimate(BASE);
    expect(e.periods.map((p) => p.costCents)).toEqual(flat.periods.map((p) => p.costCents));
    expect(e.periods[4].priceCents - e.periods[4].costCents)
      .toBeLessThan(flat.periods[4].priceCents - flat.periods[4].costCents);
  });

  it("totals the give-back against the list price", () => {
    const e = estimate(TERM);
    expect(e.listTotalCents).toBe(estimate(BASE).totalCents);
    expect(e.deescalationCents).toBe(e.listTotalCents - e.totalCents);
    expect(e.deescalationCents).toBe(e.periods.reduce((a, p) => a + p.discountCents, 0));
    expect(e.line).toContain("Committing to all 5 years gives back");
  });

  it("gives a single-year quote nothing, because nothing was committed", () => {
    const one = estimate({ ...TERM, periods: 1 });
    expect(one.deescalationCents).toBe(0);
    expect(one.totalCents).toBe(estimate({ ...BASE, periods: 1 }).totalCents);
    expect(one.line).not.toContain("gives back");
  });

  it("says so when the give-back has eaten the margin", () => {
    // 10%/yr off a 30% margin is under water by option year 4, and a schedule
    // that loses money in its last period is not noticed until its last period.
    expect(estimateProblems({ ...BASE, deescalationBps: 1000 })
      .some((x) => x.includes("Option year 4 de-escalates below what it costs"))).toBe(true);
    expect(estimateProblems({ ...BASE, deescalationBps: 200 })).toEqual([]);
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

  it("refuses free labor and an impossible margin", () => {
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

describe("the window each CLIN covers", () => {
  it("ends the day before the anniversary", () => {
    // The solicitation's own words: Sep. 29, 2026 through Sep. 28, 2027.
    expect(periodWindows("2026-09-29", 3)).toEqual([
      { from: "2026-09-29", to: "2027-09-28" },
      { from: "2027-09-29", to: "2028-09-28" },
      { from: "2028-09-29", to: "2029-09-28" },
    ]);
  });

  it("clamps a leap day rather than sliding into March", () => {
    expect(periodWindows("2028-02-29", 2)).toEqual([
      { from: "2028-02-29", to: "2029-02-27" },
      { from: "2029-02-28", to: "2030-02-27" },
    ]);
  });

  it("leaves the windows blank rather than inventing a start", () => {
    expect(periodWindows("", 2)).toEqual([{ from: "", to: "" }, { from: "", to: "" }]);
    expect(periodWindows("2026-09-29", 0)).toEqual([]);
  });
});
