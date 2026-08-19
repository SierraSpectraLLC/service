// One definition of what "searching" means, so every box in the app answers
// the same way.
//
// The rules, and why each one:
//
//   Case-insensitive. Nobody types "LCMS-8060" with the capitals right while
//   holding a phone in a cold room.
//
//   EVERY term must match, each anywhere in the record. "trace 1310" finds the
//   system whose ID is one thing and whose module is the other - the two words
//   do not have to be adjacent, or even in the same field, because a person
//   typing two words is naming two facts about one thing.
//
//   Punctuation-insensitive on top of the plain match. "22852708" finds
//   228-52708-91 and "lc20ad" finds LC-20AD. Part numbers and serials are
//   written with whatever separators the manufacturer felt like, and remembering
//   which is not a skill anybody should need.
//
// Pure and dependency-free: the client-side lists filter through matchesQuery,
// and the SQL search page builds the same shape in `and(...terms.map(or(...)))`
// so the two agree about what a match is.

/** Lowercased, whitespace collapsed. The form both sides compare in. */
export const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Letters and digits only - what makes "lc20ad" find "LC-20AD". */
export const alnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The words somebody typed. Quoted runs stay together, so "annual pm" can be
 * asked for as one phrase when the two words apart would be too loose.
 */
export function searchTerms(q: string): string[] {
  const out: string[] = [];
  for (const m of (q ?? "").matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = normalize(m[1] ?? m[2] ?? "");
    if (term) out.push(term);
  }
  return out;
}

/**
 * Does this record match? `fields` is everything about it worth searching -
 * pass the pieces, not a pre-joined string, so a term can never match across
 * the seam between two unrelated values.
 */
export function matchesQuery(q: string, fields: (string | null | undefined)[]): boolean {
  const terms = searchTerms(q);
  if (!terms.length) return true;
  const plain = fields.map((f) => normalize(String(f ?? ""))).filter(Boolean);
  // Built once per record rather than per term.
  const squashed = fields.map((f) => alnum(String(f ?? ""))).filter(Boolean);
  return terms.every((t) => {
    if (plain.some((f) => f.includes(t))) return true;
    const a = alnum(t);
    return a.length >= 2 && squashed.some((f) => f.includes(a));
  });
}
