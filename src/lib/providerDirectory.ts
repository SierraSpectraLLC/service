// The directory every service company on the instance can search.
//
// The reason to have more than one operator here at all: two shops that both
// service mass specs, four hundred miles apart, each turning down work the
// other would take. They cannot refer to each other if they cannot find each
// other, and today they cannot - visibleOrgs hides operators from each other
// on purpose (lib/tenancy) after a workspace handed to a prospective buyer
// listed the seller in its own org picker.
//
// So the directory is an EXCEPTION to that rule and is shaped to stay a narrow
// one. A company appears because it asked to; the row says what it services and
// where, and nothing about who it services. A listing is a shop's shopfront,
// not its client list.
//
// Pure. Callers hand in the rows.

export type ProviderListing = {
  orgId: number;
  name: string;
  listed: boolean;
  blurb: string;
  services: string[];
  regions: string[];
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  website: string;
};

/** How many of each a listing may carry. A tag list of forty is not a listing. */
export const MAX_TAGS = 12;
export const MAX_TAG_LEN = 40;
export const MAX_BLURB = 400;

/** Split what somebody typed into tags. Commas and newlines; spaces are kept. */
export function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\n]+/)) {
    const t = part.trim().replace(/\s+/g, " ").slice(0, MAX_TAG_LEN);
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Everything wrong with a listing somebody is trying to publish. */
export function profileProblems(p: {
  listed: boolean; services: string[]; regions: string[]; blurb: string; contactEmail: string;
}): string[] {
  const out: string[] = [];
  // Only checked when they actually want to be found. A half-filled draft that
  // nobody can see is not a problem, it is a draft.
  if (!p.listed) return out;
  if (p.services.length === 0) out.push("Say what you service, or nobody can find you");
  if (p.regions.length === 0) out.push("Say where you work");
  if (p.blurb.trim().length > MAX_BLURB) out.push(`Keep the description under ${MAX_BLURB} characters`);
  if (p.contactEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.contactEmail.trim())) {
    out.push("That contact address is not an address");
  }
  return out;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Does this listing answer what somebody typed?
 *
 * Every word has to hit something - name, services, regions or blurb - so
 * "sciex seattle" finds a shop that does both rather than every shop that does
 * either. Substring rather than whole-word, because "WA" should find
 * "Washington" and a person searching a directory is guessing at somebody
 * else's vocabulary.
 */
export function matches(l: ProviderListing, query: string): boolean {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [l.name, l.blurb, ...l.services, ...l.regions].map(norm).join(" | ");
  return words.every((w) => hay.includes(w));
}

/** Listed companies that answer the query, best first. */
export function search(all: ProviderListing[], query: string): ProviderListing[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  const score = (l: ProviderListing) => {
    // A hit on the NAME is what somebody typing a company name wants first; a
    // hit on a service tag beats one buried in prose.
    let n = 0;
    for (const w of words) {
      if (norm(l.name).includes(w)) n += 4;
      if (l.services.some((s) => norm(s).includes(w))) n += 2;
      if (l.regions.some((r) => norm(r).includes(w))) n += 2;
    }
    return n;
  };
  return all
    .filter((l) => l.listed && matches(l, query))
    .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}

/** The one line under a company's name in a result. */
export function listingLine(l: ProviderListing): string {
  return [l.services.join(", "), l.regions.join(", ")].filter(Boolean).join(" · ");
}
