// The paperwork on a person file, and where somebody is stationed - through
// the real actions.
//
// What these hold down is WHO, exactly as tests/personFile does: an employee's
// contract names their pay, so it is readable by whoever administers the
// people and the person themselves, never by a colleague and never across a
// workspace - and it is on nobody's shelf. The staffed location is checked
// the same way a system's site is: one of THEIR company's sites, or refused.
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
const COLLEAGUE: Who = {
  email: "sam@sierra.test", name: "Sam", role: "staff",
  orgId: null, operatorOrgId: 3, rootOperatorOrgId: 3,
};
const OTHER_OWNER: Who = {
  email: "cass@cascade.test", name: "Cass", role: "owner",
  orgId: null, operatorOrgId: 5, rootOperatorOrgId: 3,
};

const PAPER = [{ fileName: "bill-contract.pdf", url: "https://blob.test/bill-contract.pdf", size: 1234 }];
const PROFILE = {
  name: "Bill Harner", title: "Field service engineer",
  homeAddress: "", phone: "555-0155", emergencyName: "", emergencyPhone: "", startedOn: "",
};

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
      ('sam@sierra.test',  3, 'staff', 'Sam',  false),
      ('cass@cascade.test', 5, 'owner', 'Cass', false);
    INSERT INTO org_sites (id, tenant_org_id, org_id, name, address) VALUES
      (10, 3, 3, 'Reno shop', '1 Cedar St, Reno NV'),
      (11, 5, 5, 'Cascade yard', '9 Pine St, Bend OR');
    SELECT setval('org_sites_id_seq', 100);
  `);
});

beforeEach(async () => {
  who = null;
  await client.exec("DELETE FROM attachments; DELETE FROM users;");
});

const papers = () => testDb.select().from(schema.attachments);
const bill = async () => (await testDb.select().from(schema.houseMembers))
  .find((m) => m.email === "bill@sierra.test")!;

describe("paperwork on the person file", () => {
  it("is filed by HR against the person, on no shelf, in the workspace", async () => {
    who = HR;
    const { uploadMemberPapers } = await import("@/app/actions");
    expect(await uploadMemberPapers("bill@sierra.test", PAPER)).toEqual({});
    const [row] = await papers();
    expect(row.houseMemberId).toBe((await bill()).id);
    expect(row.tenantOrgId).toBe(3);
    expect(row.orgId).toBeNull();
    expect(row.kind).toBe("Contract");
    expect(row.uploadedBy).toBe("Pat");
  });

  it("is refused to plain staff and to another company's owner alike", async () => {
    const { uploadMemberPapers } = await import("@/app/actions");
    who = STAFF;
    expect((await uploadMemberPapers("sam@sierra.test", PAPER)).error).toBe("Not found");
    who = OTHER_OWNER;
    expect((await uploadMemberPapers("bill@sierra.test", PAPER)).error).toBe("Not found");
    expect(await papers()).toHaveLength(0);
  });

  it("never appears in the document library, and the library's delete refuses it", async () => {
    who = HR;
    const { uploadMemberPapers, listLibraryFiles, deleteAttachment } = await import("@/app/actions");
    await uploadMemberPapers("bill@sierra.test", PAPER);
    who = OWNER;
    expect((await listLibraryFiles()).files).toHaveLength(0);
    const [row] = await papers();
    expect((await deleteAttachment(row.id, "tidying")).error).toBe("Not found");
    expect(await papers()).toHaveLength(1);
  });

  it("is readable by the owner, HR and the person - not by a colleague, not across workspaces", async () => {
    who = HR;
    const { uploadMemberPapers } = await import("@/app/actions");
    await uploadMemberPapers("bill@sierra.test", PAPER);
    const [row] = await papers();
    const { mayReadAttachment } = await import("@/lib/fileAccess");
    who = OWNER; expect(await mayReadAttachment(row)).toBe(true);
    who = HR; expect(await mayReadAttachment(row)).toBe(true);
    who = STAFF; expect(await mayReadAttachment(row)).toBe(true);      // Bill's own contract
    who = COLLEAGUE; expect(await mayReadAttachment(row)).toBe(false); // Sam, staff beside him
    who = OTHER_OWNER; expect(await mayReadAttachment(row)).toBe(false);
    who = null; expect(await mayReadAttachment(row)).toBe(false);
  });

  it("is removed only by whoever administers the person, with a reason", async () => {
    who = HR;
    const { uploadMemberPapers, removeMemberPaper } = await import("@/app/actions");
    await uploadMemberPapers("bill@sierra.test", PAPER);
    const [row] = await papers();
    who = OTHER_OWNER;
    expect((await removeMemberPaper(row.id, "not mine")).error).toBe("Not found");
    who = STAFF;
    expect((await removeMemberPaper(row.id, "mine")).error).toBe("Not found");
    who = HR;
    expect((await removeMemberPaper(row.id, " ")).error).toBeTruthy();
    expect(await removeMemberPaper(row.id, "superseded by the signed copy")).toEqual({});
    expect(await papers()).toHaveLength(0);
  });
});

describe("the site location", () => {
  const account = async () => (await testDb.select().from(schema.users))
    .find((u) => u.email === "bill@sierra.test");

  it("is one of the company's own sites, and lands on the account row as theirs", async () => {
    who = HR;
    const { saveMemberProfile } = await import("@/app/actions");
    expect((await saveMemberProfile("bill@sierra.test", { ...PROFILE, siteId: 10 })).error).toBeUndefined();
    expect((await account())?.siteId).toBe(10);
    // Omitted leaves it alone; null clears it.
    await saveMemberProfile("bill@sierra.test", { ...PROFILE, phone: "555-0000" });
    expect((await account())?.siteId).toBe(10);
    await saveMemberProfile("bill@sierra.test", { ...PROFILE, siteId: null });
    expect((await account())?.siteId).toBeNull();
  });

  it("refuses another operator's site, and a site that does not exist", async () => {
    who = OWNER;
    const { saveMemberProfile } = await import("@/app/actions");
    expect((await saveMemberProfile("bill@sierra.test", { ...PROFILE, siteId: 11 })).error)
      .toContain("not one of your company's sites or a client lab");
    expect((await saveMemberProfile("bill@sierra.test", { ...PROFILE, siteId: 999 })).error)
      .toContain("not one of your company's sites or a client lab");
    expect((await account())?.siteId ?? null).toBeNull();
  });
});
