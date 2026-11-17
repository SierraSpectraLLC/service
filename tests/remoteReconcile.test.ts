// The device list is a cache of the support host's, refreshed on every page
// load. Two things followed from that and were learned from a client's roster:
// a row deleted here alone was back on the next load (so removal now goes to
// the host first, which this cannot exercise without one), and a machine moved
// between device groups on the host stayed filed under its old organization
// here. These test the refresh itself: what it adds, what it follows, and what
// it leaves alone.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });

vi.mock("@/db", () => ({ db: testDb }));

const { reconcileOrgDevices } = await import("@/lib/remote");
const { remoteDevices } = schema;

const SIERRA = 3, LABZEN = 7, ALTIS = 8;

const rows = () => testDb.select().from(remoteDevices).orderBy(remoteDevices.id);

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator, parent_org_id) VALUES
      (${SIERRA}, 'Sierra Spectra', 'provider', true, NULL),
      (${LABZEN}, 'LabZen', 'client', false, ${SIERRA}),
      (${ALTIS}, 'Altis Labs', 'client', false, ${SIERRA});
    SELECT setval('orgs_id_seq', 100);
  `);
});

beforeEach(async () => {
  await testDb.delete(remoteDevices);
});

describe("reconcileOrgDevices", () => {
  it("adds a machine the host lists and the portal has never seen, under the host's organization", async () => {
    await reconcileOrgDevices(LABZEN, [{ nodeId: "node//abc", name: "DESKTOP-V6QOFMV", online: true, platform: "Windows 10" }]);
    const [d] = await rows();
    expect(d).toMatchObject({ orgId: LABZEN, tenantOrgId: SIERRA, nodeId: "node//abc", name: "DESKTOP-V6QOFMV", enrolledBy: "the agent installer" });
    expect(d.lastSeenAt).not.toBeNull();
  });

  it("does not make a second row for a node it already has, however often the page loads", async () => {
    const live = [{ nodeId: "node//abc", name: "DESKTOP-V6QOFMV", online: false, platform: "Windows 10" }];
    await reconcileOrgDevices(LABZEN, live);
    await reconcileOrgDevices(LABZEN, live);
    await reconcileOrgDevices(LABZEN, live);
    expect(await rows()).toHaveLength(1);
  });

  it("follows a machine the host has moved to another organization's group", async () => {
    await reconcileOrgDevices(LABZEN, [{ nodeId: "node//abc", name: "PC", online: false, platform: "w" }]);
    const [before] = await rows();
    await testDb.update(remoteDevices).set({ nickname: "Altis PC", consentOverride: true }).where(eq(remoteDevices.id, before.id));

    await reconcileOrgDevices(ALTIS, [{ nodeId: "node//abc", name: "PC", online: false, platform: "w" }]);

    const all = await rows();
    expect(all).toHaveLength(1);
    // Same row, so the name and the consent rule somebody set on it survive.
    expect(all[0]).toMatchObject({ id: before.id, orgId: ALTIS, tenantOrgId: SIERRA, nickname: "Altis PC", consentOverride: true });
  });

  it("claims a machine that enrolled before anyone assigned it", async () => {
    await testDb.insert(remoteDevices).values({ tenantOrgId: SIERRA, orgId: null, nodeId: "node//orphan", name: "PC" });
    await reconcileOrgDevices(LABZEN, [{ nodeId: "node//orphan", name: "PC", online: false, platform: "w" }]);
    const [d] = await rows();
    expect(d.orgId).toBe(LABZEN);
  });

  it("refreshes the hostname and last-seen only from a machine that is online", async () => {
    await testDb.insert(remoteDevices).values({ tenantOrgId: SIERRA, orgId: LABZEN, nodeId: "node//abc", name: "OLD-NAME" });
    await reconcileOrgDevices(LABZEN, [{ nodeId: "node//abc", name: "NEW-NAME", online: false, platform: "w" }]);
    expect((await rows())[0]).toMatchObject({ name: "OLD-NAME", lastSeenAt: null });

    await reconcileOrgDevices(LABZEN, [{ nodeId: "node//abc", name: "NEW-NAME", online: true, platform: "w" }]);
    const [d] = await rows();
    expect(d.name).toBe("NEW-NAME");
    expect(d.lastSeenAt).not.toBeNull();
  });

  it("leaves a machine the host no longer lists exactly as it was", async () => {
    // Removal is a decision somebody makes, with a reason - not a side effect
    // of a list that happened to come back short.
    await testDb.insert(remoteDevices).values({ tenantOrgId: SIERRA, orgId: LABZEN, nodeId: "node//gone", name: "PC" });
    await reconcileOrgDevices(LABZEN, []);
    await reconcileOrgDevices(LABZEN, [{ nodeId: "node//other", name: "PC2", online: true, platform: "w" }]);
    expect((await rows()).map((d) => d.nodeId)).toEqual(["node//gone", "node//other"]);
  });
});
