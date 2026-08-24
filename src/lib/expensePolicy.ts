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
