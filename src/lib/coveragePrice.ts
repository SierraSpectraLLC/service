// What a coverage contract COSTS us, and what it should therefore be priced at.
//
// The other half of a pair. lib/quotes' contractProposal prices a contract off
// a client's own HISTORY - here is what you spent with us over eight months,
// here is that annualised with a discount on it - and that is the right
// instrument for UCSF and MID, where we already know the pace because we lived
// it. It cannot price work nobody has done yet, and it has nothing to say about
// a second building nine hundred miles away.
//
// This is the same output built the other way round: off a PLAN. So many
// systems, at so many addresses, so many visits each, and a firm price for a
// twelve-month period that has not started - which is what an RFQ asks for and
// what every multi-site, multi-year award is.
//
// The idea the whole module exists for is TRIP AMORTISATION.
//
// A visit is not a trip. Four mass specs in one building on a two-visit-a-year
// plan is not eight journeys to Maryland - it is two rounds, and each round
// pays for the flight once. Price it per instrument and the fourth instrument
// looks as expensive as the first; price it per trip and the truth appears -
// the marginal system on a site we are already standing in costs its hours and
// its parts and no travel at all. That is why an incumbent can always underbid
// you on the fifth instrument, and it is the number a fixed-price bid lives or
// dies on. The allocation back down to each system is exact to the cent
// (largest remainder), because "travel is in there somewhere" is not something
// a client's procurement officer will accept.
//
// Pure. Costs in, a price out, no database and no rate card lookups - the
// caller resolves those. Everything is integer cents.

import { formatCents } from "@/lib/money";

/** One system on the contract, and what one visit to it takes. */
export type CoveredSystem = {
  name: string;
  /** Preventive visits a year. From pm_plans, or typed for a bid. */
  visitsPerYear: number;
  /** Engineer-hours ON the system per visit - not counting getting there. */
  hoursPerVisit: number;
  /** Kit, columns, calibration solution: what one visit consumes. */
  partsCentsPerVisit: number;
};

/** One place of performance, and what it costs to stand in it. */
export type CoverageSite = {
  name: string;
  /**
   * One round trip: airfare, hotel, rental, per diem, or miles at the shop's
   * rate. The cost of ARRIVING, however we arrive - so a drive-to site is the
   * same shape as a fly-to one and the arithmetic below never branches on it.
   */
  tripCostCents: number;
  /** Door to door and back, in engineer-hours. Paid, and rarely billed. */
  tripHours: number;
  /**
   * Can a round of visits be done in one journey?
   *
   * True is the plan and the reason the bid is winnable: everything at this
   * address is serviced on the same trip, so the number of journeys a year is
   * the BUSIEST system's visit count, not the sum. False is the pessimistic
   * case - a site whose systems cannot be taken down together, or a client who
   * schedules them months apart - where every visit is its own journey.
   */
  batched: boolean;
  systems: CoveredSystem[];
};

export type CoverageInput = {
  sites: CoverageSite[];
  /**
   * A loaded engineer-hour: wage, tax, insurance, vehicle, the lot. NOT the
   * billing rate - this side of the estimate is cost, and pricing a fixed-fee
   * contract off the rate card is how a shop wins a bid and loses money on it.
   */
  laborCostPerHourCents: number;
  /** What the same hour would BILL at, so the discount can be stated. */
  laborBillPerHourCents: number;
  /** What parts BILL at over cost on time and materials, for the same comparison. */
  partsMarkupBps: number;
  /**
   * What the 48-hour-response promise is worth. An emergency contract is an
   * option the client is buying and we are writing: some number of unplanned
   * journeys a year, at some length, with parts. Held as its own line rather
   * than smeared into an overhead percentage, because it is the assumption a
   * losing bid is usually wrong about, and it should be arguable on its own.
   */
  reserve: { tripsPerYear: number; hoursPerTrip: number; tripCostCents: number; partsCents: number };
  /** Everything the shop costs that no job causes, as bps of direct cost. */
  overheadBps: number;
  /**
   * Margin ON THE PRICE, not markup on cost - price = cost / (1 - margin).
   * A 30% markup is a 23% margin, and quoting one believing the other is the
   * commonest way a contract that looked profitable is not.
   */
  marginBps: number;
  /** How many 12-month periods to price. A base year plus four options is 5. */
  periods: number;
  /** Uplift compounded on each period after the first, for the option years. */
  escalationBps: number;
};

export type SystemShare = {
  name: string;
  visitsPerYear: number;
  laborCents: number;
  partsCents: number;
  /** This system's share of the site's journeys - the amortisation. */
  travelCents: number;
  totalCents: number;
};

export type SiteCost = {
  name: string;
  /** Journeys a year. The number the whole module exists to get right. */
  trips: number;
  /** Hours on systems, across every visit. */
  onsiteHours: number;
  /** Hours getting there and back, across every journey. */
  travelHours: number;
  laborCents: number;
  partsCents: number;
  travelCents: number;
  totalCents: number;
  systems: SystemShare[];
};

