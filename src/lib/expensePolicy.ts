// The shop's own travel rules, as data: when an engineer's receipts are the
// company's problem and when they ride the car stipend.
//
// The rule this encodes, in the owner's words: an engineer's home is point
// zero, and inside a radius around it the stipend already paid for the trip -
// no gas, no lunch. Beyond it the shop is on the hook, at rates that grow
// with how long the trip keeps somebody away.
//
// Radius gates the DAY-TRIP costs. An overnight stay is judged by its nights,
// not its miles: if the job keeps somebody in a hotel, they eat and sleep on
// the company whatever the odometer said, because nobody stays over within
// commuting range of their own bed by choice.
//
// Same posture as lib/billingPolicy, deliberately: stored as tolerant jsonb,
// resolved to a complete policy whatever is in the column, zero meaning "rule
// off" so an instance that never configured this behaves exactly as before.

export type ExpensePolicy = {
  /** Road miles one-way from the engineer's home. 0 = no radius rule. */
  radiusMiles: number;
  /** Meals on a beyond-radius day trip, per day. 0 = not offered. */
  dayPerDiemCents: number;
  /** Meals per night away, once a trip involves a stay. */
  overnightPerDiemCents: number;
  /** After this many nights the rate steps up - long trips wear people out. */
  extendedAfterNights: number;
  overnightExtendedCents: number;
  /** Lodging ceiling per night. 0 = lodging is not a covered expense. */
  hotelNightCapCents: number;
};

export const DEFAULT_EXPENSE_POLICY: ExpensePolicy = {
  radiusMiles: 0,
  dayPerDiemCents: 0,
  overnightPerDiemCents: 0,
  extendedAfterNights: 0,
  overnightExtendedCents: 0,
  hotelNightCapCents: 0,
};

const int = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
};

/** Whatever the column holds becomes a complete, usable policy. */
export function resolveExpensePolicy(raw: unknown): ExpensePolicy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_EXPENSE_POLICY;
  const v = raw as Record<string, unknown>;
  const d = DEFAULT_EXPENSE_POLICY;
  return {
    radiusMiles: int(v.radiusMiles, d.radiusMiles),
    dayPerDiemCents: int(v.dayPerDiemCents, d.dayPerDiemCents),
    overnightPerDiemCents: int(v.overnightPerDiemCents, d.overnightPerDiemCents),
    extendedAfterNights: int(v.extendedAfterNights, d.extendedAfterNights),
    overnightExtendedCents: int(v.overnightExtendedCents, d.overnightExtendedCents),
    hotelNightCapCents: int(v.hotelNightCapCents, d.hotelNightCapCents),
  };
}

/** Is any part of the rulebook actually switched on? */
export const policyConfigured = (p: ExpensePolicy): boolean =>
  p.radiusMiles > 0 || p.dayPerDiemCents > 0 || p.overnightPerDiemCents > 0 || p.hotelNightCapCents > 0;

export type TripAllowance = {
  /** Inside the radius: gas and meals ride the stipend on a day trip. */
  withinRadius: boolean;
  /** What meals the trip has earned, in total. */
  perDiemCents: number;
  /** One line per day at its rate, for the description on the logged row. */
  perDiemBreakdown: string;
  /** Per-night lodging ceiling, 0 when lodging is not covered. */
  hotelNightCapCents: number;
  nights: number;
};

/**
 * What one trip entitles somebody to, given how far and how long.
 *
 * The tier walk: a day trip beyond the radius earns the day rate once. A trip
 * with nights earns the overnight rate per night, and nights past the
 * extended threshold earn the higher rate - so "3 nights, extended after 2"
 * is 2 ordinary + 1 extended, not 3 at the top rate. The step rewards the
 * marginal night, the same way overtime prices the marginal hour.
 */
