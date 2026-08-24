import { describe, expect, it } from "vitest";
import { ROAD_FACTOR, coordsMoved, directionsUrl, haversineMiles } from "@/lib/geo";

/**
 * The pure floor under the routing stack. The providers are network and are
 * not tested here; what is tested is the math every routed answer is checked
 * against, the estimate used when no router answers, and the cache
 * invalidation - the part where a silent mistake would pin an engineer's
 * mileage to a house they moved out of.
 */
const RENO = { lat: 39.5296, lng: -119.8138 };
const SACRAMENTO = { lat: 38.5816, lng: -121.4944 };
const RICHMOND = { lat: 37.9358, lng: -122.3477 };

describe("straight-line miles", () => {
  it("gets known city pairs right within a percent", () => {
    // Reno to Sacramento is ~111 mi great-circle (the flat-plane check:
    // 0.95 degrees of latitude and 1.68 of longitude at 39 N come to ~112).
    expect(haversineMiles(RENO, SACRAMENTO)).toBeGreaterThan(108);
    expect(haversineMiles(RENO, SACRAMENTO)).toBeLessThan(115);
  });

  it("is symmetric and zero at home", () => {
    expect(haversineMiles(RENO, RICHMOND)).toBeCloseTo(haversineMiles(RICHMOND, RENO), 6);
    expect(haversineMiles(RENO, RENO)).toBe(0);
  });
});

describe("the road factor", () => {
  it("inflates, mildly - roads wander, they do not triple", () => {
    expect(ROAD_FACTOR).toBeGreaterThan(1);
    expect(ROAD_FACTOR).toBeLessThan(1.6);
  });
});

describe("when a cached distance stops being true", () => {
  const cached = { fromLat: RENO.lat, fromLng: RENO.lng, toLat: RICHMOND.lat, toLng: RICHMOND.lng };

  it("stands while both ends stand", () => {
    expect(coordsMoved(cached, RENO, RICHMOND)).toBe(false);
  });

  it("falls when either end moves - a new home, a re-pinned site", () => {
    expect(coordsMoved(cached, SACRAMENTO, RICHMOND)).toBe(true);
    expect(coordsMoved(cached, RENO, SACRAMENTO)).toBe(true);
  });

  it("ignores float dust, which is not a house move", () => {
    expect(coordsMoved(cached, { lat: RENO.lat + 1e-9, lng: RENO.lng }, RICHMOND)).toBe(false);
  });
});

describe("the directions link", () => {
  it("is the keyless universal URL - opens the Maps app on a phone", () => {
    expect(directionsUrl("1400 Harbor Way, Richmond, CA 94804"))
      .toBe("https://www.google.com/maps/dir/?api=1&destination=1400%20Harbor%20Way%2C%20Richmond%2C%20CA%2094804");
  });

  it("takes coordinates when that is what the record has", () => {
    expect(directionsUrl({ lat: 37.912, lng: -122.356 }))
      .toContain("destination=37.912%2C-122.356");
  });

  it("collapses the whitespace a pasted address drags along", () => {
    expect(directionsUrl("  1400  Harbor Way\n Richmond ")).not.toMatch(/%0A|%20%20/);
  });
});
