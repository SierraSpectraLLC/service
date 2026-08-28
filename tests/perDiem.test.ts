// The travel rulebook, applied to a claim instead of a quick-log button.
//
// The owner's sentence, which is the whole spec: "if my engineer travels more
// than 81 miles but less than an overnight trip and then adds a per diem to
// the report, it should auto-fill the lunch per diem from our org settings and
// auto-fill the description. For per diems added under 80, flag it but still
// follow the org allowances and force the reviewer to approve it manually."
//
// Two halves, and the second is the one worth a test file. The first is
// arithmetic. The second is a policy decision with a sharp edge: a claim
// inside the radius is NOT refused and NOT silently paid - it is offered at the
// shop's own rate and parked until a human signs for it. Refusing would teach
// people to file the lunch as "Supplies"; paying it silently is the leak.
import { describe, expect, it } from "vitest";
import {
  allowanceFor, isPerDiemKind, needsApproval, perDiemOffer, resolveExpensePolicy,
  DEFAULT_EXPENSE_POLICY,
} from "@/lib/expensePolicy";

/** The owner's numbers: 80 mi radius, $30 lunch, $65 a night, $85 past 3. */
const POLICY = resolveExpensePolicy({
  radiusMiles: 80,
  dayPerDiemCents: 3000,
  overnightPerDiemCents: 6500,
  extendedAfterNights: 3,
  overnightExtendedCents: 8500,
  hotelNightCapCents: 18000,
});

const trip = (over: Partial<{ oneWayMiles: number | null; nights: number; siteName: string }> = {}) =>
  ({ oneWayMiles: 96 as number | null, nights: 0, siteName: "Pier Road", ...over });

describe("which categories the rulebook speaks about", () => {
  it("recognises a per diem however the workspace spells it", () => {
    // Categories are a workspace's own vocabulary - the starter list says
    // "Per diem", the old hardcoded kind was per_diem, and a shop that calls
    // it Meals is not wrong.
    for (const k of ["Per diem", "per diem", "per_diem", "Per-Diem", "Meals", "meal", " per diem "]) {
      expect(`${k}: ${isPerDiemKind(k)}`).toBe(`${k}: true`);
    }
  });

  it("leaves every other receipt alone", () => {
    // Nothing else is judged, so nothing else can be flagged - a parking
    // receipt behaves exactly as it did before any of this existed.
    for (const k of ["Lodging", "Mileage", "Parking", "Supplies & consumables", "Other", ""]) {
      expect(`${k}: ${isPerDiemKind(k)}`).toBe(`${k}: false`);
    }
  });
});

describe("beyond the radius, on a day trip", () => {
  it("offers the org's lunch rate and writes the sentence", () => {
    // The headline case. 96 miles out, home the same night: $30, and a
    // description nobody had to type.
    const o = perDiemOffer(POLICY, trip({ oneWayMiles: 96 }));
    expect(o.allowedCents).toBe(3000);
    expect(o.description).toBe("Lunch per diem - 96 mi from home, beyond the 80 mi radius - Pier Road");
    expect(o.flag).toBe("");
  });

  it("asks nobody to approve it", () => {
    expect(allowanceFor(perDiemOffer(POLICY, trip({ oneWayMiles: 96 })), 3000).state).toBe("");
  });

  it("puts the boundary on the stipend's side", () => {
    // 80 is not beyond 80 - the same edge tripAllowance already holds.
    expect(perDiemOffer(POLICY, trip({ oneWayMiles: 80 })).flag).not.toBe("");
    expect(perDiemOffer(POLICY, trip({ oneWayMiles: 81 })).flag).toBe("");
  });
});

describe("inside the radius, on a day trip", () => {
  const o = perDiemOffer(POLICY, trip({ oneWayMiles: 22 }));

  it("still offers the shop's own rate", () => {
    /*
     * "Still follow the org allowances." The exception costs what the rule
     * costs - an all-day install twenty minutes away where nobody could leave
     * the lab is a real thing, and offering $0 here would just teach people to
     * file the lunch under Supplies.
     */
    expect(o.allowedCents).toBe(3000);
  });

  it("flags it, in words a reviewer can act on", () => {
    expect(o.flag).toContain("22 mi from home");
    expect(o.flag).toContain("inside the 80 mi radius");
    expect(o.flag).toContain("car stipend");
  });

  it("parks it until somebody signs for it", () => {
    const a = allowanceFor(o, 3000);
    expect(a.state).toBe("flagged");
    expect(needsApproval({ allowanceState: a.state })).toBe(true);
  });
});

