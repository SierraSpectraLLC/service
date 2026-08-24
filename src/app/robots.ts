import type { MetadataRoute } from "next";
import { appUrl } from "@/lib/appUrl";
import { getModules } from "@/lib/flags";

/**
 * Deny by default, allow the few pages meant for strangers.
 *
 * The posture is deliberate and it is the safe direction for an application
 * whose every other route holds somebody's client data. `Disallow: /` covers
 * the app, and each public surface is named:
 *
 *   /$          the landing page, and ONLY the landing page. The `$` is the
 *               end-of-path wildcard both Google and Bing honour; without it
 *               "/" would allow the entire site and undo the rule above.
 *   /equipment  the library, which exists to be found.
 *
 * A page added later is invisible to crawlers until somebody names it here.
 * That is the point: forgetting to allow a marketing page costs a little
 * traffic, forgetting to disallow a client's invoice costs a great deal more.
 * The token pages (/share, /drop, /listing) are listed anyway - belt and
 * braces on the ones where being findable would defeat the credential.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const url = appUrl();
  const { publicCatalog } = await getModules();
  return {
    rules: [{
      userAgent: "*",
      allow: ["/$", ...(publicCatalog ? ["/equipment"] : [])],
      disallow: ["/", "/api/", "/listing/", "/drop/", "/share/", "/catalog/", "/settings/"],
    }],
    ...(url ? { sitemap: `${url}/sitemap.xml`, host: url } : {}),
  };
}
