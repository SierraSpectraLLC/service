// The thresholds the money section decides by, in one place. Pure.
export { CHASE_DAYS, STALE_QUOTE_DAYS, RENEWAL_DAYS, daysBetween, daysFrom, plusDays } from "@/lib/finance";

/** A job closed this many days ago and not billed is a decision, not noise. */
export const UNBILLED_AFTER_DAYS_HOME = 1;

/** Runway is burn over this many trailing whole months. */
export const BURN_MONTHS = 2;

/** A past-due invoice is assumed to land this many days out, in the forecast. */
export const PAST_DUE_ASSUMED_DAYS = 14;

/** A received purchase order is assumed payable this many days after receipt. */
export const PO_TERMS_DAYS = 30;

/** The forecast's horizon, in weeks. */
export const FORECAST_WEEKS = 8;
