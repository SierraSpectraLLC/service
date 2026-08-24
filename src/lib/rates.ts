// What an hour costs on this job.
//
// Three rungs, and the whole point is that only one function decides which one
// applies: a card written against the AGREEMENT beats one written for the ORG,
// which beats the workspace default. That is the same defaults-then-override
// layering the digest schedule uses, and putting the decision anywhere else is
// how two screens start quoting different rates for the same hour.
//
// Multipliers are integer PERCENTAGES of the base rate - 150 is
// time-and-a-half, 50 is travel at half rate - and every intermediate is
// rounded to whole cents before the next multiply. A float multiplier is how a
// $160 hour becomes $239.99999997 and how an invoice total stops matching the
// sum of its lines.
//
// Pure. Callers hand in the rows.

/** The billing categories an hour can be logged under. */
export const TIME_CATEGORIES = ["onsite", "remote", "travel"] as const;
export type TimeCategory = (typeof TIME_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<string, string> = {
  onsite: "On site",
  remote: "Remote",
  travel: "Travel",
};

export type RateCard = {
  id: number;
  /** Null = the workspace default. */
  orgId: number | null;
  /** Null = not tied to one agreement. */
  agreementId: number | null;
  hourlyCents: number;
  afterHoursPct: number;
  travelPct: number;
  minIncrementMin: number;
  label: string;
};

/**
 * What a workspace bills before anybody has written a card. Deliberately not
 * zero: a rate of zero silently produces free labor on every invoice, which is
 * a worse failure than a wrong-but-visible number.
 */
export const FALLBACK_RATE: RateCard = {
  id: 0, orgId: null, agreementId: null,
  hourlyCents: 15000, afterHoursPct: 150, travelPct: 50, minIncrementMin: 15,
  label: "Workspace default",
};

/**
 * The card that applies, most specific first. `cards` is every card the
 * workspace has; this picks, never queries.
 *
 * A card tied to the agreement this work is covered by wins outright - that is
 * the paper the client signed. Failing that, the client's own card. Failing
 * that, the workspace default (both ids null), and failing even that,
 * FALLBACK_RATE, so an invoice never quietly prices labor at nothing.
 */
export function resolveRate(
  cards: RateCard[],
  target: { orgId: number | null; agreementId: number | null },
): RateCard {
  if (target.agreementId !== null) {
    const byPaper = cards.find((c) => c.agreementId === target.agreementId);
    if (byPaper) return byPaper;
  }
  if (target.orgId !== null) {
    const byOrg = cards.find((c) => c.orgId === target.orgId && c.agreementId === null);
    if (byOrg) return byOrg;
  }
  return cards.find((c) => c.orgId === null && c.agreementId === null) ?? FALLBACK_RATE;
}

/**
 * Minutes as they will be billed: rounded UP to the card's increment.
 *
 * Up, not nearest: the increment exists because a seven-minute phone call
 * still costs the shop a context switch, and a shop that rounds a seven-minute
 * call to zero has written a rule that bills nothing for half its interruptions.
 * An increment of 0 or 1 leaves the minutes alone.
 */
export function billableMinutes(minutes: number, minIncrementMin: number): number {
  const m = Math.max(0, Math.round(minutes));
  const inc = Math.max(1, Math.round(minIncrementMin || 1));
  if (m === 0) return 0;
  return Math.ceil(m / inc) * inc;
}

/** The hourly rate this category is charged at, in whole cents. */
export function hourlyFor(rate: RateCard, category: string, afterHours = false): number {
  const pct = category === "travel" ? rate.travelPct : afterHours ? rate.afterHoursPct : 100;
  return Math.round((rate.hourlyCents * pct) / 100);
}

/**
 * What a block of time costs: rounded minutes at the category's hourly rate.
 *
 * Returns the pieces rather than one number, because an invoice line has to
 * show the client the quantity and the unit price it was multiplied by - and a
 * line whose printed qty times printed unit does not equal its printed amount
 * is the fastest way to lose an argument about a bill.
 */
export function priceTime(
  minutes: number, category: string, rate: RateCard, afterHours = false,
): { minutes: number; hours: number; hourlyCents: number; amountCents: number } {
  const billed = billableMinutes(minutes, rate.minIncrementMin);
  const hourly = hourlyFor(rate, category, afterHours);
  return {
    minutes: billed,
    // Two decimals is what the line prints: 5.25 h, never 5.249999.
    hours: Math.round((billed / 60) * 100) / 100,
    hourlyCents: hourly,
    amountCents: Math.round((hourly * billed) / 60),
  };
}
