// Catalog publishability. System provenance - who held a machine and what was
// done to it - is a different thing entirely and lives in lib/custody/.
// Where a piece of reference material came from, and therefore whether it may
// be licensed to another service provider.
//
// The library being built here is meant to be leased: a new provider adds a
// G6495C and inherits the maintenance, the checkout, the notes. What can travel
// is what the shop wrote or established itself. A manufacturer's own manual
// text or figures may sit in the library - it is useful, and filing it is
// legitimate - but it is theirs, and it must never leave with a subscription.
//
// The distinction is decided when a thing is written, by the person writing it,
// because that is the only moment anybody actually knows. Auditing a thousand
// notes afterwards is the thing this exists to avoid.
//
// Pure and dependency-free: the flag is a column on catalog_refs and
// procedures, and every reader asks these functions rather than comparing
// strings, so "publishable" has one definition.

/**
 * '' is deliberately the default and deliberately NOT publishable. Material
 * nobody has classified is material nobody has checked, and the safe reading of
 * unchecked is "not ours to sell" - the expensive mistake runs the other way.
 */
import type { Tone } from "@/lib/tones";

export const PROVENANCE = ["", "original", "facts", "oem"] as const;
export type Provenance = (typeof PROVENANCE)[number];

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  "": "Unreviewed",
  original: "Our IP",
  facts: "Restated facts",
  oem: "OEM material",
};

/** The sentence under each choice on the picker - what the writer is asserting. */
export const PROVENANCE_BLURB: Record<Provenance, string> = {
  "": "Nobody has said where this came from yet. It stays out of anything licensed.",
  original: "Written, drawn or measured by us - from the instrument or our own field notes.",
  facts: "Specs, intervals, part numbers and the like, restated in our own words.",
  oem: "The manufacturer's own words or figures. Useful in the shop, never licensed out.",
};

/** Chip tones. Unstated is a fact with no judgement; original is ours (good);
    facts travel (info); OEM material is the one to watch before licensing. */
export const PROVENANCE_TONE: Record<Provenance, Tone> = {
  "": "neutral",
  original: "good",
  facts: "info",
  oem: "warn",
};

/** Unknown strings become '' rather than throwing - see the default above. */
export const cleanProvenance = (raw: string | null | undefined): Provenance =>
  (PROVENANCE as readonly string[]).includes((raw ?? "").trim())
    ? ((raw ?? "").trim() as Provenance)
    : "";

/**
 * May this row travel with a licensed library?
 *
 * Our own work and our own restatement of facts, and nothing else. Facts are
 * not anybody's property; the words carrying them are, and 'facts' asserts the
 * words are ours.
 */
export const isPublishable = (raw: string | null | undefined): boolean => {
  const p = cleanProvenance(raw);
  return p === "original" || p === "facts";
};

/** Which choices a person may pick. '' is a state rows start in, not a choice. */
export const PROVENANCE_CHOICES: Provenance[] = ["original", "facts", "oem"];

export type ProvenanceTally = {
  total: number;
  publishable: number;
  unreviewed: number;
  byKind: Record<Provenance, number>;
};

/** How much of a library is cleared, for the header line on the catalog page. */
export function tallyProvenance(rows: { provenance?: string | null }[]): ProvenanceTally {
  const byKind: Record<Provenance, number> = { "": 0, original: 0, facts: 0, oem: 0 };
  for (const r of rows) byKind[cleanProvenance(r.provenance)]++;
  return {
    total: rows.length,
    publishable: byKind.original + byKind.facts,
    unreviewed: byKind[""],
    byKind,
  };
}

/** "18 of 24 clear to license · 4 unreviewed" - empty when there is nothing filed. */
export function tallyLine(t: ProvenanceTally): string {
  if (!t.total) return "";
  const parts = [`${t.publishable} of ${t.total} clear to license`];
  if (t.unreviewed) parts.push(`${t.unreviewed} unreviewed`);
  if (t.byKind.oem) parts.push(`${t.byKind.oem} OEM`);
  return parts.join(" · ");
}
