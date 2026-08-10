// Pure price-book math: which vendors sell a part number and which offer
// wins. No DB access - callers hand in rows, tests hand in literals.

export type PriceEntry = {
  partNumber: string;
  vendor: string;
  isOem: boolean;
  priceCents: number;
};

/**
 * Matching key for a part number. Case and internal spaces are noise
 * ("228-35145-91" vs "228-35145-91 " vs "228-35145-91" in caps are one PN);
 * dashes are NOT stripped, because their position is part of the number -
 * "5181-3323" and "51813-323" are different parts that would collide.
 */
export function normalizePn(pn: string): string {
  return pn.toLowerCase().replace(/\s+/g, "");
}

/**
 * Cheapest first. At the same price the OEM's listing wins - provenance
 * breaks the tie - and vendor name orders the rest so the list is stable.
 */
export function rankPrices<T extends PriceEntry>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.priceCents - b.priceCents
    || Number(b.isOem) - Number(a.isOem)
    || a.vendor.localeCompare(b.vendor));
}

/** Every price on file for one part number, best offer first. */
export function pricesFor<T extends PriceEntry>(book: T[], pn: string): T[] {
  const key = normalizePn(pn);
  if (!key) return [];
  return rankPrices(book.filter((r) => normalizePn(r.partNumber) === key));
}

/** The offer "request part" should fill in, or null if nobody prices it. */
export function bestPrice<T extends PriceEntry>(book: T[], pn: string): T | null {
  return pricesFor(book, pn)[0] ?? null;
}

/** The whole book folded by part number, each PN's offers best-first. */
export function groupByPn<T extends PriceEntry>(book: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rankPrices(book)) {
    const key = normalizePn(r.partNumber);
    const list = out.get(key);
    if (list) list.push(r);
    else out.set(key, [r]);
  }
  return out;
}
