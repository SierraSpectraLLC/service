// The person file and perks, through the real actions.
//
// What these hold down is WHO. A wage and a stipend are the two numbers a
// company least wants crossing a workspace boundary, and the profile carries
// somebody's home address - so every write here is tested from four seats:
// the owner, HR, plain staff, and another company's owner.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });

type Who = {
  email: string; name: string; role: string;
  orgId: number | null; operatorOrgId: number | null; rootOperatorOrgId: number | null;
} | null;
let who: Who = null;

vi.mock("@/db", () => ({ db: testDb }));
vi.mock("@/auth", () => ({ auth: async () => (who ? { user: who } : null) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));
// The profile save geocodes a changed address; the test network does not.
vi.mock("@/lib/geo", () => ({
  geocode: async () => ({ lat: 37.5, lng: -122.0, label: "somewhere" }),
  drivingRoute: async () => null,
}));

/** 3 = Sierra Spectra (root operator), 5 = Cascade, a second operator. */
const OWNER: Who = {
  email: "joe@sierra.test", name: "Joe", role: "owner",
  orgId: null, operatorOrgId: 3, rootOperatorOrgId: 3,
};
const HR: Who = {
  email: "pat@sierra.test", name: "Pat", role: "staff",
  orgId: null, operatorOrgId: 3, rootOperatorOrgId: 3,
};
const STAFF: Who = {
  email: "bill@sierra.test", name: "Bill", role: "staff",
  orgId: null, operatorOrgId: 3, rootOperatorOrgId: 3,
};
const OTHER_OWNER: Who = {
  email: "cass@cascade.test", name: "Cass", role: "owner",
  orgId: null, operatorOrgId: 5, rootOperatorOrgId: 3,
};

const RESET = `
  DELETE FROM perks; DELETE FROM payroll; DELETE FROM drive_cache;
  UPDATE house_members SET home_address = '', phone = '', emergency_name = '',
    emergency_phone = '', started_on = '', home_lat = NULL, home_lng = NULL, site_id = NULL;
  UPDATE users SET site_id = NULL;
`;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES
      (3, 'Sierra Spectra', 'provider', true),
      (5, 'Cascade Analytical', 'provider', true),
      (7, 'LabZen', 'client', false);
    SELECT setval('orgs_id_seq', 100);
    -- Where somebody can be stationed: Sierra's own shop (never geocoded), a
    -- lab of Sierra's client, and a site of the other operator's.
    INSERT INTO org_sites (id, tenant_org_id, org_id, name, address, lat, lng) VALUES
      (11, 3, 3, 'Reno shop', '1 Yard Way, Reno NV', NULL, NULL),
      (12, 3, 7, 'LabZen HQ', '780 Chadbourne Rd, Fairfield CA', 38.2, -122.1),
      (13, 5, 5, 'Cascade yard', '9 Elsewhere Rd', 45.0, -120.0);
    SELECT setval('org_sites_id_seq', 100);
    INSERT INTO house_members (email, org_id, role, name, can_admin_people) VALUES
      ('joe@sierra.test',  3, 'owner', 'Joe',  false),
      ('pat@sierra.test',  3, 'staff', 'Pat',  true),
      ('bill@sierra.test', 3, 'staff', 'Bill', false),
      ('cass@cascade.test', 5, 'owner', 'Cass', false);
  `);
});

beforeEach(async () => { who = null; await client.exec(RESET); });

const PROFILE = {
  name: "Bill Harner", title: "Field service engineer",
  homeAddress: "12 Foothill Rd, Reno NV 89509", phone: "555-0155",
  emergencyName: "R. Reyes", emergencyPhone: "555-0156", startedOn: "2024-05-01",
};
const bill = async () => (await testDb.select().from(schema.houseMembers))
  .find((m) => m.email === "bill@sierra.test")!;

describe("the person file", () => {
  it("lets HR write a colleague's file, geocoding the address", async () => {
    who = HR;
    const { saveMemberProfile } = await import("@/app/actions");
    const res = await saveMemberProfile("bill@sierra.test", PROFILE);
    expect(res.error).toBeUndefined();
    expect(res.geocoded).toBe(true);
    const m = await bill();
    expect(m.homeAddress).toContain("Foothill");
    expect(m.homeLat).toBe(37.5);
    expect(m.phone).toBe("555-0155");
    expect(m.emergencyName).toBe("R. Reyes");
    expect(m.startedOn).toBe("2024-05-01");
  });

  it("puts the title on the account row and the name on the roster, and keeps a name nobody typed", async () => {
    who = HR;
    const { saveMemberProfile } = await import("@/app/actions");
    const { eq } = await import("drizzle-orm");
    await saveMemberProfile("bill@sierra.test", PROFILE);
    expect((await bill()).name).toBe("Bill Harner");
    // No account yet - they have never signed in - so the title makes one, the
    // way updatePersonProfile does for a client contact, and their first
    // sign-in finds it by address.
    const [account] = await testDb.select().from(schema.users).where(eq(schema.users.email, "bill@sierra.test"));
    expect(account?.title).toBe("Field service engineer");
    // A blank name is not an edit: reports are keyed on the name, so clearing
    // it by accident would orphan their claims rather than rename them.
    await saveMemberProfile("bill@sierra.test", { ...PROFILE, name: "  ", title: "" });
    expect((await bill()).name).toBe("Bill Harner");
    const [again] = await testDb.select().from(schema.users).where(eq(schema.users.email, "bill@sierra.test"));
    expect(again?.title).toBe("");
  });

  it("lets the owner too, and nobody else on staff", async () => {
    who = OWNER;
    const { saveMemberProfile } = await import("@/app/actions");
    expect((await saveMemberProfile("bill@sierra.test", PROFILE)).error).toBeUndefined();
    who = STAFF;
    expect((await saveMemberProfile("joe@sierra.test", PROFILE)).error).toBe("Not found");
  });

  it("never reaches across workspaces, and says nothing about why", async () => {
    // "Not found" for a missing person and another company's person alike -
    // whether Sierra employs this address is not a fact to confirm by the
    // shape of a refusal.
    who = OTHER_OWNER;
    const { saveMemberProfile } = await import("@/app/actions");
    expect((await saveMemberProfile("bill@sierra.test", PROFILE)).error).toBe("Not found");
    expect((await bill()).phone).toBe("");
  });

  it("stations them at one of our sites or a client lab, and keeps the home as the home", async () => {
    who = HR;
    const { saveMemberProfile } = await import("@/app/actions");
    const { eq } = await import("drizzle-orm");
    const account = async () => (await testDb.select().from(schema.users)
      .where(eq(schema.users.email, "bill@sierra.test")))[0];
    // Our own shop: the account row's "which of their organization's sites"
    // follows, because it is one of theirs.
    expect((await saveMemberProfile("bill@sierra.test", { ...PROFILE, siteId: 11 })).error).toBeUndefined();
    expect((await bill()).siteId).toBe(11);
    expect((await account())?.siteId).toBe(11);
    // A client's lab: the file says so, the home stays the home, and the
    // account row does not call a client's lab one of ours.
    expect((await saveMemberProfile("bill@sierra.test", { ...PROFILE, siteId: 12 })).error).toBeUndefined();
    expect((await bill()).siteId).toBe(12);
    expect((await bill()).homeAddress).toContain("Foothill");
    expect((await account())?.siteId).toBeNull();
    // Back to the front door.
    expect((await saveMemberProfile("bill@sierra.test", { ...PROFILE, siteId: null })).error).toBeUndefined();
    expect((await bill()).siteId).toBeNull();
  });

  it("refuses another operator's site, and leaves the station alone when the caller says nothing about it", async () => {
    who = HR;
    const { saveMemberProfile } = await import("@/app/actions");
    expect((await saveMemberProfile("bill@sierra.test", { ...PROFILE, siteId: 13 })).error).toMatch(/not one of your company/);
    expect((await bill()).siteId).toBeNull();
    await saveMemberProfile("bill@sierra.test", { ...PROFILE, siteId: 11 });
    // A phone fix from a form that knows nothing about sites must not un-station them.
    await saveMemberProfile("bill@sierra.test", { ...PROFILE, phone: "555-0001" });
    expect((await bill()).siteId).toBe(11);
  });

  it("starts their trips from the site location when they have one, else from home", async () => {
    who = HR;
    const { saveMemberProfile } = await import("@/app/actions");
    const { tripOrigin } = await import("@/lib/tripMiles");
    await saveMemberProfile("bill@sierra.test", PROFILE);
    expect(await tripOrigin(await bill())).toEqual({ lat: 37.5, lng: -122.0 });
    await saveMemberProfile("bill@sierra.test", { ...PROFILE, siteId: 12 });
    expect(await tripOrigin(await bill())).toEqual({ lat: 38.2, lng: -122.1 });
    // A site that never geocoded is still where they start - not their home,
    // which would price every trip off the wrong doorstep.
    await saveMemberProfile("bill@sierra.test", { ...PROFILE, siteId: 11 });
    expect(await tripOrigin(await bill())).toBeNull();
  });

  it("does not re-geocode an address nobody touched", async () => {
    who = HR;
    const { saveMemberProfile } = await import("@/app/actions");
    await saveMemberProfile("bill@sierra.test", PROFILE);
    // Break the pin by hand, then save a phone change with the same address:
    // the pin must survive, because the address did not change.
    await testDb.update(schema.houseMembers).set({ homeLat: 99 })
      .where((await import("drizzle-orm")).eq(schema.houseMembers.email, "bill@sierra.test"));
    const res = await saveMemberProfile("bill@sierra.test", { ...PROFILE, phone: "555-0000" });
    expect(res.geocoded).toBeUndefined();
    const m = await bill();
    expect(m.homeLat).toBe(99);
    expect(m.phone).toBe("555-0000");
  });
});

describe("perks", () => {
  const GRANT = { title: "Phone stipend", amount: "85", cadence: "monthly", startsOn: "2026-08-01", note: "" };
  const rows = () => testDb.select().from(schema.perks);

  it("lets HR grant one, stamped to the workspace and the person", async () => {
    who = HR;
    const { addPerk } = await import("@/app/actions");
    expect(await addPerk("bill@sierra.test", GRANT)).toEqual({});
    const [p] = await rows();
    expect(p.orgId).toBe(3);
    expect(p.tenantOrgId).toBe(3);
    expect(p.personEmail).toBe("bill@sierra.test");
    expect(p.amountCents).toBe(8_500);
  });

  it("refuses plain staff and the other company's owner alike", async () => {
    const { addPerk } = await import("@/app/actions");
    who = STAFF;
    expect((await addPerk("bill@sierra.test", GRANT)).error).toBe("Not found");
    who = OTHER_OWNER;
    expect((await addPerk("bill@sierra.test", GRANT)).error).toBe("Not found");
    expect(await rows()).toHaveLength(0);
  });

  it("carries the terms' own objections through", async () => {
    who = OWNER;
    const { addPerk } = await import("@/app/actions");
    expect((await addPerk("bill@sierra.test", { ...GRANT, amount: "" })).error).toContain("worth");
    expect((await addPerk("bill@sierra.test", { ...GRANT, startsOn: "soon" })).error).toContain("day it starts");
  });

  it("ends one without erasing it, and only for its own workspace", async () => {
    who = HR;
    const { addPerk, endPerk } = await import("@/app/actions");
    await addPerk("bill@sierra.test", GRANT);
    const [p] = await rows();
    who = OTHER_OWNER;
    expect((await endPerk(p.id, "2026-12-31")).error).toBe("Not found");
    who = HR;
    expect((await endPerk(p.id, "2026-07-01")).error).toContain("before the perk started");
    expect(await endPerk(p.id, "2026-12-31")).toEqual({});
    expect((await rows())[0].endsOn).toBe("2026-12-31");
  });

  it("deletes only with a reason, for the row typed wrong", async () => {
    who = HR;
    const { addPerk, deletePerk } = await import("@/app/actions");
    await addPerk("bill@sierra.test", GRANT);
    const [p] = await rows();
    expect((await deletePerk(p.id, " ")).error).toBeTruthy();
    expect(await deletePerk(p.id, "typed onto the wrong person")).toEqual({});
    expect(await rows()).toHaveLength(0);
  });
});

describe("wages from the person file", () => {
  it("goes through the register's own action, superseding in place", async () => {
    who = HR;
    const { addPayrollEntry } = await import("@/app/actions");
    expect((await addPayrollEntry(3, {
      name: "Bill", personEmail: "bill@sierra.test", title: "FSE",
      kind: "hourly", amount: "42.50", hoursPerWeek: 40, ftePct: 100, burdenPct: 20,
      effectiveOn: "2026-01-01", note: "",
    })).error).toBeUndefined();
    const raise = await addPayrollEntry(3, {
      name: "Bill", personEmail: "bill@sierra.test", title: "Senior FSE",
      kind: "hourly", amount: "48.00", hoursPerWeek: 40, ftePct: 100, burdenPct: 20,
      effectiveOn: "2026-09-01", note: "",
    });
    expect(raise.superseded).toBe("2026-08-31");
    const all = await testDb.select().from(schema.payroll);
    expect(all).toHaveLength(2);
    // January still says what January cost.
    expect(all.find((r) => r.effectiveOn === "2026-01-01")!.endsOn).toBe("2026-08-31");
  });

  it("is refused to staff without the HR flag", async () => {
    who = STAFF;
    const { addPayrollEntry } = await import("@/app/actions");
    expect((await addPayrollEntry(3, {
      name: "Bill", personEmail: "bill@sierra.test", title: "",
      kind: "hourly", amount: "42.50", hoursPerWeek: 40, ftePct: 100, burdenPct: 0,
      effectiveOn: "2026-01-01", note: "",
    })).error).toBe("Not found");
  });
});
