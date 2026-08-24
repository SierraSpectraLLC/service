// Where things are, and how far apart by road.
//
// Two providers, chosen by environment. With GOOGLE_MAPS_API_KEY set, Google
// answers both questions - paid, and carrying an SLA. Without it, the open
// stack answers: Nominatim (OpenStreetMap) geocodes and the public OSRM
// server routes. Both free services have usage policies this module respects
// by design rather than by restraint: geocoding happens once per saved
// address, routing once per (engineer, site) pair, and every answer is
// remembered - see drive_cache. Nothing here is called on a render path.
//
// Every function degrades instead of throwing: null means "the outside world
// did not answer", and the caller falls back - to the site's typed miles, or
// to a straight-line estimate wearing an honest label. A page that fails to
// load because a maps API sneezed would be a bad trade for a nicer number.

export type LatLng = { lat: number; lng: number };

const TIMEOUT_MS = 6000;

/** Contact address for the open providers' usage policies - identify or be blocked. */
const USER_AGENT = "ridgeline-service-portal (ops@ridgelinefield.com)";

const googleKey = () => process.env.GOOGLE_MAPS_API_KEY?.trim() || "";

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** An address becomes a point, or null when nobody could say where it is. */
export async function geocode(address: string): Promise<(LatLng & { label: string }) | null> {
  const q = address.trim().replace(/\s+/g, " ");
  if (!q) return null;
  if (googleKey()) {
    const data = await getJson(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${googleKey()}`,
    ) as { results?: { geometry?: { location?: { lat: number; lng: number } }; formatted_address?: string }[] } | null;
    const hit = data?.results?.[0];
    if (hit?.geometry?.location) {
      return { lat: hit.geometry.location.lat, lng: hit.geometry.location.lng, label: hit.formatted_address ?? q };
    }
    return null;
  }
  const data = await getJson(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`,
    { "User-Agent": USER_AGENT },
  ) as { lat: string; lon: string; display_name?: string }[] | null;
  const hit = data?.[0];
  if (!hit) return null;
  const lat = parseFloat(hit.lat), lng = parseFloat(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, label: hit.display_name ?? q };
}

/** Straight-line miles. Pure, and the floor every routed answer must beat. */
export function haversineMiles(a: LatLng, b: LatLng): number {
  const R = 3958.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Roads are not crow-flight. When the router cannot answer, the estimate is
 * the straight line times this - the standard planning circuity factor for
 * US road networks, and honest enough for a radius rule as long as the
 * answer SAYS it is an estimate, which is why drivingMiles returns the flag.
 */
export const ROAD_FACTOR = 1.3;

export type DrivenMiles = { miles: number; estimated: boolean };

/** Road miles between two points; an estimate (flagged) when no router answers. */
export async function drivingMiles(from: LatLng, to: LatLng): Promise<DrivenMiles> {
  if (googleKey()) {
    const data = await getJson(
      "https://maps.googleapis.com/maps/api/directions/json"
      + `?origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}&key=${googleKey()}`,
    ) as { routes?: { legs?: { distance?: { value: number } }[] }[] } | null;
    const meters = data?.routes?.[0]?.legs?.reduce((n, l) => n + (l.distance?.value ?? 0), 0);
    if (meters && meters > 0) return { miles: meters / 1609.344, estimated: false };
  } else {
    const data = await getJson(
      `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`,
    ) as { routes?: { distance: number }[] } | null;
    const meters = data?.routes?.[0]?.distance;
    if (meters && meters > 0) return { miles: meters / 1609.344, estimated: false };
  }
  return { miles: haversineMiles(from, to) * ROAD_FACTOR, estimated: true };
}

/** Has either end moved since this cached answer was computed? */
export const coordsMoved = (
  cached: { fromLat: number; fromLng: number; toLat: number; toLng: number },
  from: LatLng, to: LatLng,
): boolean =>
  Math.abs(cached.fromLat - from.lat) > 1e-6 || Math.abs(cached.fromLng - from.lng) > 1e-6
  || Math.abs(cached.toLat - to.lat) > 1e-6 || Math.abs(cached.toLng - to.lng) > 1e-6;
