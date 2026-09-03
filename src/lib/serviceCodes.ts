// The labor and travel numbers a service shop quotes off.
//
// "We should also have part numbers for labor and travel" - because that is
// how the work is actually sold. A trip to zone 3 with an overnight is a line
// item with a name and a price, and so is an hour of LC/MS work for a
// preferred client. Typed as free text on every quote, those four things got
// four spellings and four prices; catalogued, they are numbers like any other.
//
// This module is only the STARTING SET - the four the shop named. They are
// ordinary catalog rows once installed: renameable, re-priceable, archivable,
// and joined by however many zones and programs the shop goes on to add. What
// this buys is that nobody has to invent the first four from a blank page.
//
// Pure. The action that writes them hands in what the book already has.

import { normalizePn } from "@/lib/priceBook";
import { allNumbers, type CatalogEntry } from "@/lib/partCatalog";

export type ServiceCodeSeed = {
  partNumber: string;
  name: string;
  /** 'labor' or 'travel' - see SERVICE_KINDS in lib/partCatalog. */
  kind: string;
  /** What one of it is. An hour of labor; a trip to a zone. */
  unit: string;
};

/**
 * The four the shop asked for, spelled and named as they said them.
 *
 * No rates. A price nobody has stated is quoted at zero and asked about before
 * the quote goes out - the same rule lib/billing.sellPrice follows for a part
 * that cost us nothing on paper. Seeding these with a guessed hourly rate
 * would put a number on a client's quote that nobody in the shop had chosen.
 */
export const HOUSE_SERVICE_CODES: ServiceCodeSeed[] = [
  { partNumber: "TZ1OP", name: "Travel Zone-1 Overnight, Preferred Client", kind: "travel", unit: "trip" },
  { partNumber: "TZ3O", name: "Travel Zone-3 Overnight", kind: "travel", unit: "trip" },
  { partNumber: "LABOR-LCP", name: "Labor, LC/MS Preferred", kind: "labor", unit: "h" },
  { partNumber: "LABOR-TCU", name: "Labor, TOC University", kind: "labor", unit: "h" },
];

/**
 * Which of the starting set this book has not got, matched the way every other
 * part number is matched - against ALL of an entry's numbers, so a shop that
 * has already catalogued TZ3O under some other primary is not offered it
 * twice, and archived rows count as present rather than being re-created.
 */
export function missingServiceCodes(
  catalog: Pick<CatalogEntry, "partNumber" | "mfrPartNumber" | "aliases">[],
  seeds: ServiceCodeSeed[] = HOUSE_SERVICE_CODES,
): ServiceCodeSeed[] {
  const known = new Set(catalog.flatMap(allNumbers));
  return seeds.filter((s) => !known.has(normalizePn(s.partNumber)));
}
