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
  pms: [
    { sourceRef: "EP-001", title: "Annual PM", everyDays: 365, nextDue: "2026-11-02", lastDone: "2025-11-02" },
    // On the Edwards pump, which is module 1 of EP-001.
    { sourceRef: "EP-001", moduleIndex: 1, title: "Rough pump oil change", everyDays: 180,
      nextDue: "2026-10-01", lastDone: "" },
    // Already overdue at the sender, and it has to still be overdue here.
    { sourceRef: "EP-008", title: "Source clean", everyDays: 90, nextDue: "2026-06-14", lastDone: "2026-03-16" },
    // Points at a machine the payload does not carry. It must be dropped, not
    // landed on nothing - see the test below.
    { sourceRef: "EP-999", title: "Orphan", everyDays: 30, nextDue: "2026-09-01", lastDone: "" },
  ],
  parts: [
    { sourceRef: "EP-001", name: "Roughing pump oil", partNumber: "6040-0855", qty: "2", installedAt: "2026-03-04" },
    { sourceRef: "EP-001", name: "Calibrant vial", partNumber: "G1969-85000", qty: "1", installedAt: "2025-12-11" },
  ],
  refs: [
    { assetType: "Mass Spec", model: "6495C", kind: "note", title: "Rebuild the roughing pump",
      url: "/api/files/91", body: "Pull the left panel first." },
    // The recipient already files this one under the same type, model and
    // title. It must not land twice.
    { assetType: "Pump", model: "nXDS15i", kind: "link", title: "Edwards manual",
      url: "https://example.test/nxds", body: "" },
  ],
  pricing: {
    years: [{ year: "2025", billedCents: 4800000, visits: 11 }],
    laborRateCents: 19500,
    note: "",
  },
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
    -- The recipient's own library already covers the Edwards pump. A hand-off
    -- should not fill somebody's catalog with a second copy of what they wrote.
    INSERT INTO catalog_refs (tenant_org_id, asset_type, model, kind, title, provenance)
      VALUES (4, 'Pump', 'nXDS15i', 'link', 'Edwards manual', 'original');
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

/*
 * THE RECORD, which is the half that makes a hand-off worth accepting.
 *
 * The equipment is what the offer looks like; the maintenance rhythm, what the
 * fleet consumes and the paper behind it are what the buyer is actually
 * getting. The hand-off page advertises these by count, so every one of them
 * has to arrive - a page that promises four schedules and delivers none is a
 * bait-and-switch at the exact moment somebody converts.
 */
describe("the record that comes with it", () => {
  const copies = async () => testDb.select().from(schema.instruments)
    .where(eq(schema.instruments.ownerOrgId, made.orgId));

  it("lands the maintenance schedules live and stamped to the recipient", async () => {
    const ids = (await copies()).map((c) => c.id);
    const pms = (await testDb.select().from(schema.pmSchedules))
      .filter((r) => r.instrumentId !== null && ids.includes(r.instrumentId));
    expect(pms).toHaveLength(3);
    expect(pms.every((r) => r.tenantOrgId === 4)).toBe(true);
    // Not paused. A schedule that arrived paused would be a list of jobs
    // nobody is ever told about, which is worse than not sending it.
    expect(pms.every((r) => !r.paused)).toBe(true);
  });

  it("keeps a schedule overdue instead of resetting the clock to look tidy", async () => {
    const [ep8] = await testDb.select().from(schema.instruments)
      .where(eq(schema.instruments.sourceRef, "EP-008"));
    const [pm] = (await testDb.select().from(schema.pmSchedules))
      .filter((r) => r.instrumentId === ep8.id);
    expect(pm.nextDue).toBe("2026-06-14");
    expect(pm.lastDone).toBe("2026-03-16");
    expect(pm.everyDays).toBe(90);
  });

  it("puts a module's schedule back on the module", async () => {
    /*
     * A pump oil change belongs to the pump. It arrives carrying the module's
     * POSITION - materialize writes modules in payload order, so index 1 is
     * the second one it inserted - and lands with BOTH ids set, which is the
     * shape a module schedule tagged from a system page has: on the module's
     * list, and on the system's.
     */
    const [ep1] = await testDb.select().from(schema.instruments)
      .where(eq(schema.instruments.sourceRef, "EP-001"));
    const [pump] = (await testDb.select().from(schema.assets))
      .filter((a) => a.instrumentId === ep1.id && a.kind === "Pump");
    const [pm] = (await testDb.select().from(schema.pmSchedules))
      .filter((r) => r.title === "Rough pump oil change");
    expect(pm.assetId).toBe(pump.id);
    expect(pm.instrumentId).toBe(ep1.id);
    // And a system's own schedule did not acquire one.
    const [annual] = (await testDb.select().from(schema.pmSchedules))
      .filter((r) => r.title === "Annual PM");
    expect(annual.assetId).toBeNull();
  });

  it("drops a row pointing at a machine that did not travel", async () => {
    /*
     * The sender chose which systems to hand over; a schedule hanging off one
     * they kept has nothing to hang on here. Dropped rather than landed with a
     * null instrument, because a maintenance schedule attached to no machine
     * is a job nobody can ever do.
     */
    const all = await testDb.select().from(schema.pmSchedules);
    expect(all.some((r) => r.title === "Orphan")).toBe(false);
    expect(all.every((r) => r.instrumentId !== null)).toBe(true);
  });

  it("lands the parts history as history, with no money on it", async () => {
    const [ep1] = await testDb.select().from(schema.instruments)
      .where(eq(schema.instruments.sourceRef, "EP-001"));
    const fitted = (await testDb.select().from(schema.parts))
      .filter((r) => r.instrumentId === ep1.id);
    expect(fitted).toHaveLength(2);
    expect(fitted.every((r) => r.status === "Installed")).toBe(true);
    expect(fitted.map((r) => r.installedAt).sort()).toEqual(["2025-12-11", "2026-03-04"]);
    /*
     * No cost crossed, so none is written. A blank reads as "we do not know
     * what this cost", which is the truth - a zero would read as free.
     */
    expect(fitted.every((r) => r.cost === "" && r.costCents === null)).toBe(true);
  });

  it("adds the references it is entitled to and skips the one they already have", async () => {
    const refs = await testDb.select().from(schema.catalogRefs)
      .where(eq(schema.catalogRefs.tenantOrgId, 4));
    expect(refs).toHaveLength(2);
    const fresh = refs.find((r) => r.title === "Rebuild the roughing pump")!;
    expect(fresh.body).toBe("Pull the left panel first.");
    expect(fresh.createdBy).toContain("Sierra Spectra");
    /*
     * UNREVIEWED, whatever the sender asserted. Provenance is a claim about
     * who owns the words; the sender answered whether THEY could pass it on,
     * and nobody has decided whether this shop may license it out again. ''
     * keeps it out of anything licensed until a person says otherwise - see
     * lib/provenance.
     */
    expect(fresh.provenance).toBe("");
    // Theirs is untouched, and there is exactly one of it.
    expect(refs.filter((r) => r.title === "Edwards manual")).toHaveLength(1);
    expect(refs.find((r) => r.title === "Edwards manual")!.provenance).toBe("original");
  });

  it("writes no money row of any kind", async () => {
    /*
     * The payload carries a billing SUMMARY so the buyer can price the work -
     * see SharedPricing - and it stops at being read. It becomes no invoice,
     * no agreement and no line item in the recipient's ledger, because those
     * would be records of transactions that never happened here.
     */
    expect(await testDb.select().from(schema.invoices)).toHaveLength(0);
    expect(await testDb.select().from(schema.agreements)).toHaveLength(0);
  });
});
