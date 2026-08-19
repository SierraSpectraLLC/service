import type { MetadataRoute } from "next";
import { appUrl } from "@/lib/appUrl";
import { getModules } from "@/lib/flags";

/**
 * The public library is the only indexable surface. Everything else is a
 * signed-in application or a bearer-token page, and neither belongs in a
 * search index - the token pages especially, where being findable would
 * defeat the token.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const url = appUrl();
  const { publicCatalog } = await getModules();
  return {
    rules: [{
      userAgent: "*",
      // While the library is off there is nothing here for anybody: disallow
      // the whole site rather than advertising a door that answers 404.
      ...(publicCatalog ? { allow: ["/equipment"] } : {}),
      disallow: ["/", "/api/", "/listing/", "/drop/", "/share/", "/catalog/", "/settings/"],
    }],
    ...(url && publicCatalog ? { sitemap: `${url}/sitemap.xml`, host: url } : {}),
  };
}
