// The one write in this application that crosses a workspace boundary.
//
// Accepting a shared client copies rows into the RECIPIENT's database, so the
// question these answer is: does everything land stamped to the recipient, and
// does anything at all still point at the sender? Real Postgres, in-process
// PGlite from the same drizzle/schema-sync.sql every deploy applies, because
// the guarantee is in the values actually written.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SHARE_VERSION, type SharePayload } from "@/lib/clientShare";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));

const { materialize } = await import("@/lib/clientShareData");
const { eq } = await import("drizzle-orm");

/** 3 = the sender's workspace, 4 = the recipient's. */
const PAYLOAD: SharePayload = {
  version: SHARE_VERSION,
  client: { name: "Emery Pharma", kind: "client" },
  sites: [
    { name: "Hayward", address: "2000 Sample Way", accessNotes: "Dock 4",
      contactName: "R. Diaz", contactPhone: "555-0100", contactEmail: "rd@emery.test" },
    { name: "Alameda", address: "15 Bay Farm Rd", accessNotes: "", contactName: "",
      contactPhone: "", contactEmail: "" },
  ],
  systems: [
    { sourceRef: "EP-001", model: "6495C", category: "LC-MS", siteName: "Hayward", location: "Lab 2",
      modules: [
        { kind: "Mass Spec", model: "6495C", serial: "SN7009", manufacturer: "Agilent" },
        { kind: "Pump", model: "nXDS15i", serial: "P409", manufacturer: "Edwards" },
      ] },
    { sourceRef: "EP-008", model: "ISQ 7000", category: "GC-MS", siteName: "Alameda", location: "",
      modules: [] },
  ],
  from: { operator: "Sierra Spectra", by: "joe@sierra.test", on: "2026-08-27" },
  note: "",
};

let made: { orgId: number; systems: number };

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES
      (3, 'Sierra Spectra', 'provider', true),
      (4, 'Northwest Instrument Services', 'provider', true);
    SELECT setval('orgs_id_seq', 100);
    -- The recipient already uses EP-001 for something of their own. The copy
    -- must not collide with it and must not rename theirs.
    INSERT INTO instruments (external_id, client, model, tenant_org_id)
      VALUES ('EP-001', 'Somebody else', 'LC-20', 4);
    -- And the SENDER already has a client called Emery Pharma, which is the
    -- whole point: it is the same company seen from two sides.
    INSERT INTO orgs (name, kind, parent_org_id) VALUES ('Emery Pharma', 'client', 3);
  `);
  made = await materialize({ payload: PAYLOAD, destTenantOrgId: 4, actor: "bill@nwis.test" });
});

describe("where the copy lands", () => {
  it("creates the client in the RECIPIENT's workspace, not the sender's", async () => {
    const [org] = await testDb.select().from(schema.orgs).where(eq(schema.orgs.id, made.orgId));
    expect(org.name).toBe("Emery Pharma");
    expect(org.kind).toBe("client");
    // Parented to the recipient: that is what makes it their client, in their
    // org list, administrable by them.
    expect(org.parentOrgId).toBe(4);
  });

  it("does not collide with the sender's client of the same name", async () => {
    /*
     * org names used to be UNIQUE across the whole instance, so the second
     * service company servicing the same lab could not have it at all - the
     * insert threw. Two workspaces both having a client called Emery Pharma is
     * not a collision; it is the same company, seen from two sides.
     */
    const both = (await testDb.select().from(schema.orgs))
      .filter((o) => o.name === "Emery Pharma");
    expect(both).toHaveLength(2);
    expect(both.map((o) => o.parentOrgId).sort()).toEqual([3, 4]);
  });

  it("stamps every row with the recipient's tenant", async () => {
    const systems = await testDb.select().from(schema.instruments)
      .where(eq(schema.instruments.ownerOrgId, made.orgId));
    expect(systems).toHaveLength(2);
    expect(systems.every((s) => s.tenantOrgId === 4)).toBe(true);

    const sites = await testDb.select().from(schema.orgSites)
      .where(eq(schema.orgSites.orgId, made.orgId));
    expect(sites).toHaveLength(2);
    expect(sites.every((s) => s.tenantOrgId === 4)).toBe(true);

    const ids = systems.map((s) => s.id);
    const mods = (await testDb.select().from(schema.assets))
      .filter((a) => a.instrumentId !== null && ids.includes(a.instrumentId));
    expect(mods).toHaveLength(2);
    expect(mods.every((a) => a.tenantOrgId === 4)).toBe(true);
  });

  it("leaves the sender's own records completely alone", async () => {
    const senders = await testDb.select().from(schema.instruments)
      .where(eq(schema.instruments.tenantOrgId, 3));
    expect(senders).toHaveLength(0);
  });
});

describe("their shelf, their labels", () => {
  it("does not take a tag the recipient already uses", async () => {
    /*
     * instruments.external_id is unique across the whole table. Imposing the
     * sender's tag would throw here - and even where it worked it would be
     * putting one shop's sticker on another shop's machine.
     */
    const [theirs] = await testDb.select().from(schema.instruments)
      .where(eq(schema.instruments.client, "Somebody else"));
    expect(theirs.externalId).toBe("EP-001");   // untouched

    const copies = await testDb.select().from(schema.instruments)
      .where(eq(schema.instruments.ownerOrgId, made.orgId));
    expect(copies.map((c) => c.externalId).sort()).toEqual(["EP-001-2", "EP-008"]);
  });

  it("records the sender's tag as a cross-reference, so both shops can name the same machine", async () => {
    const copies = await testDb.select().from(schema.instruments)
      .where(eq(schema.instruments.ownerOrgId, made.orgId));
    const byRef = new Map(copies.map((c) => [c.sourceRef, c.externalId]));
    expect(byRef.get("EP-001")).toBe("EP-001-2");
    expect(byRef.get("EP-008")).toBe("EP-008");
  });

  it("writes where the copy came from onto the record itself", async () => {
    const [one] = await testDb.select().from(schema.instruments)
      .where(eq(schema.instruments.sourceRef, "EP-001"));
    expect(one.notes).toContain("Sierra Spectra");
    expect(one.notes).toContain("does not update");
  });
});

describe("what arrived", () => {
  it("hangs each system on the right building", async () => {
    const sites = await testDb.select().from(schema.orgSites)
      .where(eq(schema.orgSites.orgId, made.orgId));
    const hayward = sites.find((s) => s.name === "Hayward")!;
    const [ep1] = await testDb.select().from(schema.instruments)
      .where(eq(schema.instruments.sourceRef, "EP-001"));
    expect(ep1.siteId).toBe(hayward.id);
    expect(hayward.address).toBe("2000 Sample Way");
    // They have to physically get in, so how to do that travels.
    expect(hayward.accessNotes).toBe("Dock 4");
  });

  it("brings the modules with their models and serials", async () => {
    const [ep1] = await testDb.select().from(schema.instruments)
      .where(eq(schema.instruments.sourceRef, "EP-001"));
    const mods = (await testDb.select().from(schema.assets))
      .filter((a) => a.instrumentId === ep1.id)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    expect(mods.map((m) => `${m.kind}/${m.model}/${m.serial}`))
      .toEqual(["Mass Spec/6495C/SN7009", "Pump/nXDS15i/P409"]);
  });

  it("reports what it did", () => {
    expect(made.systems).toBe(2);
  });
});