export type Period = {
  /** 0 is the base year. */
  index: number;
  label: string;
  costCents: number;
  priceCents: number;
};

export type CoverageEstimate = {
  sites: SiteCost[];
  directCents: number;
  reserveCents: number;
  overheadCents: number;
  /** One period's cost, before margin. */
  costCents: number;
  /** One period's price. */
  priceCents: number;
  periods: Period[];
  /** Every period added up - the "total five-year price" an RFQ asks for. */
  totalCents: number;
  /** What one period's work would come to at time and materials. */
  tmCents: number;
  /** How far under T&M the base year is, in bps. Negative means over. */
  savingBps: number;
  line: string;
  problems: string[];
};

const cents = (n: number) => Math.round(n);
/** Prices to the dollar. A projection printed to the cent claims a precision it hasn't got. */
const toDollar = (n: number) => Math.round(n / 100) * 100;
const hours = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
const count = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/**
 * Journeys a year to one site.
 *
 * Batched: the busiest system sets the rhythm and everything else rides along,
 * so four systems on two visits a year and one on one visit is TWO journeys -
 * and the annual LC PM happens on whichever round it lands nearest.
 * Unbatched: every visit is its own journey.
 */
export function tripsPerYear(site: CoverageSite): number {
  const visits = site.systems.map((s) => count(s.visitsPerYear));
  if (visits.length === 0) return 0;
  return site.batched ? Math.max(...visits) : visits.reduce((a, b) => a + b, 0);
}

/**
 * Split a pot of money across weights, exactly, to the cent.
 *
 * Largest remainder: every share is floored, then the leftover pennies go to
 * whoever was robbed most by the flooring. The shares sum to the total - which
 * matters here because these numbers get read across a table and a row that
 * does not add up is the one thing a procurement officer will notice.
 */
export function allocate(totalCents: number, weights: number[]): number[] {
  const total = cents(totalCents);
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (sum <= 0 || weights.length === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (Math.max(0, w) * total) / sum);
  const out = exact.map((x) => Math.floor(x));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k].i]++;
  return out;
}

/** One site's year: what it costs to keep its systems running. */
export function siteCost(site: CoverageSite, laborCostPerHourCents: number): SiteCost {
  const rate = Math.max(0, cents(laborCostPerHourCents));
  const trips = tripsPerYear(site);
  const travelHours = trips * hours(site.tripHours);
  const travelCents = cents(trips * Math.max(0, site.tripCostCents) + travelHours * rate);

  const onsite = site.systems.map((s) => count(s.visitsPerYear) * hours(s.hoursPerVisit));
  const onsiteHours = onsite.reduce((a, b) => a + b, 0);
  const labor = onsite.map((h) => cents(h * rate));
  const parts = site.systems.map((s) => cents(count(s.visitsPerYear) * Math.max(0, s.partsCentsPerVisit)));

  /*
   * Travel is allocated by VISITS, not evenly and not by hours. A system
   * serviced twice a year is the reason for twice as many journeys as one
   * serviced annually, so it carries twice the travel - and the annual LC
   * riding along on a trip already being made carries a small share rather
   * than a fifth of the airfare. Even splitting would flatter the LC and
   * overprice the mass specs, which is exactly backwards from how the client
   * will want to drop a line item.
   */
  const travelShare = allocate(travelCents, site.systems.map((s) => count(s.visitsPerYear)));

  const systems: SystemShare[] = site.systems.map((s, i) => ({
    name: s.name,
    visitsPerYear: count(s.visitsPerYear),
    laborCents: labor[i],
    partsCents: parts[i],
    travelCents: travelShare[i],
    totalCents: labor[i] + parts[i] + travelShare[i],
  }));

  const laborCents = labor.reduce((a, b) => a + b, 0);
  const partsCents = parts.reduce((a, b) => a + b, 0);
  return {
    name: site.name,
    trips,
    onsiteHours,
    travelHours,
    laborCents,
    partsCents,
    travelCents,
    totalCents: laborCents + partsCents + travelCents,
    systems,
  };
}

/** What the label on a period is. The words an RFQ uses. */
export const periodLabel = (i: number): string => (i === 0 ? "Base year" : `Option year ${i}`);

/** Everything wrong with an estimate, said plainly. Empty means it is usable. */
export function estimateProblems(input: CoverageInput): string[] {
  const out: string[] = [];
  if (input.sites.every((s) => s.systems.length === 0)) out.push("No systems on the contract yet");
  if (count(input.laborCostPerHourCents) === 0) out.push("An hour of labour costs nothing - the price will be wrong");
  if (input.marginBps >= 10000) out.push("A margin of 100% or more cannot be priced");
  if (count(input.periods) === 0) out.push("Price at least one 12-month period");
  const untravelled = input.sites.filter((s) => s.systems.length > 0 && Math.max(0, s.tripCostCents) === 0);
  if (untravelled.length > 0) {
    // The failure this module exists to prevent, so it is said out loud rather
    // than left to be noticed in the total.
    out.push(`Travel to ${untravelled.map((s) => s.name || "a site").join(", ")} costs nothing yet`);
  }
  return out;
}

