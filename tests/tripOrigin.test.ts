// Where a trip starts, and what to say when nobody can tell.
//
// A per diem rules itself from two points: where the engineer's day starts and
// where the lab is. Both are addresses somebody typed, and both are turned
// into map pins WHEN THEY ARE SAVED - so an address saved while the geocoder
// was unreachable keeps a pin-less record for ever, and every claim against it
// waits for a human months after the hiccup that caused it.
//
// Two things are pinned here. That the app places what it can at the moment it
// needs it, and writes the pin back so it is retried once rather than always.
// And that when it still cannot measure, it names the end that failed - the
// old either/or sent a reviewer to check two records, neither of which was
// necessarily the one at fault, and never mentioned the commonest cause: an
// engineer who works from home with a client's building on their file.
//
// Real Postgres, in-process, from the same DDL every deploy applies.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");
const { eq } = await import("drizzle-orm");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));

/** The outside world, in a jar: these addresses place, anything else does not. */
const PLACES: Record<string, { lat: number; lng: number }> = {
  "902 Meadowhawk Drive, Vacaville, CA 95687": { lat: 38.3566, lng: -121.9877 },
  "513 Parnassus Ave., Rm S907, San Francisco, CA 94143": { lat: 37.7632, lng: -122.4576 },
};
vi.mock("@/lib/geo", () => ({
  geocode: async (address: string) => {
    const hit = PLACES[address.trim()];
    return hit ? { ...hit, label: address } : null;
  },
  drivingMiles: async () => ({ miles: 62.4, estimated: false }),
  coordsMoved: () => false,
}));