export function tripAllowance(p: ExpensePolicy, trip: { oneWayMiles: number; nights: number }): TripAllowance {
  const nights = Math.max(0, Math.round(trip.nights));
  const withinRadius = p.radiusMiles > 0 && trip.oneWayMiles <= p.radiusMiles;

  if (nights === 0) {
    const covered = !withinRadius && p.dayPerDiemCents > 0;
    return {
      withinRadius,
      perDiemCents: covered ? p.dayPerDiemCents : 0,
      perDiemBreakdown: covered ? "day trip" : "",
      hotelNightCapCents: 0,
      nights,
    };
  }

  const stepAt = p.extendedAfterNights > 0 ? p.extendedAfterNights : Infinity;
  const ordinary = Math.min(nights, stepAt);
  const extended = Math.max(0, nights - ordinary);
  const perDiemCents = ordinary * p.overnightPerDiemCents
    + extended * (p.overnightExtendedCents || p.overnightPerDiemCents);
  const parts = [
    ordinary > 0 && p.overnightPerDiemCents > 0 ? `${ordinary} night${ordinary === 1 ? "" : "s"}` : "",
    extended > 0 ? `${extended} extended` : "",
  ].filter(Boolean).join(" + ");
  return {
    withinRadius,
    perDiemCents,
    perDiemBreakdown: parts,
    hotelNightCapCents: p.hotelNightCapCents,
    nights,
  };
}

// ── Per diem, as a claim rather than a quick-log button ────────────────────
//
// tripAllowance above answers "what does this trip entitle somebody to". That
// was enough while per diems were logged from the work order, where the
// engineer is already looking at the job and typing the miles.
//
// On a reimbursement report the question arrives from the other end: a row is
// being added to a claim that already names a job, so the miles are not
// something to ask for - they are the road distance from the CLAIMANT's home
// to that job's lab, which the app already knows. What follows turns that into
// an amount, a sentence, and - the part that matters to whoever pays it - a
// verdict on whether a human needs to look.

/**
 * Is this category a per diem?
 *
 * Tolerant, because expense categories are a workspace's own vocabulary: the
 * starter list says "Per diem", the old hardcoded kind was `per_diem`, and a
 * shop that calls it "Meals" is not wrong. A workspace that renamed it to
 * something unrecognizable simply gets no autofill and the row behaves exactly
 * as it did before any of this existed - which is the right way to be wrong.
 */
export const isPerDiemKind = (kind: string): boolean =>
  /per[\s_-]*diem|^meals?$|^meal allowance$/i.test(kind.trim());

/** How far and how long, as the rulebook needs it. */
export type Trip = {
  /**
   * Road miles one way from the claimant's home. Null means the app could not
   * work it out - no home base on file, or a job with no located site - which
   * is a different answer from zero and is never treated as "close by".
   */
  oneWayMiles: number | null;
  nights: number;
  /** The lab, for the sentence. "" when there isn't one to name. */
  siteName: string;
};

export type PerDiemOffer = {
  /**
   * Whether the rulebook has an opinion at all. False when nothing is
   * configured - and then nothing below is used, no row is flagged, and the
   * form behaves as it did before.
   */
  ruled: boolean;
  /** What the rulebook allows for this trip. */
  allowedCents: number;
  /** The description to prefill, in the words the claim will carry. */
  description: string;
  /**
   * Why a reviewer has to sign this off, in the words they will read. ""
   * when the claim sits inside the rules and nobody needs to look.
   */
  flag: string;
};

const dollars = (cents: number): string =>
  `$${(cents / 100).toFixed(2).replace(/\.00$/, "")}`;

/**
 * What the shop allows for a per diem on this trip, and whether it is the kind
 * of claim somebody has to approve by hand.
 *
 * The three answers, in the order they are asked:
 *
 *   - NIGHTS FIRST. A trip with a stay is priced by its nights whatever the
 *     odometer said - the same rule tripAllowance already states, for the same
 *     reason: nobody books a hotel inside commuting range of their own bed by
 *     choice, and when the job requires it the company that required it pays.
 *     So an overnight is never flagged for being close.
 *
 *   - BEYOND THE RADIUS, no nights: the day rate, cleanly. This is the case
 *     the whole feature is for - a 96-mile round of a job, one lunch, and the
 *     engineer should not have to remember what the shop pays for that or type
 *     a sentence explaining it.
 *
 *   - INSIDE THE RADIUS, no nights: the stipend already bought the meal, so
 *     this is a claim against the rules. It is NOT refused - an all-day
 *     install twenty minutes away where nobody could leave the lab is a real
 *     thing, and a rulebook that cannot be departed from just teaches people
 *     to file the lunch as "Supplies". It is offered AT THE SHOP'S OWN RATE,
 *     so the exception costs what the rule costs, and flagged so a reviewer
 *     signs it rather than it slipping through inside a fourteen-row claim.
 *
 * And the honest fourth: when the distance is unknown, the rulebook says so
 * instead of guessing, and a human decides.
 */
