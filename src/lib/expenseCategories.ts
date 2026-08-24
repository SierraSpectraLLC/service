// The starter vocabulary a new workspace begins with.
//
// Nineteen names, not five, because the old hardcoded list lasted exactly
// until real bookkeeping met it - and not ninety, because a picker longer
// than a screen teaches people to choose the first thing that scrolls past.
// The order is the picker's order: the daily stuff first, the monthly stuff
// after, Other last where a catch-all belongs.
//
// Every name here is a suggestion, not a law. A workspace renames and deletes
// freely; this list is only what the shelf looks like on day one, and the one
// place it is written down.

export const STARTER_CATEGORIES = [
  "Mileage",
  "Fuel",
  "Tolls",
  "Parking",
  "Per diem",
  "Lodging",
  "Airfare",
  "Rental car",
  "Rideshare & taxi",
  "Shipping & freight",
  "Postage",
  "Supplies & consumables",
  "Small tools",
  "Equipment rental",
  "Permits & fees",
  "Training & certification",
  "Software & subscriptions",
  "Phone & internet",
  "Other",
] as const;

export const MAX_CATEGORY_NAME = 40;

/** One normalization for every duplicate check, so "fuel" and "Fuel " collide. */
export const categoryKey = (name: string): string => name.trim().toLowerCase();

/** A name fit to store, or null when there is nothing there. */
export function cleanCategoryName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ").slice(0, MAX_CATEGORY_NAME);
  return name ? name : null;
}

/**
 * Which starter names a workspace is still missing - what the seed inserts
 * and what the "load the starter set" button adds. Comparing by key means a
 * workspace that renamed "Fuel" to "fuel & oil" keeps its own row and gains
 * nothing it already has.
 */
export function missingStarters(existing: { name: string }[]): string[] {
  const have = new Set(existing.map((c) => categoryKey(c.name)));
  return STARTER_CATEGORIES.filter((n) => !have.has(categoryKey(n)));
}
