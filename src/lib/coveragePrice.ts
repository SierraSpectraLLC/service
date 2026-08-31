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

/**
 * What the 48-hour promise is made of.
 *
 * Capped or uncapped, the ARITHMETIC needs a number of callouts and a parts
 * figure, because a year is priced off what we expect to spend in it. So
 * "unlimited" does not blank those fields - it changes what they MEAN. Capped,
 * they are the ceiling: this many callouts, this much emergency stock, and the
 * client buys the rest per call. Uncapped, they are the EXPECTATION - our
 * honest guess at a normal year - and the client may call as often as they
 * need to.
 *
 * Which is why an uncapped promise carries a loading. Unlimited does not make
 * the bad year less likely, it moves who pays for it: the tail we would have
 * billed per call is now ours, and a contract that prices an uncapped promise
 * at exactly the expectation has given that tail away for nothing. The loading
 * is a percentage rather than a fixed sum so it scales with the promise, and
 * it is typed rather than assumed because the right number is a judgment about
 * this client's instruments and this shop's luck.
 */
export type ResponseReserve = {
  /**
   * Unplanned journeys a year. A ceiling when capped; when `unlimitedTrips`,
   * what a normal year is expected to bring - not a limit on the client.
   */
  tripsPerYear: number;
  hoursPerTrip: number;
  tripCostCents: number;
  /** Emergency parts for the year. Expectation, not ceiling, when uncapped. */
  partsCents: number;
  /** Callouts are uncapped: the client calls as often as they need. */
  unlimitedTrips: boolean;
  /** Emergency parts are uncapped. */
  unlimitedParts: boolean;
  /**
   * What writing an uncapped promise costs on top of the expectation, in bps
   * of whichever legs are uncapped. Nothing when both are capped.
   */
  uncappedLoadBps: number;
};

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
  reserve: ResponseReserve;
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
  /**
   * The multi-year discount, compounded on each period after the first.
   *
   * The other side of escalation, and a different kind of number. Escalation
   * is a COST fact - the same year of work costs more in 2029 than in 2026 -
   * so it lifts cost and price alike. De-escalation is a PRICE decision: what
   * we give back for the client committing to the whole term rather than
   * re-competing it every twelve months. Our costs do not fall because
   * somebody signed for five years, so this comes off the price only, and the
   * margin in the late option years genuinely narrows. That is the trade, and
   * it is worth being able to see: `estimateProblems` says so when the
   * give-back has eaten the margin entirely.
   *
   * A single-period quote gets none of it, which is the point - there is no
   * commitment to pay for.
   */
  deescalationBps: number;
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
  /** What this period would price at without the multi-year discount. */
  listCents: number;
  /** What the commitment took off this period. Zero on the base year. */
  discountCents: number;
};

export type CoverageEstimate = {
  sites: SiteCost[];
  directCents: number;
  reserveCents: number;
  overheadCents: number;
  /** What the uncapped promise adds on top of the expectation. */
  uncappedLoadCents: number;
  /** One period's cost, before margin. */
  costCents: number;
  /** One period's price. */
  priceCents: number;
  periods: Period[];
  /** Every period added up - the "total five-year price" an RFQ asks for. */
  totalCents: number;
  /** The same term without the multi-year discount, for stating what it saves. */
  listTotalCents: number;
  /** What committing to the whole term gives back, across every period. */
  deescalationCents: number;
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
  /*
   * Reported to a tenth. Four visits at 5.8 hours is 23.200000000000003 in
   * binary floating point, and a site strip reading "57.599999999999994h on
   * systems" is the kind of thing that makes somebody distrust every other
   * number on the page. The MONEY is computed from the exact values above -
   * this rounds what is shown, not what is charged.
   */
  const tenth = (n: number) => Math.round(n * 10) / 10;
  return {
    name: site.name,
    trips,
    onsiteHours: tenth(onsiteHours),
    travelHours: tenth(travelHours),
    laborCents,
    partsCents,
    travelCents,
    totalCents: laborCents + partsCents + travelCents,
    systems,
  };
}

