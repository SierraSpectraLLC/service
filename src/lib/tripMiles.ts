// The engineer-specific answer to "how far is this lab", remembered.
//
// The strip on a work order wants one number per (signed-in engineer, site).
// Computing it live would put a routing provider on a page's critical path;
// instead this reads drive_cache and only goes to the network on a miss or
// when either end has moved - which for homes and laboratories is rarely.

import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { driveCache, houseMembers, orgSites } from "@/db/schema";
import { coordsMoved, drivingMiles, type LatLng } from "@/lib/geo";

export type SiteMiles = {
  siteId: number;
  /** Routed (or estimated) miles from THIS engineer's home, rounded whole. */
  miles: number;
  estimated: boolean;
};

/**
 * Road miles from one engineer's home to each of the given sites. Sites
 * without coordinates, or an engineer without a home base, simply drop out -
 * the caller falls back to the site's typed default, and nothing errors.
 */
export async function tripMilesFor(email: string, siteIds: number[]): Promise<SiteMiles[]> {
  if (!siteIds.length) return [];
  const [member] = await db.select().from(houseMembers)
    .where(eq(houseMembers.email, email.toLowerCase()));
  if (!member || member.homeLat === null || member.homeLng === null) return [];
  const home: LatLng = { lat: member.homeLat, lng: member.homeLng };

  const sites = (await db.select().from(orgSites).where(inArray(orgSites.id, siteIds)))
    .filter((s) => s.lat !== null && s.lng !== null);
  if (!sites.length) return [];
  const cached = await db.select().from(driveCache)
    .where(eq(driveCache.memberEmail, member.email));

  const out: SiteMiles[] = [];
  for (const s of sites) {
    const to: LatLng = { lat: s.lat!, lng: s.lng! };
    const hit = cached.find((c) => c.siteId === s.id);
    // A routed row whose endpoints still stand is the answer; an ESTIMATED
    // row is retried, because it exists only because a router once failed.
    if (hit && !hit.estimated && !coordsMoved(hit, home, to)) {
      out.push({ siteId: s.id, miles: Math.round(hit.miles), estimated: false });
      continue;
    }
    const driven = await drivingMiles(home, to);
    await db.insert(driveCache).values({
      memberEmail: member.email, siteId: s.id, miles: driven.miles,
      fromLat: home.lat, fromLng: home.lng, toLat: to.lat, toLng: to.lng,
      estimated: driven.estimated, computedAt: new Date(),
    }).onConflictDoUpdate({
      target: [driveCache.memberEmail, driveCache.siteId],
      set: {
        miles: driven.miles, fromLat: home.lat, fromLng: home.lng,
        toLat: to.lat, toLng: to.lng, estimated: driven.estimated, computedAt: new Date(),
      },
    });
    out.push({ siteId: s.id, miles: Math.round(driven.miles), estimated: driven.estimated });
  }
  return out;
}
