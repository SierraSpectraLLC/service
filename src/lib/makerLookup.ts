// Where a maker's own site searches for one of its numbers.
//
// Asked for on the parts catalog: "I would like to mass-search Waters for parts
// to add, based off parts I have already." Waters, like most of the makers in
// the book, answers a plain search URL with the part number in it - so the
// cheapest possible integration is a link, built from what the form already
// holds, that opens the maker's search on that number. No scraping, no API
// key, nothing that breaks when their site changes its markup: if the URL
// stops working the link stops working, and somebody edits one line here.
//
// Keyed on the manufacturer as typed, because the number alone does not say
// whose it is: 700000341 is a Waters number only because the row says Waters.

export type MakerLookup = { maker: string; url: string };

/**
 * Each entry: how the maker's name is recognised (any of the words, matched
 * case-insensitively against the manufacturer field), how the link is
 * labelled, and the search URL with the number already encoded.
 */
const MAKERS: { match: string[]; maker: string; url: (q: string) => string }[] = [
  {
    match: ["waters", "micromass"],
    maker: "Waters",
    url: (q) => `https://www.waters.com/nextgen/us/en/search.html?category=All&enableHL=true&isocode=en_US&keyword=${q}&multiselect=true&page=1&rows=12&sort=most-relevant`,
  },
  {
    match: ["agilent"],
    maker: "Agilent",
    url: (q) => `https://www.agilent.com/search/?Ntt=${q}`,
  },
  {
    match: ["thermo"],
    maker: "Thermo Fisher",
    url: (q) => `https://www.thermofisher.com/search/results?query=${q}`,
  },
];

/**
 * The maker's search page for this part, or null when the maker is not one
 * we know how to search or there is no number to search for.
 *
 * Searches THEIR number when the row has one, else ours - a shop number like
 * AGI-7167-PMK means nothing to Agilent, but most rows in the book carry the
 * maker's number as the part number itself, and that one does.
 */
export function makerLookup(e: { manufacturer?: string; mfrPartNumber?: string; partNumber?: string }): MakerLookup | null {
  const maker = (e.manufacturer ?? "").trim().toLowerCase();
  if (!maker) return null;
  const hit = MAKERS.find((m) => m.match.some((w) => maker.includes(w)));
  if (!hit) return null;
  const number = (e.mfrPartNumber ?? "").trim() || (e.partNumber ?? "").trim();
  if (!number) return null;
  return { maker: hit.maker, url: hit.url(encodeURIComponent(number)) };
}