const SIERRA = 1, UCSF = 2, LABZEN = 3;
const HAL = 1, LABZEN_HQ = 2;
const SLOW = 30_000;
const BILL = "wjharner@sierraspectra.com";

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator, parent_org_id) VALUES
      (${SIERRA}, 'Sierra Spectra', 'provider', true,  NULL),
      (${UCSF},   'UCSF',           'client',   false, ${SIERRA}),
      (${LABZEN}, 'LabZen',         'client',   false, ${SIERRA});
    INSERT INTO app_settings (id, operator_org_id) VALUES (1, ${SIERRA});

    -- Both labs have an address typed. Neither was ever placed on the map.
    INSERT INTO org_sites (id, tenant_org_id, org_id, name, address) VALUES
      (${HAL}, ${SIERRA}, ${UCSF}, 'HAL Primary Lab',
       '513 Parnassus Ave., Rm S907, San Francisco, CA 94143'),
      (${LABZEN_HQ}, ${SIERRA}, ${LABZEN}, 'LabZen HQ', 'Somewhere nobody can find');

    INSERT INTO instruments (id, tenant_org_id, external_id, client, model, owner_org_id, site_id) VALUES
      (1, ${SIERRA}, 'Q-ULT', 'UCSF', 'Ultima', ${UCSF}, ${HAL});

    INSERT INTO work_orders (id, tenant_org_id, number, instrument_id, org_id, title, opened_on) VALUES
      (1, ${SIERRA}, '030305_W1', 1, ${UCSF}, 'E2M18 High-Pitched Sound', '2026-09-14');
  `);
});

/** Bill as his file reads: working from home, address typed, never placed. */
beforeEach(async () => {
  await client.exec(`
    DELETE FROM drive_cache; DELETE FROM house_members;
    UPDATE org_sites SET lat = NULL, lng = NULL, oneway_miles = 0;
    INSERT INTO house_members (email, org_id, role, name, home_address) VALUES
      ('${BILL}', ${SIERRA}, 'staff', 'Bill Harner', '902 Meadowhawk Drive, Vacaville, CA 95687');
  `);
});

describe("placing what was never placed", () => {
  it("pins the lab and the engineer's home on the way to the answer, and keeps them", async () => {
    const { workOrderTrip } = await import("@/lib/tripMiles");
    const trip = await workOrderTrip(BILL, 1);

    const hal = trip.sites.find((s) => s.siteId === HAL);
    expect(trip.why).toBe("");
    expect(hal?.miles).toBe(62);
    expect(hal?.why).toBe("");

    // Written back, so the next claim asks nobody.
    const [site] = await testDb.select().from(schema.orgSites).where(eq(schema.orgSites.id, HAL));
    expect(site.lat).toBeCloseTo(37.7632, 3);
    const [member] = await testDb.select().from(schema.houseMembers);
    expect(member.homeLat).toBeCloseTo(38.3566, 3);
  }, SLOW);

  it("uses a typed one-way distance without asking any map at all", async () => {
    await client.exec(`
      UPDATE org_sites SET oneway_miles = 4 WHERE id = ${HAL};
      UPDATE house_members SET home_address = '' WHERE email = '${BILL}';
    `);
    const { workOrderTrip } = await import("@/lib/tripMiles");
    const trip = await workOrderTrip(BILL, 1);
    expect(trip.sites.find((s) => s.siteId === HAL)?.miles).toBe(4);
  }, SLOW);
});

describe("naming the end that failed", () => {
  it("says so when a staffed site is the origin and has no pin", async () => {
    // The commonest cause and the one nobody was told about: a site location
    // is an OVERRIDE, so an engineer who works from home but has a client's
    // building on their file is measured from that building.
    await client.exec(`UPDATE house_members SET site_id = ${LABZEN_HQ} WHERE email = '${BILL}';`);
    const { workOrderTrip } = await import("@/lib/tripMiles");
    const trip = await workOrderTrip(BILL, 1);

    expect(trip.why).toContain("Bill Harner's trips start from LabZen HQ");
    expect(trip.why).toContain("no map pin");
    // And it points at the fix, because his own address is right there.
    expect(trip.why).toContain("Works from home");
    expect(trip.sites.find((s) => s.siteId === HAL)?.miles).toBeNull();
    expect(trip.sites.find((s) => s.siteId === HAL)?.why).toBe(trip.why);
  }, SLOW);

  it("says so when there is no home address at all", async () => {
    await client.exec(`UPDATE house_members SET home_address = '' WHERE email = '${BILL}';`);
    const { workOrderTrip } = await import("@/lib/tripMiles");
    const trip = await workOrderTrip(BILL, 1);
    expect(trip.why).toBe("there is no home address on Bill Harner's file");
  }, SLOW);

  it("says so when the home address cannot be placed", async () => {
    await client.exec(`UPDATE house_members SET home_address = 'Somewhere nobody can find' WHERE email = '${BILL}';`);
    const { workOrderTrip } = await import("@/lib/tripMiles");
    const trip = await workOrderTrip(BILL, 1);
    expect(trip.why).toContain("could not be placed on the map");
  }, SLOW);

  it("blames the lab when the engineer is placeable and the lab is not", async () => {
    await client.exec(`UPDATE org_sites SET address = 'Somewhere nobody can find' WHERE id = ${HAL};`);
    const { workOrderTrip } = await import("@/lib/tripMiles");
    const trip = await workOrderTrip(BILL, 1);

    expect(trip.why).toBe("");                       // his end is fine
    const hal = trip.sites.find((s) => s.siteId === HAL);
    expect(hal?.miles).toBeNull();
    expect(hal?.why).toContain("HAL Primary Lab has an address but could not be placed");
    expect(hal?.why).toContain("type its one-way miles");

    await client.exec(`UPDATE org_sites SET address = '513 Parnassus Ave., Rm S907, San Francisco, CA 94143' WHERE id = ${HAL};`);
  }, SLOW);

  it("says a client with no site on file has nothing to measure to", async () => {
    await client.exec(`
      INSERT INTO work_orders (id, tenant_org_id, number, org_id, title, opened_on) VALUES
        (2, ${SIERRA}, '030306_W1', ${LABZEN}, 'Nothing on file', '2026-09-14');
      UPDATE org_sites SET archived = true WHERE id = ${LABZEN_HQ};
    `);
    const { workOrderTrip } = await import("@/lib/tripMiles");
    const trip = await workOrderTrip(BILL, 2);
    expect(trip.why).toContain("no site on file");
    await client.exec(`UPDATE org_sites SET archived = false WHERE id = ${LABZEN_HQ}; DELETE FROM work_orders WHERE id = 2;`);
  }, SLOW);
});
