// The public face of the equipment catalog: which models may be indexed, what
// of them may be shown, and the URL each one lives at.
//
// The bargain this encodes: FACTS ATTRACT, EXECUTION CONVERTS. What a model is
// - its specs, its part numbers, what its kits contain, how often it needs
// maintenance - is what people search for, is not anybody's property, and goes
// out. How the shop actually does the work - checklists, field notes, the
// tricks - stays behind the sign-in, because that is the product.
//
// Two hard rules, both about not publishing what isn't ours to publish:
//   1. Only provenance-cleared material (lib/provenance) reaches a public page.
//      OEM-sourced text is defensible on an internal shelf and indefensible on
//      an indexed one - the exposure is categorically worse in public.
//   2. A page must EARN indexing. Thin auto-generated pages are what search
//      engines penalize, so a model needs real substance before it goes out
//      (see publishBlockers) - twenty good pages beat four hundred stubs.

import { isPublishable } from "@/lib/provenance";
import type { Spec } from "@/lib/modelSpecs";

/** Minimum prose that makes a page worth indexing, in characters. */
export const MIN_SUMMARY = 100;
export const MIN_SPECS = 3;
export const MAX_SUMMARY = 1200;

/**
 * "agilent-g7116b" - the manufacturer disambiguates, since model numbers
 * collide across makers ("Model 200" is everybody's). Numeric ids are
 * deliberately not used: they read badly in results and tell the world how
 * many rows the table has.
 */
export function modelSlug(manufacturer: string, name: string): string {
  const raw = `${manufacturer} ${name}`.trim();
  const slug = raw
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")   // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug;
}

/** Same slug twice is a broken URL - suffix until it's free. */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((s) => s.toLowerCase()));
  if (!used.has(base)) return base;
  for (let n = 2; n < 500; n++) {
    const next = `${base}-${n}`;
    if (!used.has(next)) return next;
  }
  return `${base}-${Date.now()}`;
}

export type PublishCandidate = {
  manufacturer: string;
  name: string;
  summary: string;
  specs: Spec[];
  hasPhoto: boolean;
};

/**
 * Why this model can't go public yet - empty means it can. Ordered the way
 * somebody would fix them.
 *
 * The summary is required and is the whole point: it is the one piece of
 * writing on the page that exists nowhere else, and a page whose every word is
 * generated from a table is the exact thing that gets a domain buried.
 */
export function publishBlockers(m: PublishCandidate): string[] {
  const out: string[] = [];
  if (!m.manufacturer.trim()) out.push("Record the manufacturer - the public URL is built from it");
  if (m.summary.trim().length < MIN_SUMMARY) {
    out.push(`Write a summary of at least ${MIN_SUMMARY} characters - it's the part of the page that's yours`);
  }
  if (m.specs.length < MIN_SPECS) out.push(`Add at least ${MIN_SPECS} specifications`);
  return out;
}

/** Not blocking, but worth saying before it goes out. */
export function publishWarnings(m: PublishCandidate): string[] {
  return m.hasPhoto ? [] : ["No photo - pages with one do considerably better"];
}

export const canPublish = (m: PublishCandidate): boolean => publishBlockers(m).length === 0;

/**
 * Which references may appear publicly: ours, or our own restatement of facts.
 * Anything unreviewed or OEM-sourced is withheld - see the note at the top.
 * Only ever their TITLES render publicly; bodies are the gated half.
 */
export const publicRefs = <T extends { provenance?: string | null }>(refs: T[]): T[] =>
  refs.filter((r) => isPublishable(r.provenance));

/**
 * The meta description: the summary, trimmed to a length search engines
 * actually render, cut at a word boundary so it doesn't end mid-word.
 */
export function metaDescription(summary: string, fallback: string): string {
  const s = summary.replace(/\s+/g, " ").trim() || fallback;
  if (s.length <= 155) return s;
  const cut = s.slice(0, 155);
  const at = cut.lastIndexOf(" ");
  return `${(at > 80 ? cut.slice(0, at) : cut).replace(/[,;:.\s]+$/, "")}…`;
}

/** "Agilent G7116B multisampler - specs, PM kit and maintenance schedule" */
export function pageTitle(manufacturer: string, name: string, assetType: string): string {
  const who = manufacturer.trim();
  return `${who ? `${who} ` : ""}${name} ${assetType.toLowerCase()} - specs, parts and maintenance`;
}

/**
 * Product structured data, for rich results. Specs travel as additionalProperty,
 * which is the vocabulary search engines actually read for them. No price and
 * no offer: nothing here is for sale, and claiming otherwise in markup is how
 * a site earns a manual action.
 */
export function productJsonLd(m: {
  name: string; manufacturer: string; assetType: string; summary: string;
  specs: Spec[]; url: string; imageUrl?: string;
}): string {
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: `${m.manufacturer ? `${m.manufacturer} ` : ""}${m.name}`,
    model: m.name,
    category: m.assetType,
    url: m.url,
  };
  if (m.manufacturer) data.brand = { "@type": "Brand", name: m.manufacturer };
  if (m.summary.trim()) data.description = m.summary.replace(/\s+/g, " ").trim();
  if (m.imageUrl) data.image = m.imageUrl;
  if (m.specs.length) {
    data.additionalProperty = m.specs.map((s) => ({
      "@type": "PropertyValue", name: s.name, value: s.value,
    }));
  }
  // Escaped so a "</script>" inside somebody's spec value can't close the tag.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/** How often a job comes round, in words a reader (and a search engine) uses. */
export function cadenceWords(days: number | null): string {
  if (days === null) return "as needed";
  if (days <= 1) return "daily";
  if (days <= 7) return "weekly";
  if (days <= 14) return "every two weeks";
  if (days <= 31) return "monthly";
  if (days <= 92) return "quarterly";
  if (days <= 183) return "every six months";
  if (days <= 370) return "annually";
  return `every ${Math.round(days / 365)} years`;
}

/**
 * "an LC-30ADSF", "a G7116B" - by the SOUND of the first letter, not the
 * letter. Model numbers are read out as letters ("el-see"), so the usual
 * vowel test gets them backwards. A public page with a grammar slip in its
 * headline reads as machine-made, which is the one impression these pages
 * cannot afford.
 */
export function article(name: string): "a" | "an" {
  const first = name.trim().charAt(0);
  if (!first) return "a";
  // Letters whose spoken name begins with a vowel sound, plus actual vowels.
  if (/[aeiou]/i.test(first)) return "an";
  if (/^[a-z]$/i.test(first)) return /[fhlmnrsx]/i.test(first) ? "an" : "a";
  return "a";
}
