// The anonymization and verification policy, decided 2026-09-03 and written
// down once. See the Policy section of docs/adr/0001-custody-and-provenance.md.
//
// Named constants rather than magic values in five surfaces, because each of
// these is a decision somebody made about what a stranger gets to know, and a
// surface that hard-codes "14" or rounds a date on its own has quietly taken
// that decision back.

/**
 * A provider's name does not follow its work downstream unless the provider
 * says so. Free advertising for a national; a re-identification for a shop
 * that services four instruments in one county. The provider owns the switch.
 */
export const SHOW_NAME_DOWNSTREAM_DEFAULT = false;

/**
 * Dates travel exact. A PM done on a Tuesday is provenance about the machine,
 * not about the shop, and rounding it would corrupt the plan recomputation for
 * no privacy gain. Kept as a named policy so the projection has one answer.
 */
export const DATE_GRANULARITY = "exact" as const;

/**
 * Region never travels. "Service provider, California" re-identifies a
 * regional shop in one guess, which is the whole anonymization undone by a
 * single field.
 */
export const REGION_TRAVELS = false;

/** How long a claim waits for the current holder before resolving silently. */
export const CLAIM_NOTICE_DAYS = 14;

/**
 * What `orgs.verified_at` certifies. It gates the third_party grade: an org
 * grading its own subsidiary as third-party is the obvious way to buy a score.
 */
export const VERIFICATION_REQUIRES = [
  "business registration on file",
  "an email domain the organization controls",
  "at least one grant from an unrelated verified organization",
] as const;

/**
 * Keys that must never appear on the travelling half of an event. The list is
 * the contract Phase 4's forms and tests hold each other to: anything here in
 * `provenance` is a leak, and a build that lets one through is a failing test
 * rather than a customer's site address in a stranger's hands.
 */
export const PROVENANCE_DENYLIST = [
  "site", "contact", "price", "cost", "lot", "notes", "room", "email", "phone",
  "address", "po", "ask", "requestedBy", "requestedByEmail",
] as const;

/** True when a travelling payload carries a key it must not. */
export function provenanceLeaks(provenance: Record<string, unknown>): string[] {
  const bad = new Set<string>(PROVENANCE_DENYLIST);
  const found: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const here = path ? `${path}.${k}` : k;
        if (bad.has(k)) found.push(here);
        walk(v, here);
      }
    }
  };
  walk(provenance, "");
  return found;
}
