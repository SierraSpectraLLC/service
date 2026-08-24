import type { MetadataRoute } from "next";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { vocabTerms } from "@/db/schema";
import { appUrl } from "@/lib/appUrl";
import { getModules } from "@/lib/flags";

export const dynamic = "force-dynamic";

/**
 * Only the published models, and only when the app knows its own address -
 * a sitemap of relative URLs is worse than none. Everything else in the app
 * is behind a sign-in and has no business in an index.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const url = appUrl();
  // Relative URLs in a sitemap are worse than no sitemap.
  if (!url) return [];
  const { publicCatalog } = await getModules();
  // The landing page stands whether or not the library is switched on; it is
  // the root of the site and the only page every other one links back to.
  const home = [{ url, changeFrequency: "weekly" as const, priority: 1 }];
  if (!publicCatalog) return home;
  const rows = await db.select({ slug: vocabTerms.publicSlug }).from(vocabTerms)
    .where(and(eq(vocabTerms.published, true), eq(vocabTerms.kind, "model")))
    .orderBy(asc(vocabTerms.publicSlug))
    .catch(() => []);
  return [
    ...home,
    { url: `${url}/equipment`, changeFrequency: "weekly", priority: 0.8 },
    ...rows.filter((r) => r.slug).map((r) => ({
      url: `${url}/equipment/${r.slug}`,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ];
}
