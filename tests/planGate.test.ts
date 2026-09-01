// The wall, and the faucet behind it.
//
// A workspace used to exist because the platform owner made one, and they made
// one after the company paid - that human step WAS the price. Accepting a
// hand-off is a second door into the same room and it cannot have the same lock
// on it, so the workspace it opens is real and its CLIENT LIST is bounded.
//
// Plus the deliberate exception: one workspace can be given more room than the
// tier, by hand, because handing a shop two clients at once is sometimes what
// wins it. That grant has to move the wall for THAT shop and nothing else.
//
// Two properties, and the second is the one that actually costs money if it is
// wrong. Every door a client can arrive through has to respect the bound, or it
// is not a bound. And a free workspace must not be able to open another one -
// otherwise handing your only client on leaves two free workspaces where one
// stood, then four, forever, on somebody else's invitation.
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

/** 3 = Sierra Spectra, who pay. Their owner. */
const JOE: Who = {
  email: "joe@sierra.test", name: "Joe", role: "owner",
  orgId: null, operatorOrgId: 3, rootOperatorOrgId: 3,
};
/** The shop that arrived through a hand-off. operatorOrgId ≠ root, or they
    would read as platform staff and skip every rule here - see lib/tenants. */
const DANA = (orgId: number): Who => ({
  email: "dana@newshop.test", name: "Dana", role: "owner",
  orgId: null, operatorOrgId: orgId, rootOperatorOrgId: 3,
});

const { and, eq } = await import("drizzle-orm");