describe("nights judge themselves", () => {
  /*
   * The odometer does not gate a hotel: nobody books a room inside commuting
   * range of their own bed by choice, and when the job requires it the company
   * that required it pays. So an overnight close to home is priced, not
   * queried - which is the one case where "inside the radius" must NOT flag.
   */
  it("prices a stay by its nights and does not flag a close one", () => {
    const o = perDiemOffer(POLICY, trip({ oneWayMiles: 22, nights: 1 }));
    expect(o.allowedCents).toBe(6500);
    expect(o.flag).toBe("");
    expect(o.description).toBe("Per diem, 1 night - Pier Road");
  });

  it("steps the rate up on the marginal night, not the whole stay", () => {
    // 4 nights, extended after 3: three at $65 and one at $85, not four at $85.
    const o = perDiemOffer(POLICY, trip({ nights: 4 }));
    expect(o.allowedCents).toBe(3 * 6500 + 8500);
  });
});

describe("when the distance is unknowable", () => {
  /*
   * No home base on file, or a job whose site never geocoded. The honest
   * answer is "a person has to look", and it is the reason miles are `number |
   * null` rather than a number with 0 standing in - a zero here would read as
   * "next door" and flag every honest claim as if it were a short hop.
   */
  const o = perDiemOffer(POLICY, trip({ oneWayMiles: null }));

  it("says so instead of guessing, and sends it to a reviewer", () => {
    expect(o.flag).toContain("distance from home could not be worked out");
    expect(allowanceFor(o, 3000).state).toBe("flagged");
  });

  it("still offers the day rate, so the claim is not left blank", () => {
    expect(o.allowedCents).toBe(3000);
  });
});

describe("the amount somebody actually claimed", () => {
  const clean = perDiemOffer(POLICY, trip({ oneWayMiles: 96 }));

  it("flags a claim over the allowance, and says both numbers", () => {
    // The form cannot prevent this and should not try: a $52 airport lunch on
    // a $30 day happens, and the answer is a reviewer, not a locked field.
    const a = allowanceFor(clean, 5200);
    expect(a.state).toBe("flagged");
    expect(a.note).toContain("$52");
    expect(a.note).toContain("$30");
  });

  it("never flags a claim under it - being owed less is not a policy problem", () => {
    expect(allowanceFor(clean, 1800).state).toBe("");
    expect(allowanceFor(clean, 3000).state).toBe("");
  });

  it("records what the rulebook said even when it said yes", () => {
    // Written either way, so a reviewer reading a paid report next March sees
    // what the rule was at the time rather than an empty column.
    expect(allowanceFor(clean, 3000).note).toContain("$30 allowed");
  });
});

describe("a shop that has not written a rulebook", () => {
  /*
   * The most important test here. Every instance that never configured this
   * must behave exactly as it did before: no autofill, no flags, no gate on
   * the payout. A feature that starts flagging claims at a shop that never
   * asked for it is a feature that gets switched off.
   */
  const OFF = DEFAULT_EXPENSE_POLICY;

  it("offers nothing and rules on nothing", () => {
    const o = perDiemOffer(OFF, trip({ oneWayMiles: 4 }));
    expect(o.ruled).toBe(false);
    expect(o.allowedCents).toBe(0);
    expect(o.description).toBe("");
    expect(o.flag).toBe("");
  });

  it("cannot flag a row, at any amount", () => {
    for (const cents of [0, 3000, 999_99]) {
      const a = allowanceFor(perDiemOffer(OFF, trip({ oneWayMiles: 4 })), cents);
      expect(`${cents}: ${a.state}`).toBe(`${cents}: `);
    }
  });
});

describe("a trip with no site to name", () => {
  it("leaves the sentence readable rather than trailing a dash", () => {
    const o = perDiemOffer(POLICY, trip({ siteName: "" }));
    expect(o.description).toBe("Lunch per diem - 96 mi from home, beyond the 80 mi radius");
    expect(o.description.endsWith("-")).toBe(false);
  });
});
