// What the anonymous landing page is allowed to say about this instance.
//
// The page makes two claims a stranger has no reason to believe - that the
// library is real, and that it was written from service work rather than
// scraped. Numbers settle the first one, and the only numbers safe to print
// are the ones already public: `published` is the operator's explicit "this
// may be indexed" (see lib/publicCatalog), so every row counted here already
// has a crawlable page of its own at /equipment/<slug>.
//
// Nothing else on the instance may be counted here. A part-catalog size or a
// work-order tally would be an aggregate over every tenant's private data,
// published to strangers, on the one page with no session behind it - the
// exact shape of leak the rest of lib/tenancy exists to prevent. If a future
// stat is wanted here it must clear the same bar: already public, per row.
import { cache } from "react";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { vocabTerms } from "@/db/schema";

export type FeaturedModel = {
  name: string;
  manufacturer: string;
  assetType: string;
  slug: string;
};

export type LandingLibrary = {
  /** Published models, which is exactly how many pages /equipment lists. */
  models: number;
  /** Distinct manufacturers among them, alphabetical. */
  makers: string[];
  /** A spread of real models, at most one per maker, for the apex to link. */
  featured: FeaturedModel[];
};

export const EMPTY_LIBRARY: LandingLibrary = { models: 0, makers: [], featured: [] };

/**
 * cache() because the page renders this once and the metadata may want the
 * count too. Never throws: the landing page is the front door of the site and
 * a missing table must cost it a section, not the whole render.
 *
 * The featured spread takes the FIRST model of each manufacturer rather than
 * the first six rows, so six Agilent pumps don't crowd out every other maker
 * the shop actually works on - the point of the strip is breadth.
 */
export const landingLibrary = cache(async (): Promise<LandingLibrary> => {
  try {
    const rows = await db.select({
      name: vocabTerms.name,
      manufacturer: vocabTerms.manufacturer,
      assetType: vocabTerms.assetType,
      slug: vocabTerms.publicSlug,
    }).from(vocabTerms)
      .where(and(eq(vocabTerms.published, true), eq(vocabTerms.kind, "model")))
      .orderBy(asc(vocabTerms.manufacturer), asc(vocabTerms.name));

    // A published row with no slug has no page to link to, so it is countable
    // but not featurable - the same distinction /equipment already draws.
    const makers = [...new Set(rows.map((r) => r.manufacturer.trim()).filter(Boolean))].sort();
    const seen = new Set<string>();
    const featured: FeaturedModel[] = [];
    for (const r of rows) {
      const maker = r.manufacturer.trim();
      if (!r.slug || seen.has(maker)) continue;
      seen.add(maker);
      featured.push({ name: r.name, manufacturer: maker, assetType: r.assetType, slug: r.slug });
      if (featured.length === 6) break;
    }
    return { models: rows.length, makers, featured };
  } catch {
    return EMPTY_LIBRARY;
  }
});
