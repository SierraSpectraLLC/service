// The engineer-specific answer to "how far is this lab", remembered.
//
// The strip on a work order wants one number per (signed-in engineer, site).
// Computing it live would put a routing provider on a page's critical path;
// instead this reads drive_cache and only goes to the network on a miss or
// when either end has moved - which for homes and laboratories is rarely.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { driveCache, houseMembers, instruments, orgSites, workOrders } from "@/db/schema";
import { coordsMoved, drivingMiles, geocode, type LatLng } from "@/lib/geo";
import { siteLabel } from "@/lib/sites";

export type SiteMiles = {
  siteId: number;
  /** Routed (or estimated) miles from where THIS engineer's trips start, rounded whole. */
  miles: number;
  estimated: boolean;
};

/**
 * Where this engineer's trips start.
 *
 * Their site location when they have one - the shop, or the client's lab a
 * dedicated engineer is stationed at - else their home. The site is an
 * OVERRIDE, not a fallback chain: a site that never geocoded answers null
 * rather than quietly measuring from the front door, because a distance
 * from the wrong doorstep flags honest claims and waves through the rest.
 * Null is a real answer the callers handle (the site's typed default, then
 * "somebody has to look at this").
 */
/**
 * Put a pin on a site that has an address and never got one.
 *
 * Coordinates are fetched when an address is SAVED, so a site saved while the
 * geocoder was unreachable keeps an address and no pin for ever - and every
 * per diem against it is flagged for a distance nobody can work out, months
 * after the hiccup that caused it. Retried here, where the answer is about to
 * be used, and written back so it is retried once rather than always.
 *
 * Returns the point, or null when there is no address or nobody could place
 * it. Never throws: an unplaceable address costs a distance, not a page.
 */
async function placeSite(site: { id: number; address: string; lat: number | null; lng: number | null }): Promise<LatLng | null> {
  if (site.lat !== null && site.lng !== null) return { lat: site.lat, lng: site.lng };
  if (!site.address.trim()) return null;
  const hit = await geocode(site.address).catch(() => null);
  if (!hit) return null;
  await db.update(orgSites).set({ lat: hit.lat, lng: hit.lng }).where(eq(orgSites.id, site.id));
  return { lat: hit.lat, lng: hit.lng };
}

/** The same, for the address somebody's own trips start from. */
async function placeHome(member: { email: string; homeAddress: string; homeLat: number | null; homeLng: number | null }): Promise<LatLng | null> {
  if (member.homeLat !== null && member.homeLng !== null) return { lat: member.homeLat, lng: member.homeLng };
  if (!member.homeAddress.trim()) return null;
  const hit = await geocode(member.homeAddress).catch(() => null);
  if (!hit) return null;
  await db.update(houseMembers).set({ homeLat: hit.lat, homeLng: hit.lng })
    .where(eq(houseMembers.email, member.email));
  return { lat: hit.lat, lng: hit.lng };
}

export async function tripOrigin(
  member: { siteId: number | null; homeLat: number | null; homeLng: number | null },
): Promise<LatLng | null> {
  if (member.siteId !== null) {
    const [site] = await db.select({ lat: orgSites.lat, lng: orgSites.lng })
      .from(orgSites).where(eq(orgSites.id, member.siteId));
    return site && site.lat !== null && site.lng !== null ? { lat: site.lat, lng: site.lng } : null;
  }
  if (member.homeLat === null || member.homeLng === null) return null;
  return { lat: member.homeLat, lng: member.homeLng };
}

/**
 * Road miles from where one engineer's trips start to each of the given
 * sites. Sites without coordinates, or an engineer with no placeable origin,
 * simply drop out - the caller falls back to the site's typed default, and
 * nothing errors.
 */
export async function tripMilesFor(email: string, siteIds: number[]): Promise<SiteMiles[]> {
  if (!siteIds.length) return [];
  const [member] = await db.select().from(houseMembers)
    .where(eq(houseMembers.email, email.toLowerCase()));
  if (!member) return [];
  const home = await tripOrigin(member);
  if (!home) return [];

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
   * Road miles one way from where the CLAIMANT's trips start (their site
   * location, else their home), or null when the app cannot say - no origin
   * on file, or a site that never geocoded. Null is a real
   * answer that the rulebook handles; a zero here would read as "next door"
   * and quietly flag every honest claim.
   */
  miles: number | null;
  /** True when it is a straight-line guess because the router was unreachable. */
  estimated: boolean;
  /** Why `miles` is null, in words a reviewer can act on. Blank when it is not. */
  why: string;
};