/**
 * What the response promise costs in a year.
 *
 * `expectedCents` is the year we expect either way - the callouts and the
 * emergency stock - and is what the time-and-materials comparison uses, because
 * a client without a contract pays for the emergencies they actually have, not
 * for the ones they might. `loadCents` is what the UNCAPPED promise costs on
 * top: the tail we have agreed to absorb, on whichever legs are uncapped. It is
 * in the contract price and deliberately not in the T&M figure, so the saving a
 * client is shown is honest about what the extra buys them.
 */
export function reserveCost(r: ResponseReserve, laborCostPerHourCents: number): {
  calloutsCents: number; partsCents: number; expectedCents: number; loadCents: number; totalCents: number;
} {
  const rate = Math.max(0, cents(laborCostPerHourCents));
  const calloutsCents = cents(count(r.tripsPerYear) * (Math.max(0, r.tripCostCents) + hours(r.hoursPerTrip) * rate));
  const partsCents = cents(Math.max(0, r.partsCents));
  const uncapped = (r.unlimitedTrips ? calloutsCents : 0) + (r.unlimitedParts ? partsCents : 0);
  const loadCents = cents((uncapped * Math.max(0, r.uncappedLoadBps)) / 10000);
  const expectedCents = calloutsCents + partsCents;
  return { calloutsCents, partsCents, expectedCents, loadCents, totalCents: expectedCents + loadCents };
}

/** What the promise is called on a quote a client reads. Empty when nothing is uncapped. */
export function reserveTerms(r: ResponseReserve): string {
  return [
    r.unlimitedTrips ? "unlimited callouts" : "",
    r.unlimitedParts ? "unlimited emergency parts" : "",
  ].filter(Boolean).join(" · ");
}

/** What the label on a period is. The words an RFQ uses. */
export const periodLabel = (i: number): string => (i === 0 ? "Base year" : `Option year ${i}`);