/**
 * The estimate.
 *
 * Direct cost, plus the response reserve, plus overhead on both, is what a
 * period costs. Margin makes it a price. Each option year is the one before it
 * escalated, which is how a five-year firm-fixed schedule is actually built -
 * the client wants one number per CLIN and the numbers must climb for a
 * defensible reason rather than because somebody rounded upward five times.
 */
export function estimate(input: CoverageInput): CoverageEstimate {
  const problems = estimateProblems(input);
  const rate = Math.max(0, cents(input.laborCostPerHourCents));
  const sites = input.sites.map((s) => siteCost(s, rate));
  const directCents = sites.reduce((a, s) => a + s.totalCents, 0);

  const r = input.reserve;
  const reserveCents = cents(
    count(r.tripsPerYear) * (Math.max(0, r.tripCostCents) + hours(r.hoursPerTrip) * rate)
    + Math.max(0, r.partsCents),
  );

  const overheadCents = cents(((directCents + reserveCents) * Math.max(0, input.overheadBps)) / 10000);
  const costCents = directCents + reserveCents + overheadCents;

  const margin = Math.min(9900, Math.max(0, input.marginBps));
  const priceCents = toDollar((costCents * 10000) / (10000 - margin));

  const n = count(input.periods);
  const esc = Math.max(0, input.escalationBps);
  const periods: Period[] = [];
  for (let i = 0; i < n; i++) {
    const factor = (1 + esc / 10000) ** i;
    periods.push({
      index: i,
      label: periodLabel(i),
      costCents: cents(costCents * factor),
      priceCents: toDollar(priceCents * factor),
    });
  }

  /*
   * The same year at time and materials, for the sentence that sells it - or
   * for the sentence that says do not bid this.
   *
   * Like for like, which took one wrong version to get right. The first cut
   * compared a contract price that CARRIES the response reserve against a T&M
   * year that did not, so the contract lost every time by construction. But a
   * client without a contract still has the emergencies: they just pay for
   * them per call, at the rate card, when they happen. So the reserve's own
   * work belongs in this figure too, billed the way it would actually be
   * billed. Anything else is comparing a year that includes February against
   * a year that does not.
   *
   * Travel hours at the full rate is deliberately conservative - a shop that
   * discounts travel should say so in its rate card, and overstating T&M to
   * flatter the contract is a lie the client can check line by line.
   */
  const bill = Math.max(0, cents(input.laborBillPerHourCents));
  const markup = (n: number) => cents((n * (10000 + Math.max(0, input.partsMarkupBps))) / 10000);
  const planned = sites.reduce((a, s) => {
    const tripCash = s.travelCents - s.travelHours * rate;
    return a + (s.onsiteHours + s.travelHours) * bill + markup(s.partsCents) + tripCash;
  }, 0);
  const reserveOnTm = count(r.tripsPerYear) * (hours(r.hoursPerTrip) * bill + Math.max(0, r.tripCostCents))
    + markup(Math.max(0, r.partsCents));
  const tmCents = cents(planned + reserveOnTm);
  const base = periods[0]?.priceCents ?? priceCents;
  const savingBps = tmCents > 0 ? Math.round(((tmCents - base) / tmCents) * 10000) : 0;

  const totalCents = periods.reduce((a, p) => a + p.priceCents, 0);
  const trips = sites.reduce((a, s) => a + s.trips, 0);
  const systems = sites.reduce((a, s) => a + s.systems.length, 0);
  const line = systems === 0 ? "" :
    `${systems} system${systems === 1 ? "" : "s"} across ${sites.length} site${sites.length === 1 ? "" : "s"}, `
    + `${trips} planned journey${trips === 1 ? "" : "s"} a year. `
    + `${formatCents(base)} for the base year`
    + (n > 1 ? `, ${formatCents(totalCents)} over ${n} years` : "")
    + (savingBps > 0
      ? ` - ${(savingBps / 100).toFixed(0)}% under time and materials.`
      : savingBps < 0
        // Said out loud rather than left off. A fixed price ABOVE what the same
        // year would bill per call is not automatically wrong - the client is
        // buying certainty and a 48-hour promise - but it is the number that
        // decides whether to bid, and a summary that quietly omitted it would
        // be the most expensive omission in the module.
        ? ` - ${(-savingBps / 100).toFixed(0)}% ABOVE the same year billed per call.`
        : ".");

  return {
    sites, directCents, reserveCents, overheadCents, costCents, priceCents,
    periods, totalCents, tmCents, savingBps, line, problems,
  };
}
