// Adding a person at a client, and the temporary password that gets them in.
//
// The password half is the security-shaped part, so it is tested against a real
// database rather than a mock: an account is created for somebody who has never
// signed in, a password is hashed onto it, the login door accepts it, and then
// - the part that matters - stops accepting it the moment its date passes.
//
// The refusals are the point of the rest: a client's own editor may invite a
// colleague but may not mint a credential, and no operator can add people to
// another operator's client.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));

type Who = {
  email: string; name: string; role: string;
  orgId: number | null; orgName?: string; orgKind?: string;
  operatorOrgId: number | null; rootOperatorOrgId: number | null;
};
let who: Who;
vi.mock("@/auth", () => ({ auth: async () => ({ user: who }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
// No mail goes anywhere from a test, and the invitation is not what is under test.
vi.mock("@/lib/notify", () => ({
  notifyInvite: async () => {},
  notifyTaskAssigned: async () => {},
  notifyMentions: async () => {},
}));

const HOUSE: Who = {
  email: "joe@sierra.test", name: "Joe", role: "owner",
  orgId: null, operatorOrgId: 3, rootOperatorOrgId: 3,
};
const RIVAL: Who = {
  email: "sam@rival.test", name: "Sam", role: "owner",
  orgId: null, operatorOrgId: 4, rootOperatorOrgId: 3,
};
const CLIENT_EDITOR: Who = {
  email: "maria@labzen.test", name: "Maria", role: "client_editor",
  orgId: 1, orgName: "Lab Zen", orgKind: "client",
  operatorOrgId: null, rootOperatorOrgId: 3,
};

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO app_settings (id, client_access_enabled) VALUES (1, true);
    INSERT INTO orgs (name, kind) VALUES
      ('Lab Zen', 'client'), ('Coastal Analytical', 'client'),
      ('Sierra Spectra', 'provider'), ('Rival Instruments', 'provider');
    UPDATE orgs SET is_operator = true WHERE id IN (3, 4);
    UPDATE orgs SET parent_org_id = 3 WHERE id IN (1, 2);
    UPDATE app_settings SET operator_org_id = 3 WHERE id = 1;
    INSERT INTO org_sites (org_id, name, address) VALUES (1, 'Mission Bay', '1700 4th St, San Francisco');
  `);
});

beforeEach(() => { who = HOUSE; });

const actions = await import("@/app/actions");
const person = (over: Record<string, unknown> = {}) => ({
  firstName: "Rita", lastName: "Alvarez", title: "Lab manager",
  email: "rita@labzen.test", siteId: null, canEdit: true, canSeeAgreements: true,
  invite: false, ...over,
});

describe("adding a whole person in one go", () => {
  it("writes the sign-in entry and the profile they have not filled in yet", async () => {
    const res = await actions.addClientPerson(1, person({ siteId: 1 }));
    expect(res.error).toBeUndefined();
    const [entry] = (await testDb.select().from(schema.clientAllowlist))
      .filter((r) => r.entry === "rita@labzen.test");
    expect(entry.orgId).toBe(1);
    expect(entry.canEdit).toBe(true);
    expect(entry.canSeeAgreements).toBe(true);
    // The profile exists BEFORE any sign-in, so the app knows her name the
    // first time she arrives rather than calling her "rita".
    const [u] = (await testDb.select().from(schema.users)).filter((x) => x.email === "rita@labzen.test");
    expect(u.name).toBe("Rita Alvarez");
    expect(u.title).toBe("Lab manager");
    expect(u.siteId).toBe(1);
    expect(u.passwordHash).toBe("");
  });

  it("refuses an address that already signs in somewhere", async () => {
    const res = await actions.addClientPerson(2, person());
    expect(res.error).toContain("already signs in");
  });

  it("refuses a lab that is not this organization's", async () => {
    const res = await actions.addClientPerson(2, person({ email: "new@coastal.test", siteId: 1 }));
    expect(res.error).toBe("That site is not one of theirs");
  });

  it("keeps another operator out of this workspace's client", async () => {
    who = RIVAL;
    const res = await actions.addClientPerson(1, person({ email: "poach@labzen.test" }));
    expect(res.error).toBe("Not found");
  });

  it("lets a client's own editor add a colleague, but not mint a password", async () => {
    who = CLIENT_EDITOR;
    const ok = await actions.addClientPerson(1, person({ email: "colleague@labzen.test" }));
    expect(ok.error).toBeUndefined();
    const nope = await actions.addClientPerson(1, person({
      email: "another@labzen.test", withPassword: true,
    }));
    expect(nope.error).toContain("Only the service team");
    // Somebody else's organization stays somebody else's.
    const theirs = await actions.addClientPerson(2, person({ email: "x@coastal.test" }));
    expect(theirs.error).toBe("Not found");
  });
});

describe("the temporary password", () => {
  it("comes back once, in the clear, and never touches the database that way", async () => {
    const res = await actions.addClientPerson(1, person({
      email: "bill@labzen.test", firstName: "Bill", lastName: "Harner",
      withPassword: true, tempDays: 5,
    }));
    expect(res.error).toBeUndefined();
    expect(res.password).toMatch(/^[a-z]+-[a-z]+-[a-z]+-\d{4}$/);
    expect(res.expiresOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const [u] = (await testDb.select().from(schema.users)).filter((x) => x.email === "bill@labzen.test");
    expect(u.passwordHash).toContain("scrypt$");
    expect(u.passwordHash).not.toContain(res.password!);
    expect(u.passwordTempUntil).toBeTruthy();

    // And the audit line says a password was set without saying which.
    const audit = await testDb.select().from(schema.auditLog);
    const line = audit.map((a) => a.action).find((a) => a.includes("temporary sign-in password"));
    expect(line).toBeTruthy();
    expect(line).not.toContain(res.password!);
  });

  it("opens the door, until the day it does not", async () => {
    const { checkPassword } = await import("@/lib/passwordAuth");
    const res = await actions.addClientPerson(1, person({
      email: "kim@labzen.test", firstName: "Kim", withPassword: true, tempDays: 2,
    }));
    const pw = res.password!;

    const now = new Date();
    const ok = await checkPassword("kim@labzen.test", pw, now);
    expect(ok && "userId" in ok).toBe(true);

    // The wrong one is refused the same way it always was.
    expect(await checkPassword("kim@labzen.test", "harbor-quartz-elm-0000", now)).toBeNull();

    // Three days on, the loan is over - and it says so rather than pretending
    // the password was never right, because they proved they know it.
    const later = new Date(now.getTime() + 3 * 86_400_000);
    const dead = await checkPassword("kim@labzen.test", pw, later);
    expect(dead).toEqual({ expired: true });
  });

  it("can be given to somebody who was added long ago and never got a code", async () => {
    const { checkPassword } = await import("@/lib/passwordAuth");
    // Approved by hand, no account row, never signed in - the state everybody
    // stuck behind a young domain is actually in.
    await testDb.insert(schema.clientAllowlist).values({ entry: "old@labzen.test", orgId: 1, canEdit: false });
    const [row] = (await testDb.select().from(schema.clientAllowlist))
      .filter((r) => r.entry === "old@labzen.test");

    const res = await actions.setClientTempPassword(row.id, 7);
    expect(res.error).toBeUndefined();
    const ok = await checkPassword("old@labzen.test", res.password!, new Date());
    expect(ok && "userId" in ok).toBe(true);

    // And taking it back puts them straight back on codes.
    await actions.clearClientTempPassword(row.id);
    expect(await checkPassword("old@labzen.test", res.password!, new Date())).toBeNull();
  });

  it("is not something another operator can mint on this workspace's client", async () => {
    const [row] = (await testDb.select().from(schema.clientAllowlist))
      .filter((r) => r.entry === "rita@labzen.test");
    who = RIVAL;
    expect((await actions.setClientTempPassword(row.id)).error).toBe("Not found");
    expect((await actions.clearClientTempPassword(row.id)).error).toBe("Not found");
  });

  it("refuses a whole-domain rule, which is not a person", async () => {
    await testDb.insert(schema.clientAllowlist).values({ entry: "@labzen.test", orgId: 1, canEdit: false });
    const [row] = (await testDb.select().from(schema.clientAllowlist))
      .filter((r) => r.entry === "@labzen.test");
    const res = await actions.setClientTempPassword(row.id);
    expect(res.error).toContain("not a person");
  });
});