export function perDiemOffer(p: ExpensePolicy, trip: Trip): PerDiemOffer {
  if (!policyConfigured(p)) return { ruled: false, allowedCents: 0, description: "", flag: "" };
  const at = trip.siteName ? ` - ${trip.siteName}` : "";
  const nights = Math.max(0, Math.round(trip.nights));

  if (nights > 0) {
    const a = tripAllowance(p, { oneWayMiles: trip.oneWayMiles ?? 0, nights });
    return {
      ruled: true,
      allowedCents: a.perDiemCents,
      description: `Per diem, ${a.perDiemBreakdown || `${nights} night${nights === 1 ? "" : "s"}`}${at}`,
      flag: "",
    };
  }

  if (trip.oneWayMiles === null) {
    return {
      ruled: true,
      allowedCents: p.dayPerDiemCents,
      description: `Per diem, day trip${at}`,
      flag: "The distance from home could not be worked out - no home base on file for them,"
        + " or the job's site has no address. Check the trip before approving this one.",
    };
  }

  const miles = Math.round(trip.oneWayMiles);
  const a = tripAllowance(p, { oneWayMiles: miles, nights: 0 });
  if (!a.withinRadius) {
    return {
      ruled: true,
      allowedCents: a.perDiemCents,
      description: a.perDiemCents > 0
        ? `Lunch per diem - ${miles} mi from home, beyond the ${p.radiusMiles} mi radius${at}`
        : `Day trip, ${miles} mi from home${at}`,
      flag: "",
    };
  }

  return {
    ruled: true,
    // The shop's own rate, still. See the note above: the exception costs
    // what the rule costs.
    allowedCents: p.dayPerDiemCents,
    description: `Lunch per diem - ${miles} mi from home, inside the ${p.radiusMiles} mi radius${at}`,
    flag: `Claimed ${miles} mi from home, inside the ${p.radiusMiles} mi radius`
      + " - the car stipend already covers meals on a trip this short."
      + " Approve it only if the day genuinely earned it.",
  };
}

export type Allowance = {
  /** "" = nothing to review. "flagged" = a reviewer must clear it before payout. */
  state: "" | "flagged";
  /** What the rulebook said, written either way so the record keeps the reason. */
  note: string;
};

/**
 * The verdict on an amount somebody actually claimed.
 *
 * Two ways to earn a flag: the trip itself is outside the rules (the offer
 * says so), or the number is bigger than what the rules allow for it. The
 * second is the one a form cannot prevent - the amount box stays typable,
 * because a $52 airport lunch on a day the shop allows $30 for is a thing that
 * happens and the answer is a reviewer, not a locked field.
 *
 * Under the allowance is never flagged. Claiming less than you are owed is not
 * a policy problem.
 */
export function allowanceFor(offer: PerDiemOffer, claimedCents: number): Allowance {
  if (!offer.ruled) return { state: "", note: "" };
  if (offer.flag) return { state: "flagged", note: offer.flag };
  if (claimedCents > offer.allowedCents) {
    return {
      state: "flagged",
      note: `Claimed ${dollars(claimedCents)}; the rulebook allows ${dollars(offer.allowedCents)}`
        + " for this trip. Approve the difference or send it back.",
    };
  }
  return {
    state: "",
    note: `Within the rules - ${dollars(offer.allowedCents)} allowed for this trip.`,
  };
}

/** A row a reviewer still has to clear. The payout gate, in one place. */
export const needsApproval = (row: { allowanceState: string }): boolean =>
  row.allowanceState === "flagged";