export type WorkOrderTrip = {
  sites: TripSite[];
  /** The job's own lab - its system's site - when it has one. */
  defaultSiteId: number | null;
  /**
   * Why no distance could be worked out, named rather than implied. Blank when
   * one could.
   *
   * "No home base on file for them, or the job's site has no address" sent a
   * reviewer to check two records, neither of which was necessarily the one at
   * fault - and the commonest cause was a third thing: an engineer whose site
   * location points at a client's building. So it says which end it was.
   */
  why: string;
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
  const none = (why: string): WorkOrderTrip => ({ sites: [], defaultSiteId: null, why });
  const [wo] = await db.select({
    orgId: workOrders.orgId, instrumentId: workOrders.instrumentId, assetId: workOrders.assetId,
  }).from(workOrders).where(eq(workOrders.id, workOrderId));
  if (!wo) return none("");
  if (wo.orgId === null) return none("the job has no client on it, so it has no lab to measure to");

  const [siteRows, instRows] = await Promise.all([
    db.select().from(orgSites)
      .where(and(eq(orgSites.orgId, wo.orgId), eq(orgSites.archived, false))),
    /* A system knows which building it is installed in; a bare asset does not
       carry a site of its own. So a job on an asset falls through to the
       client's sites, which is where the picker earns its keep. */
    wo.instrumentId === null ? Promise.resolve([]) : db.select({ siteId: instruments.siteId })
      .from(instruments).where(eq(instruments.id, wo.instrumentId)),
  ]);
  if (!siteRows.length) {
    return none("their client has no site on file, so there is no address to measure to");
  }

  /*
   * Place whatever can be placed before measuring: a site whose address never
   * geocoded, and the claimant's own origin. Both are one write each and then
   * never again, and both are the difference between a claim that rules itself
   * and one that waits for somebody to look at two records.
   */
  const who = await originOf(claimantEmail);
  for (const s of siteRows) await placeSite(s).catch(() => null);

  const routed = who.point
    ? await tripMilesFor(claimantEmail, siteRows.map((s) => s.id)).catch(() => [])
    : [];
  /* One live lab and no system to name it: that IS the job's site. Nobody
     should have to pick from a list of one. */
  const defaultSiteId = instRows[0]?.siteId ?? (siteRows.length === 1 ? siteRows[0].id : null);
  return {
    sites: siteRows.map((s) => {
      const hit = routed.find((r) => r.siteId === s.id);
      // The routed answer first; the site's own typed default second; then
      // null, which the rulebook reads as "somebody has to look at this".
      const miles = hit ? hit.miles : (s.onewayMiles > 0 ? s.onewayMiles : null);
      return {
        siteId: s.id,
        name: siteLabel(s),
        miles,
        estimated: hit?.estimated ?? false,
        // Whichever end is actually at fault. The origin first: with nowhere to
        // measure FROM, no site could have been measured to.
        why: miles !== null ? ""
          : who.why || (s.address.trim()
            ? `${siteLabel(s)} has an address but could not be placed on the map - re-save it, or type its one-way miles`
            : `${siteLabel(s)} has no address on file`),
      };
    }),
    // Only when that site is actually one of the live ones offered.
    defaultSiteId: siteRows.some((s) => s.id === defaultSiteId) ? defaultSiteId : null,
    why: who.why,
  };
}

/**
 * Where one person's trips start, and what stopped it when nothing does.
 *
 * Placing on the way: an address typed into a profile is a person saying where
 * they live, and the app failing to turn it into a pin is the app's problem to
 * retry rather than theirs to notice.
 */
async function originOf(email: string): Promise<{ point: LatLng | null; why: string }> {
  const [member] = await db.select().from(houseMembers)
    .where(eq(houseMembers.email, email.toLowerCase()));
  if (!member) return { point: null, why: `there is no staff record for ${email}` };
  const name = member.name || email;

  if (member.siteId !== null) {
    const [site] = await db.select().from(orgSites).where(eq(orgSites.id, member.siteId));
    if (!site) return { point: null, why: `${name}'s site location no longer exists - set it on their file` };
    const point = await placeSite(site).catch(() => null);
    if (point) return { point, why: "" };
    /* The commonest cause, and the one the old wording never mentioned: a
       staffed site is an OVERRIDE, so an engineer who works from home but has
       a client's building on their file is measured from that building - and
       from nowhere at all when it has no pin. */
    return {
      point: null,
      why: `${name}'s trips start from ${siteLabel(site)}, which has no map pin`
        + (member.homeAddress.trim() ? ` - set their site location to "Works from home" to measure from their own address instead` : ""),
    };
  }

  /* The pin first, then the address that could make one: somebody pinned on a
     map without ever typing an address still has a home base, and telling them
     they have none would be a lie about a record that works. */
  const point = await placeHome(member).catch(() => null);
  if (point) return { point, why: "" };
  return {
    point: null,
    why: member.homeAddress.trim()
      ? `${name}'s home address could not be placed on the map - check it reads as a real address`
      : `there is no home address on ${name}'s file`,
  };
}
