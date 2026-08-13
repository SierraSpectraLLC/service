// What this instance calls itself. The portal is a product rather than one
// service company's tool, so no visible string names a company: the wordmark,
// page title, sign-in copy and email headers all read from app_settings, which
// the owner edits without a deploy. lib/brand is the only place that knows the
// fallback.
import { eq } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/db";
import { appSettings, orgs } from "@/db/schema";

export const DEFAULT_BRAND = "Service Portal";

export type Brand = {
  name: string;
  tagline: string;
  /** The service organization running this instance, for documents it signs. */
  operatorName: string;
  operatorOrgId: number | null;
  /** The operator org's logo (blob URL), shown on those same documents. */
  operatorLogoUrl: string;
};

/**
 * cache() so the layout and the page it wraps share one lookup per request.
 * Never throws: an instance with no settings row still renders under the
 * default name.
 *
 * One round trip, via a left join to the operator org. This runs on every
 * render in the app including the sign-in page, so a second sequential query
 * for the operator's name was a latency tax on literally every request.
 */
export const getBrand = cache(async (): Promise<Brand> => {
  try {
    const [s] = await db
      .select({
        platformName: appSettings.platformName,
        platformTagline: appSettings.platformTagline,
        operatorOrgId: appSettings.operatorOrgId,
        operatorName: orgs.name,
        operatorLogoUrl: orgs.logoUrl,
      })
      .from(appSettings)
      .leftJoin(orgs, eq(orgs.id, appSettings.operatorOrgId))
      .where(eq(appSettings.id, 1));
    const name = s?.platformName?.trim() || DEFAULT_BRAND;
    const operatorName = s?.operatorName ?? "";
    const operatorLogoUrl = s?.operatorLogoUrl ?? "";
    return {
      name,
      tagline: s?.platformTagline?.trim() || "instrument portal",
      // Documents fall back to the platform name when no operator org is set.
      operatorName: operatorName || name,
      operatorOrgId: s?.operatorOrgId ?? null,
      operatorLogoUrl,
    };
  } catch {
    return { name: DEFAULT_BRAND, tagline: "instrument portal", operatorName: DEFAULT_BRAND, operatorOrgId: null, operatorLogoUrl: "" };
  }
});

/**
 * Who signs a document about one record: the operator whose workspace it belongs
 * to, not the company that runs the instance.
 *
 * A sign-off packet, a service report, a QR label - each of these is one service
 * company putting its name to work it did. With one operator those were the same
 * thing, and everything read them off app_settings. With several, a report about
 * another operator's system carrying our name on it would be a false statement
 * about who did the work.
 *
 * The PLATFORM's name and tagline stay the instance's: the product is the
 * platform, and the operator is who signs. Per-tenant white-labelling of the
 * shell itself is a deliberate step beyond this, not an accident of it.
 */
export const brandForTenant = cache(async (tenantOrgId: number | null): Promise<Brand> => {
  const base = await getBrand();
  if (tenantOrgId === null || tenantOrgId === base.operatorOrgId) return base;
  try {
    const [o] = await db.select({ name: orgs.name, logoUrl: orgs.logoUrl })
      .from(orgs).where(eq(orgs.id, tenantOrgId));
    if (!o) return base;
    return {
      ...base,
      operatorName: o.name || base.operatorName,
      operatorOrgId: tenantOrgId,
      operatorLogoUrl: o.logoUrl,
    };
  } catch {
    return base;
  }
});
