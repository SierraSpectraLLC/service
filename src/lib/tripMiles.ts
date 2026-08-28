// The engineer-specific answer to "how far is this lab", remembered.
//
// The strip on a work order wants one number per (signed-in engineer, site).
// Computing it live would put a routing provider on a page's critical path;
// instead this reads drive_cache and only goes to the network on a miss or
// when either end has moved - which for homes and laboratories is rarely.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { driveCache, houseMembers, instruments, orgSites, workOrders } from "@/db/schema";
import { coordsMoved, drivingMiles, type LatLng } from "@/lib/geo";
import { siteLabel } from "@/lib/sites";

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


/** One candidate lab for a job, with the distance the rulebook will judge. */
export type TripSite = {
  siteId: number;
  name: string;
  /**
   * Road miles one way from the CLAIMANT's home, or null when the app cannot
   * say - no home base on file, or a site that never geocoded. Null is a real
   * answer that the rulebook handles; a zero here would read as "next door"
   * and quietly flag every honest claim.
   */
  miles: number | null;
  /** True when it is a straight-line guess because the router was unreachable. */
  estimated: boolean;
};

export type WorkOrderTrip = {
  sites: TripSite[];
  /** The job's own lab - its system's site - when it has one. */
  defaultSiteId: number | null;
};

/**
 * The labs a job could have been worked at, and how far each is from the
 * person whose claim this is.
 *
 * WHOSE home is the whole point, and the easy thing to get wrong. A report's
 * per diem is judged against the CLAIMANT's home base, not the reader's: when
 * the office manager fills a claim for an engineer who lives eighty miles the
 * other side of town, computing it from the reader would price the trip off
 * the wrong doorstep and either flag an honest lunch or wave through one that
 * should have been queried. Same principle as lib/hr.reportSubjectFor, and the
 * caller passes the same address.
 *
 * The default site is the job's system's site - one job, one machine, one
 * building, nearly always. The rest of the client's labs come along because
 * "nearly always" is not always, and a picker beats a wrong number.
 *
 * Falls back to the site's own typed one-way miles when no route is known, and
 * to null when even that is unset. Nothing here throws: a page that cannot
 * work out a distance shows the claim unruled rather than failing to render.
 */
export async function workOrderTrip(
  claimantEmail: string, workOrderId: number,
): Promise<WorkOrderTrip> {
  const none: WorkOrderTrip = { sites: [], defaultSiteId: null };
  const [wo] = await db.select({
    orgId: workOrders.orgId, instrumentId: workOrders.instrumentId, assetId: workOrders.assetId,
  }).from(workOrders).where(eq(workOrders.id, workOrderId));
  if (!wo || wo.orgId === null) return none;

  const [siteRows, instRows] = await Promise.all([
    db.select().from(orgSites)
      .where(and(eq(orgSites.orgId, wo.orgId), eq(orgSites.archived, false))),
    /* A system knows which building it is installed in; a bare asset does not
       carry a site of its own. So a job on an asset falls through to the
       client's sites, which is where the picker earns its keep. */
    wo.instrumentId === null ? Promise.resolve([]) : db.select({ siteId: instruments.siteId })
      .from(instruments).where(eq(instruments.id, wo.instrumentId)),
  ]);
  if (!siteRows.length) return none;

  const routed = await tripMilesFor(claimantEmail, siteRows.map((s) => s.id)).catch(() => []);
  /* One live lab and no system to name it: that IS the job's site. Nobody
     should have to pick from a list of one. */
  const defaultSiteId = instRows[0]?.siteId ?? (siteRows.length === 1 ? siteRows[0].id : null);
  return {
    sites: siteRows.map((s) => {
      const hit = routed.find((r) => r.siteId === s.id);
      return {
        siteId: s.id,
        name: siteLabel(s),
        // The routed answer first; the site's own typed default second; then
        // null, which the rulebook reads as "somebody has to look at this".
        miles: hit ? hit.miles : (s.onewayMiles > 0 ? s.onewayMiles : null),
        estimated: hit?.estimated ?? false,
      };
    }),
    // Only when that site is actually one of the live ones offered.
    defaultSiteId: siteRows.some((s) => s.id === defaultSiteId) ? defaultSiteId : null,
  };
}
