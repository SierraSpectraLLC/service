import type { MetadataRoute } from "next";
import { appUrl } from "@/lib/appUrl";

/**
 * The public library is the only indexable surface. Everything else is a
 * signed-in application or a bearer-token page, and neither belongs in a
 * search index - the token pages especially, where being findable would
 * defeat the token.
 */
export default function robots(): MetadataRoute.Robots {
  const url = appUrl();
  return {
    rules: [{
      userAgent: "*",
      allow: ["/equipment"],
      disallow: ["/", "/api/", "/listing/", "/drop/", "/share/", "/catalog/", "/settings/"],
    }],
    ...(url ? { sitemap: `${url}/sitemap.xml`, host: url } : {}),
  };
}
