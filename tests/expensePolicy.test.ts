import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPENSE_POLICY, policyConfigured, resolveExpensePolicy, tripAllowance,
} from "@/lib/expensePolicy";

/**
 * The owner's rule, verbatim: an engineer's home is point zero, he gets an
 * 80 mi radius before the company is on the hook for gas and lunches - the
 * monthly car stipend already paid for trips inside it. Beyond it, meals are
 * covered; a trip with nights earns a per-night rate that steps up when the
 * stay drags on, and lodging is covered to a ceiling.
 */
const policy = resolveExpensePolicy({
  radiusMiles: 80,
  dayPerDiemCents: 3000,
  overnightPerDiemCents: 6500,
  extendedAfterNights: 3,
  overnightExtendedCents: 8500,
  hotelNightCapCents: 18000,
});

describe("the radius", () => {
  it("inside it, a day trip earns nothing - the stipend already paid", () => {
    const t = tripAllowance(policy, { oneWayMiles: 45, nights: 0 });
    expect(t.withinRadius).toBe(true);
    expect(t.perDiemCents).toBe(0);
  });

  it("the boundary belongs to the stipend - 80 is not beyond 80", () => {
    expect(tripAllowance(policy, { oneWayMiles: 80, nights: 0 }).withinRadius).toBe(true);
    expect(tripAllowance(policy, { oneWayMiles: 81, nights: 0 }).withinRadius).toBe(false);
  });

  it("beyond it, a day trip earns the day rate once - not per mile", () => {
    const t = tripAllowance(policy, { oneWayMiles: 140, nights: 0 });
    expect(t.perDiemCents).toBe(3000);
    expect(t.hotelNightCapCents).toBe(0); // no nights, no bed
  });
});

describe("nights judge themselves - the odometer does not gate a hotel", () => {
  /**
   * Deliberate: an overnight stay is priced by its nights whatever the miles,
   * because nobody books a hotel inside commuting range of their own bed by
   * choice - and when they must (an all-nighter install), the company that
   * required it pays for it.
   */
  it("a stay inside the radius still earns its nights and its bed", () => {
    const t = tripAllowance(policy, { oneWayMiles: 45, nights: 1 });
    expect(t.perDiemCents).toBe(6500);
    expect(t.hotelNightCapCents).toBe(18000);
  });

  it("steps up only for the nights past the threshold", () => {
    // 5 nights, extended after 3: three ordinary + two extended.
    const t = tripAllowance(policy, { oneWayMiles: 140, nights: 5 });
    expect(t.perDiemCents).toBe(3 * 6500 + 2 * 8500);
    expect(t.perDiemBreakdown).toBe("3 nights + 2 extended");
  });

  it("no threshold means no step, however long the stay", () => {
    const p = resolveExpensePolicy({ overnightPerDiemCents: 6500 });
    expect(tripAllowance(p, { oneWayMiles: 300, nights: 10 }).perDiemCents).toBe(10 * 6500);
  });

  it("a missing extended rate falls back to the ordinary one, never to zero", () => {
    const p = resolveExpensePolicy({ overnightPerDiemCents: 6500, extendedAfterNights: 2 });
    expect(tripAllowance(p, { oneWayMiles: 300, nights: 4 }).perDiemCents).toBe(4 * 6500);
  });
});

describe("an instance that never configured this", () => {
  it("resolves garbage to the defaults, like every policy column here", () => {
    for (const raw of [null, undefined, "no", 7, [], { radiusMiles: "eighty", dayPerDiemCents: -5 }]) {
      const p = resolveExpensePolicy(raw);
      expect(p).toEqual(DEFAULT_EXPENSE_POLICY);
    }
  });

  it("reads as unconfigured, so no banner ever shows on the work order", () => {
    expect(policyConfigured(DEFAULT_EXPENSE_POLICY)).toBe(false);
    expect(policyConfigured(policy)).toBe(true);
  });

  it("with the rule off, nothing is within any radius", () => {
    const t = tripAllowance(DEFAULT_EXPENSE_POLICY, { oneWayMiles: 5, nights: 0 });
    expect(t.withinRadius).toBe(false);
    expect(t.perDiemCents).toBe(0); // and nothing is offered either
  });
});