beforeAll(async () => {
  const notify = await import("@/lib/notify");
  vi.spyOn(notify, "notifyHandoffInvite").mockImplementation(async () => {});
  vi.spyOn(notify, "notifyHandoffJoined").mockImplementation(async () => {});
  vi.spyOn(notify, "notifyInvite").mockImplementation(async () => true);
  vi.spyOn(notify, "notifyClientShared").mockImplementation(async () => {});

  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES (3, 'Sierra Spectra', 'provider', true);
    INSERT INTO orgs (id, name, kind, parent_org_id) VALUES (7, 'Emery Pharma', 'client', 3);
    SELECT setval('orgs_id_seq', 100);
    INSERT INTO house_members (email, org_id, role, name) VALUES ('joe@sierra.test', 3, 'owner', 'Joe');
    INSERT INTO app_settings (id, operator_org_id, public_contact_email)
      VALUES (1, 3, 'joe@ridgelinefield.com');
    INSERT INTO org_sites (org_id, tenant_org_id, name, address)
      VALUES (7, 3, 'Hayward', '2000 Sample Way, Hayward CA 94544');
    INSERT INTO instruments (external_id, client, model, category, owner_org_id, tenant_org_id)
      VALUES ('EP-001', 'Emery Pharma', '6495C', 'LC-MS', 7, 3);
  `);
});

beforeEach(async () => {
  who = null;
  await client.exec(`
    DELETE FROM referral_fees; DELETE FROM client_shares;
    DELETE FROM instruments WHERE tenant_org_id <> 3;
    DELETE FROM org_sites WHERE tenant_org_id <> 3;
    DELETE FROM expense_categories;
    DELETE FROM house_members WHERE email <> 'joe@sierra.test';
    DELETE FROM orgs WHERE id > 100;
    UPDATE orgs SET plan = '', plan_since = '', free_clients = 0 WHERE id IN (3, 7);
  `);
});

const FEE = {
  kind: "flat", feeCents: 200_000, feeBps: 0, windowMonths: 12,
  minCents: 0, maxCents: 0, note: "",
};

/** Joe invites a stranger, the stranger accepts. Returns their new workspace. */
async function handOff(email = "dana@newshop.test", company = "Northwest Instrument") {
  who = JOE;
  const { inviteHandoff, acceptHandoff } = await import("@/app/actions");
  const sent = await inviteHandoff(7, { email, note: "four LC-MS on your patch", terms: FEE } as never);
  expect(sent.error).toBeUndefined();
  who = null;                                    // a stranger, with no session
  const took = await acceptHandoff(sent.token!, { companyName: company });
  expect(took.error).toBeUndefined();
  const [org] = await testDb.select().from(schema.orgs).where(eq(schema.orgs.name, company));
  return org;
}

describe("what accepting opens", () => {
  it("is a real workspace, and it is on the free tier", async () => {
    const org = await handOff();
    expect(org.isOperator).toBe(true);
    expect(org.plan).toBe("free");
    expect(org.planSince).not.toBe("");
  });

  it("arrives holding exactly the client it was handed", async () => {
    const org = await handOff();
    const clients = await testDb.select().from(schema.orgs)
      .where(eq(schema.orgs.parentOrgId, org.id));
    expect(clients.map((c) => c.name)).toEqual(["Emery Pharma"]);
  });

  it("leaves every workspace that already existed alone", async () => {
    /*
     * The column arrives with DEFAULT '' on a table of paying customers, and
     * blank is full. A deploy that downgraded them would be the worst possible
     * version of this feature.
     */
    await handOff();
    const [sierra] = await testDb.select().from(schema.orgs).where(eq(schema.orgs.id, 3));
    expect(sierra.plan).toBe("");
  });
});

describe("the wall is on every door a client comes through", () => {
  it("stops a second client being typed in", async () => {
    const org = await handOff();
    who = DANA(org.id);
    const { addOrg } = await import("@/app/actions");
    const res = await addOrg("Bayview Diagnostics", "client");
    expect(res.error).toContain("came free with the client you were handed");
    // And it names somebody to talk to rather than dead-ending.
    expect(res.error).toContain("joe@ridgelinefield.com");
    expect(res.id).toBeUndefined();
  });

  it("stops a second client arriving as somebody else's hand-off", async () => {
    /*
     * The door addOrg is not. Accepting an offer is how a workspace gains a
     * client just as much as typing one in is, and a limit enforced on one
     * path and not the other is not a limit.
     */
    const org = await handOff();
    // Joe shortlists them and offers a second client.
    await client.exec(`
      INSERT INTO orgs (id, name, kind, parent_org_id) VALUES (8, 'Bayview Diagnostics', 'client', 3);
      INSERT INTO instruments (external_id, client, model, owner_org_id, tenant_org_id)
        VALUES ('BV-001', 'Bayview Diagnostics', '7890B', 8, 3);
      INSERT INTO provider_links (tenant_org_id, provider_org_id, created_by)
        VALUES (3, ${org.id}, 'joe@sierra.test');
    `);
    who = JOE;
    const { shareClient, decideClientShare } = await import("@/app/actions");
    const sent = await shareClient(8, { toOrgIds: [org.id], note: "", terms: FEE } as never);
    expect(sent.error).toBeUndefined();
    const [offer] = await testDb.select().from(schema.clientShares)
      .where(eq(schema.clientShares.sourceOrgId, 8));

    who = DANA(org.id);
    const took = await decideClientShare(offer.id, true);
    expect(took.error).toContain("A second client needs a subscription");
    expect(took.orgId).toBeUndefined();
  });

  it("never stops somebody DECLINING an offer", async () => {
    // Refusing work must not depend on what anybody is paying.
    const org = await handOff();
    await client.exec(`
      INSERT INTO orgs (id, name, kind, parent_org_id) VALUES (9, 'Cove Labs', 'client', 3);
      INSERT INTO instruments (external_id, client, model, owner_org_id, tenant_org_id)
        VALUES ('CV-001', 'Cove Labs', '7890B', 9, 3);
      INSERT INTO provider_links (tenant_org_id, provider_org_id, created_by)
        VALUES (3, ${org.id}, 'joe@sierra.test');
    `);
    who = JOE;
    const { shareClient, decideClientShare } = await import("@/app/actions");
    await shareClient(9, { toOrgIds: [org.id], note: "", terms: FEE } as never);
    const [offer] = await testDb.select().from(schema.clientShares)
      .where(eq(schema.clientShares.sourceOrgId, 9));

    who = DANA(org.id);
    const said = await decideClientShare(offer.id, false, "not our patch");
    expect(said.error).toBeUndefined();
    const [after] = await testDb.select().from(schema.clientShares)
      .where(eq(schema.clientShares.id, offer.id));
    expect(after.status).toBe("declined");
  });

  it("lets a paying workspace take on as many as it likes", async () => {
    who = JOE;
    const { addOrg } = await import("@/app/actions");
    for (const n of ["One Lab", "Two Lab", "Three Lab"]) {
      expect((await addOrg(n, "client")).error).toBeUndefined();
    }
  });
});

describe("the faucet", () => {
  it("will not let a free workspace open another one", async () => {
    /*
     * THE CHAIN. Hand your only client on and two free workspaces stand where
     * one did, then four. It needs no bad faith - one person with a second
     * address walks it by accident - and every step costs a tenant and earns
     * nothing.
     */
    const org = await handOff();
    who = DANA(org.id);
    const { inviteHandoff } = await import("@/app/actions");
    const [theirs] = await testDb.select().from(schema.orgs)
      .where(eq(schema.orgs.parentOrgId, org.id));
    const res = await inviteHandoff(theirs.id, {
      email: "someone@third.test", note: "", terms: FEE,
    } as never);
    expect(res.error).toContain("opens a workspace");
    expect(res.token).toBeUndefined();
    expect(await testDb.select().from(schema.clientShares)
      .where(eq(schema.clientShares.tenantOrgId, org.id))).toHaveLength(0);
  });

  it("leaves them able to hand it to a company already here", async () => {
    // That mints nothing: it moves a client between two workspaces that exist,
    // and one of them is paying.
    const org = await handOff();
    await client.exec(`INSERT INTO provider_links (tenant_org_id, provider_org_id, created_by)
      VALUES (${org.id}, 3, 'dana@newshop.test');`);
    who = DANA(org.id);
    const { shareClient } = await import("@/app/actions");
    const [theirs] = await testDb.select().from(schema.orgs)
      .where(eq(schema.orgs.parentOrgId, org.id));
    const res = await shareClient(theirs.id, { toOrgIds: [3], note: "", terms: FEE } as never);
    expect(res.error).toBeUndefined();
    expect(res.sent).toBe(1);
  });

  it("caps how many invitations one workspace has in flight", async () => {
    const { OPEN_INVITES } = await import("@/lib/plan");
    const rows = Array.from({ length: OPEN_INVITES }, (_, i) =>
      `(3, NULL, 'x${i}@shop.test', 'tok${i}', 7, '{}', 'pending')`).join(",");
    await client.exec(`INSERT INTO client_shares
      (tenant_org_id, to_org_id, to_email, invite_token, source_org_id, payload, status)
      VALUES ${rows};`);
    who = JOE;
    const { inviteHandoff } = await import("@/app/actions");
    const res = await inviteHandoff(7, { email: "one@more.test", note: "", terms: FEE } as never);
    expect(res.error).toContain("still open");
  });

  it("counts only invitations, not offers to workspaces that exist", async () => {
    // An in-network offer sends no email to a stranger, so it is not what the
    // cap is about.
    const { OPEN_INVITES } = await import("@/lib/plan");
    // Pointed at a real workspace, which is what makes them not invitations.
    const rows = Array.from({ length: OPEN_INVITES }, () =>
      `(3, 3, '', '', 7, '{}', 'pending')`).join(",");
    await client.exec(`INSERT INTO client_shares
      (tenant_org_id, to_org_id, to_email, invite_token, source_org_id, payload, status)
      VALUES ${rows};`);
    who = JOE;
    const { inviteHandoff } = await import("@/app/actions");
    const res = await inviteHandoff(7, { email: "one@more.test", note: "", terms: FEE } as never);
    expect(res.error).toBeUndefined();
  });
});

describe("lifting the limit", () => {
  it("is the platform owner's to do, and nobody else's", async () => {
    const org = await handOff();
    const { setWorkspacePlan } = await import("@/app/actions");
    who = DANA(org.id);
    await expect(setWorkspacePlan(org.id, "", "we would like this")).rejects.toThrow();
    who = JOE;
    expect((await setWorkspacePlan(org.id, "", "paid INV-1042")).error).toBeUndefined();
  });

  it("opens both gates at once", async () => {
    const org = await handOff();
    who = JOE;
    const { setWorkspacePlan } = await import("@/app/actions");
    await setWorkspacePlan(org.id, "", "paid INV-1042");

    who = DANA(org.id);
    const { addOrg, inviteHandoff } = await import("@/app/actions");
    expect((await addOrg("Bayview Diagnostics", "client")).error).toBeUndefined();
    /* The client this workspace ARRIVED holding, by name.
       It used to take whichever child org the select handed back first, and
       by this point there are two - the one it was handed, which has systems,
       and the Bayview the line above just typed in, which has none. An offer
       needs systems to carry, so the assertion was a coin flip on row order,
       and a column added to `orgs` was enough to land it the other way. */
    const [theirs] = await testDb.select().from(schema.orgs)
      .where(and(eq(schema.orgs.parentOrgId, org.id), eq(schema.orgs.name, "Emery Pharma")));
    expect((await inviteHandoff(theirs.id, {
      email: "someone@third.test", note: "", terms: FEE,
    } as never)).error).toBeUndefined();
  });

  it("keeps why, because somebody will ask a year from now", async () => {
    const org = await handOff();
    who = JOE;
    const { setWorkspacePlan } = await import("@/app/actions");
    expect((await setWorkspacePlan(org.id, "", "ok")).error).toContain("reason is required");
    await setWorkspacePlan(org.id, "", "paid the first invoice, INV-1042");
    const trail = await testDb.select().from(schema.auditLog);
    expect(trail.some((a) => a.action.includes("INV-1042") && a.action.includes("full"))).toBe(true);
  });

  it("refuses to put the instance's own workspace on a plan", async () => {
    // A console misclick that limited it would lock the platform's staff out
    // of taking a client on while they were supporting somebody.
    who = JOE;
    const { setWorkspacePlan } = await import("@/app/actions");
    expect((await setWorkspacePlan(3, "free", "misclick")).error)
      .toContain("running the instance");
  });
});

describe("stretching the tier for one shop", () => {
  it("is the platform owner's to give, and nobody else's", async () => {
    const org = await handOff();
    const { setFreeClients } = await import("@/app/actions");
    who = DANA(org.id);
    await expect(setFreeClients(org.id, 2, "we would like two")).rejects.toThrow();
    who = JOE;
    expect((await setFreeClients(org.id, 2, "sweetener on the Emery hand-off")).error)
      .toBeUndefined();
  });

  it("lets the second client be typed in, and stops at the third", async () => {
    const org = await handOff();
    who = JOE;
    const { setFreeClients } = await import("@/app/actions");
    await setFreeClients(org.id, 2, "sweetener on the Emery hand-off");

    who = DANA(org.id);
    const { addOrg } = await import("@/app/actions");
    expect((await addOrg("Bayview Diagnostics", "client")).error).toBeUndefined();
    const third = await addOrg("Cove Labs", "client");
    expect(third.error).toContain("covers 2 clients");
    // Still names somebody rather than dead-ending, and still sells nothing.
    expect(third.error).toContain("joe@ridgelinefield.com");
    expect(third.id).toBeUndefined();
  });

  it("lets the second client arrive as a hand-off, which is the point of it", async () => {
    /*
     * The door this was bought for: two clients handed over in one
     * conversation. If the grant moved addOrg's wall and not this one it would
     * not do the thing it exists to do.
     */
    const org = await handOff();
    who = JOE;
    const { setFreeClients, shareClient, decideClientShare } = await import("@/app/actions");
    await setFreeClients(org.id, 2, "handing them Bayview as well");
    // Its own id and name: beforeEach clears orgs above 100 only, so a client
    // an earlier test filed under Sierra is still sitting there.
    await client.exec(`
      INSERT INTO orgs (id, name, kind, parent_org_id) VALUES (21, 'Harbor Analytical', 'client', 3);
      INSERT INTO instruments (external_id, client, model, owner_org_id, tenant_org_id)
        VALUES ('HB-021', 'Harbor Analytical', '7890B', 21, 3);
      INSERT INTO provider_links (tenant_org_id, provider_org_id, created_by)
        VALUES (3, ${org.id}, 'joe@sierra.test');
    `);
    await shareClient(21, { toOrgIds: [org.id], note: "", terms: FEE } as never);
    const [offer] = await testDb.select().from(schema.clientShares)
      .where(eq(schema.clientShares.sourceOrgId, 21));

    who = DANA(org.id);
    const took = await decideClientShare(offer.id, true);
    expect(took.error).toBeUndefined();
    const theirs = await testDb.select().from(schema.orgs)
      .where(eq(schema.orgs.parentOrgId, org.id));
    expect(theirs.map((c) => c.name).sort()).toEqual(["Emery Pharma", "Harbor Analytical"]);
  });

  it("moves the wall for that shop alone", async () => {
    // A grant is a deal with one company. The next shop through the same door
    // gets what the tier gives, or it was not a grant, it was a release.
    const first = await handOff();
    who = JOE;
    const { setFreeClients, addOrg } = await import("@/app/actions");
    await setFreeClients(first.id, 2, "sweetener on the Emery hand-off");
    const second = await handOff("rae@othershop.test", "Cascade Calibration");

    who = DANA(second.id);
    expect((await addOrg("Bayview Diagnostics", "client")).error)
      .toContain("came free with the client you were handed");
  });

  it("does not open the faucet along with it", async () => {
    /*
     * Room for another client and permission to MINT another workspace are
     * different things. The chain argument is about workspaces, and two clients
     * does not answer it - see lib/plan.
     */
    const org = await handOff();
    who = JOE;
    const { setFreeClients } = await import("@/app/actions");
    await setFreeClients(org.id, 2, "sweetener on the Emery hand-off");

    who = DANA(org.id);
    const { inviteHandoff } = await import("@/app/actions");
    const [theirs] = await testDb.select().from(schema.orgs)
      .where(eq(schema.orgs.parentOrgId, org.id));
    expect((await inviteHandoff(theirs.id, {
      email: "someone@third.test", note: "", terms: FEE,
    } as never)).error).toContain("opens a workspace");
  });

  it("stops well short of giving the product away", async () => {
    const org = await handOff();
    who = JOE;
    const { setFreeClients } = await import("@/app/actions");
    const { FREE_CLIENTS_MAX } = await import("@/lib/plan");
    expect((await setFreeClients(org.id, FREE_CLIENTS_MAX + 1, "they asked nicely")).error)
      .toContain("subscription");
    const [after] = await testDb.select().from(schema.orgs).where(eq(schema.orgs.id, org.id));
    expect(after.freeClients).toBe(0);
  });

  it("can be taken back, and taking it back deletes nothing", async () => {
    const org = await handOff();
    who = JOE;
    const { setFreeClients } = await import("@/app/actions");
    await setFreeClients(org.id, 2, "sweetener on the Emery hand-off");
    who = DANA(org.id);
    const { addOrg } = await import("@/app/actions");
    await addOrg("Bayview Diagnostics", "client");

    who = JOE;
    expect((await setFreeClients(org.id, 1, "deal did not close")).error).toBeUndefined();
    const theirs = await testDb.select().from(schema.orgs)
      .where(eq(schema.orgs.parentOrgId, org.id));
    expect(theirs).toHaveLength(2);          // both clients still there
    who = DANA(org.id);
    expect((await addOrg("Cove Labs", "client")).error).toContain("subscription");
  });

  it("keeps why, because somebody will ask why this shop has two", async () => {
    const org = await handOff();
    who = JOE;
    const { setFreeClients } = await import("@/app/actions");
    expect((await setFreeClients(org.id, 2, "ok")).error).toContain("reason is required");
    await setFreeClients(org.id, 2, "sweetener that closed the Emery hand-off");
    const trail = await testDb.select().from(schema.auditLog);
    expect(trail.some((a) => a.action.includes("sweetener that closed the Emery hand-off")
      && a.action.includes("2 clients"))).toBe(true);
  });
});
