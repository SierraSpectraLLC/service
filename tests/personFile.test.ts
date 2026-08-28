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
  DELETE FROM perks; DELETE FROM payroll;
  UPDATE house_members SET home_address = '', phone = '', emergency_name = '',
    emergency_phone = '', started_on = '', home_lat = NULL, home_lng = NULL;
`;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES
      (3, 'Sierra Spectra', 'provider', true),
      (5, 'Cascade Analytical', 'provider', true);
    SELECT setval('orgs_id_seq', 100);
    INSERT INTO house_members (email, org_id, role, name, can_admin_people) VALUES
      ('joe@sierra.test',  3, 'owner', 'Joe',  false),
      ('pat@sierra.test',  3, 'staff', 'Pat',  true),
      ('bill@sierra.test', 3, 'staff', 'Bill', false),
      ('cass@cascade.test', 5, 'owner', 'Cass', false);
  `);
});

beforeEach(async () => { who = null; await client.exec(RESET); });

const PROFILE = {
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