/** Everything wrong with an estimate, said plainly. Empty means it is usable. */
export function estimateProblems(input: CoverageInput): string[] {
  const out: string[] = [];
  if (input.sites.every((s) => s.systems.length === 0)) out.push("No systems on the contract yet");
  if (count(input.laborCostPerHourCents) === 0) out.push("An hour of labor costs nothing - the price will be wrong");
  if (input.marginBps >= 10000) out.push("A margin of 100% or more cannot be priced");
  if (count(input.periods) === 0) out.push("Price at least one 12-month period");

  /*
   * An uncapped promise priced off nothing at all. "Unlimited" is a term of the
   * contract, not a way of leaving the reserve blank - with no expected callout
   * and no loading there is literally nothing in the price for a promise we
   * have made, and the first emergency of the base year is paid for out of the
   * margin on the rest.
   */
  const r = input.reserve;
  const uncapped = r.unlimitedTrips || r.unlimitedParts;
  if (r.unlimitedTrips && count(r.tripsPerYear) === 0) {
    out.push("Unlimited callouts, but the price expects none - say how many a normal year brings");
  }
  if (r.unlimitedParts && Math.max(0, r.partsCents) === 0) {
    out.push("Unlimited emergency parts, but the price expects none - say what a normal year consumes");
  }
  if (uncapped && Math.max(0, r.uncappedLoadBps) === 0) {
    out.push("An uncapped promise with no loading on it - a bad year comes out of the margin");
  }

  const margin = Math.min(9900, Math.max(0, input.marginBps));
  const deesc = Math.min(9900, Math.max(0, input.deescalationBps));
  const last = count(input.periods) - 1;
  if (last > 0 && deesc > 0 && (1 - deesc / 10000) ** last < 1 - margin / 10000) {
    /*
     * The give-back has outrun the margin. Independent of every other figure:
     * a period prices at cost / (1 - margin), discounted by (1 - deesc)^i, so
     * it lands under its own cost exactly when (1 - deesc)^i < 1 - margin. The
     * last period is the first to go, and a five-year schedule whose option
     * years lose money is the kind of thing nobody notices until year four.
     */
    out.push(`${periodLabel(last)} de-escalates below what it costs - the discount has eaten the margin`);
  }
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
  const res = reserveCost(r, rate);
  const reserveCents = res.totalCents;

  const overheadCents = cents(((directCents + reserveCents) * Math.max(0, input.overheadBps)) / 10000);
  const costCents = directCents + reserveCents + overheadCents;

  const margin = Math.min(9900, Math.max(0, input.marginBps));
  const priceCents = toDollar((costCents * 10000) / (10000 - margin));

  const n = count(input.periods);
  const esc = Math.max(0, input.escalationBps);
  const deesc = Math.min(9900, Math.max(0, input.deescalationBps));
  const periods: Period[] = [];
  for (let i = 0; i < n; i++) {
    /*
     * Escalation moves cost AND price - the same year of work really does cost
     * more later. The multi-year give-back moves the price only, so what it
     * costs us is unchanged and the narrowing margin in the option years is
     * visible rather than hidden inside one blended factor.
     */
    const escalated = (1 + esc / 10000) ** i;
    const listCents = toDollar(priceCents * escalated);
    const discounted = toDollar(priceCents * escalated * (1 - deesc / 10000) ** i);
    periods.push({
      index: i,
      label: periodLabel(i),
      costCents: cents(costCents * escalated),
      priceCents: discounted,
      listCents,
      discountCents: listCents - discounted,
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
  /*
   * The EXPECTED emergencies, at the rate card - never the uncapped loading.
   * A client without a contract pays for the callouts they actually have; they
   * do not pay a premium for a promise nobody made them. Putting the loading on
   * this side would flatter the contract by pretending T&M carries the same
   * risk, when absorbing that risk is precisely what the client is buying.
   */
  const reserveOnTm = count(r.tripsPerYear) * (hours(r.hoursPerTrip) * bill + Math.max(0, r.tripCostCents))
    + markup(Math.max(0, r.partsCents));
  const tmCents = cents(planned + reserveOnTm);
  const base = periods[0]?.priceCents ?? priceCents;
  const savingBps = tmCents > 0 ? Math.round(((tmCents - base) / tmCents) * 10000) : 0;

  const totalCents = periods.reduce((a, p) => a + p.priceCents, 0);
  const listTotalCents = periods.reduce((a, p) => a + p.listCents, 0);
  const deescalationCents = listTotalCents - totalCents;
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
        : ".")
    + (deescalationCents > 0
      // What the commitment bought, in money rather than in a percentage. It is
      // the sentence the client is being asked to sign a five-year term for.
      ? ` Committing to all ${n} years gives back ${formatCents(deescalationCents)}.`
      : "")
    + (reserveTerms(r) ? ` Carries ${reserveTerms(r)}.` : "");

  return {
    sites, directCents, reserveCents, uncappedLoadCents: res.loadCents,
    overheadCents, costCents, priceCents,
    periods, totalCents, listTotalCents, deescalationCents, tmCents, savingBps, line, problems,
  };
}

/**
 * The twelve-month window each period covers.
 *
 * A CLIN is a date range on a piece of paper - "Sep. 29, 2026 through Sep. 28,
 * 2027" - and the day before the anniversary is the one everybody gets wrong by
 * one. Anniversary arithmetic clamps like the retainer cycle does (lib/recurring
 * cycleDay): a period starting Feb 29 ends Feb 28, because a year that has no
 * Feb 29 in it still has to end somewhere.
 *
 * Blank start means blank windows rather than today's date - a CLIN schedule
 * invented from the day somebody happened to open the page is worse than none.
 */
export function periodWindows(startsOn: string, periods: number): { from: string; to: string }[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startsOn.trim());
  const n = count(periods);
  if (!m || n === 0) return Array.from({ length: n }, () => ({ from: "", to: "" }));
  const [y0, mo0, d0] = [Number(m[1]), Number(m[2]), Number(m[3])];

  const on = (yearsOn: number): Date => {
    const y = y0 + yearsOn;
    // Clamp into the month, so Feb 29 + 1 year is Feb 28 rather than Mar 1.
    const last = new Date(Date.UTC(y, mo0, 0)).getUTCDate();
    return new Date(Date.UTC(y, mo0 - 1, Math.min(d0, last)));
  };
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  return Array.from({ length: n }, (_, i) => {
    const from = on(i);
    const next = on(i + 1);
    const to = new Date(next.getTime() - 86_400_000);
    return { from: iso(from), to: iso(to) };
  });
}
