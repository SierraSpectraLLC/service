// A stranger takes a hand-off, and Ridgeline opens around it.
//
// The conversion loop, and the most exposed write in the app: a public action,
// no session, that creates a WORKSPACE. So what these hold down is the shape
// of that door - the address comes off the row and never off the caller, two
// clicks make one workspace, and a link with a clock on it stops working. Plus
// the thing that makes it worth building: what lands is real work, not an
// empty database.
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
let invited: { to: string; url: string; summary: string; note: string } | null = null;

vi.mock("@/db", () => ({ db: testDb }));
vi.mock("@/auth", () => ({ auth: async () => (who ? { user: who } : null) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));

const JOE: Who = {
  email: "joe@sierra.test", name: "Joe", role: "owner",
  orgId: null, operatorOrgId: 3, rootOperatorOrgId: 3,
};

const { and, eq } = await import("drizzle-orm");

beforeAll(async () => {
  const notify = await import("@/lib/notify");
  vi.spyOn(notify, "notifyHandoffInvite").mockImplementation(async (o) => {
    invited = { to: o.to, url: o.url, summary: o.summary, note: o.note };
  });
  vi.spyOn(notify, "notifyHandoffJoined").mockImplementation(async () => {});
  vi.spyOn(notify, "notifyInvite").mockImplementation(async () => true);

  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES (3, 'Sierra Spectra', 'provider', true);
    INSERT INTO orgs (id, name, kind, parent_org_id) VALUES (7, 'Emery Pharma', 'client', 3);
    SELECT setval('orgs_id_seq', 100);
    INSERT INTO house_members (email, org_id, role, name) VALUES ('joe@sierra.test', 3, 'owner', 'Joe');
    INSERT INTO org_sites (org_id, tenant_org_id, name, address, contact_name, contact_phone, contact_email)
      VALUES (7, 3, 'Hayward', '2000 Sample Way, Hayward CA 94544', 'R. Diaz', '555-0100', 'rd@emery.test');
    INSERT INTO instruments (external_id, client, model, category, owner_org_id, tenant_org_id)
      VALUES ('EP-001', 'Emery Pharma', '6495C', 'LC-MS', 7, 3),
             ('EP-002', 'Emery Pharma', '6495C', 'LC-MS', 7, 3);
  `);
});

beforeEach(async () => {
  who = null; invited = null;
  await client.exec(`
    DELETE FROM referral_fees; DELETE FROM client_shares;
    DELETE FROM assets WHERE tenant_org_id <> 3;
    DELETE FROM instruments WHERE tenant_org_id <> 3;
    DELETE FROM org_sites WHERE tenant_org_id <> 3;
    DELETE FROM expense_categories;
    DELETE FROM house_members WHERE email <> 'joe@sierra.test';
    DELETE FROM orgs WHERE id > 100;
  `);
});

const FEE = {
  kind: "flat", feeCents: 200_000, feeBps: 0, windowMonths: 12,
  minCents: 0, maxCents: 0, note: "",
};
const invite = async (over: Record<string, unknown> = {}) => {
  who = JOE;
  const { inviteHandoff } = await import("@/app/actions");
  return inviteHandoff(7, {
    email: "owner@newshop.test", note: "four LC-MS on your patch", terms: FEE, ...over,
  } as never);
};
const shares = () => testDb.select().from(schema.clientShares);

describe("sending one", () => {
  it("mints a token, freezes the snapshot and is always blind", async () => {
    const res = await invite();
    expect(res.error).toBeUndefined();
    expect(res.token).toBeTruthy();

    const [row] = await shares();
    expect(row.toOrgId).toBeNull();
    expect(row.toEmail).toBe("owner@newshop.test");
    expect(row.inviteToken).toBe(res.token);
    /* Not blind by DEFAULT - blind full stop. The recipient is a stranger who
       has agreed to nothing, and the sender never consented to hand their
       client's identity to somebody who may just read it and close the tab. */
    expect(row.blind).toBe(true);
    expect(row.expiresOn).not.toBe("");
    expect(row.status).toBe("pending");
  });

  it("sends a link and a blind summary, never the client", async () => {
    await invite();
    expect(invited?.to).toBe("owner@newshop.test");
    expect(invited?.url).toContain("/handoff/");
    expect(invited?.summary).toContain("systems");
    expect(JSON.stringify(invited)).not.toContain("Emery");
    expect(JSON.stringify(invited)).not.toContain("Sample Way");
  });

  it("refuses a note that names the client", async () => {
    // Same rule a blind offer runs on. A covering note that gives the game
    // away undoes the blinding in the one place nobody thinks to look.
    const res = await invite({ note: "Emery Pharma are moving and we cannot cover them" });
    expect(res.error).toContain("Emery Pharma");
    expect(await shares()).toHaveLength(0);
  });

  it("sends somebody who already has an account to the right door instead", async () => {
    await client.exec(`INSERT INTO house_members (email, org_id, role) VALUES ('dana@nwis.test', 3, 'staff');`);
    const res = await invite({ email: "dana@nwis.test" });
    expect(res.error).toContain("already has a Ridgeline account");
    expect(await shares()).toHaveLength(0);
  });

  it("refuses a wildcard where an address belongs", async () => {
    expect((await invite({ email: "@theirshop.com" })).error).toContain("one exact email");
  });
});

describe("accepting one", () => {
  const accept = async (over: Record<string, unknown> = {}) => {
    const { token } = await invite();
    who = null;   // a stranger: no session at all
    const { acceptHandoff } = await import("@/app/actions");
    return { token, res: await acceptHandoff(token as string, { companyName: "Northwest Instrument", ...over }) };
  };
  const orgRows = () => testDb.select().from(schema.orgs);

  it("opens a workspace with the client already in it", async () => {
    /*
     * The whole point. Not a sign-up page - a workspace whose first screen has
     * real systems on it, so nobody's first act in Ridgeline is an afternoon
     * of data entry.
     */
    const { res } = await accept();
    expect(res.error).toBeUndefined();
    expect(res.joined).toBe(true);

    const shop = (await orgRows()).find((o) => o.name === "Northwest Instrument");
    expect(shop?.isOperator).toBe(true);
    expect(shop?.parentOrgId).toBeNull();

    // The client, copied into THEIR workspace and stamped to it.
    const theirs = (await orgRows()).find((o) => o.parentOrgId === shop!.id);
    expect(theirs?.name).toBe("Emery Pharma");
    const systems = await testDb.select().from(schema.instruments)
      .where(eq(schema.instruments.tenantOrgId, shop!.id));
    expect(systems).toHaveLength(2);
    const sites = await testDb.select().from(schema.orgSites)
      .where(eq(schema.orgSites.tenantOrgId, shop!.id));
    expect(sites).toHaveLength(1);
  });

  it("puts the keys in the inbox the SENDER chose, never the caller's", async () => {
    /*
     * The one that keeps a leaked link harmless. There is no session here, so
     * nothing stops a stranger calling this - what stops them profiting is
     * that the owner address is read off the row. A stolen link can only ever
     * post an account to the address it was sent to.
     */
    await accept();
    const owners = await testDb.select().from(schema.houseMembers);
    const made = owners.find((m) => m.email === "owner@newshop.test");
    expect(made?.role).toBe("owner");
    expect(owners.some((m) => m.email.includes("attacker"))).toBe(false);
  });

  it("gives them a working expense vocabulary rather than an empty picker", async () => {
    await accept();
    const shop = (await orgRows()).find((o) => o.name === "Northwest Instrument")!;
    const cats = await testDb.select().from(schema.expenseCategories)
      .where(eq(schema.expenseCategories.tenantOrgId, shop.id));
    expect(cats.length).toBeGreaterThan(0);
  });

  it("raises the fee that was agreed, payable to the sender", async () => {
    await accept();
    const [fee] = await testDb.select().from(schema.referralFees);
    expect(fee.payeeOrgId).toBe(3);
    expect(fee.kind).toBe("flat");
    expect(fee.feeCents).toBe(200_000);
    const shop = (await orgRows()).find((o) => o.name === "Northwest Instrument")!;
    expect(fee.payerOrgId).toBe(shop.id);
  });

  it("makes one workspace out of two clicks", async () => {
    /* Two taps on one link, or a double-submit, would otherwise open two
       companies and copy the client into both - and the second is reachable
       by nobody. Settled by the status predicate in the UPDATE's own WHERE,
       the same way the lead board settles its race. */
    const { token } = await invite();
    who = null;
    const { acceptHandoff } = await import("@/app/actions");
    const [a, b] = await Promise.all([
      acceptHandoff(token as string, { companyName: "Northwest Instrument" }),
      acceptHandoff(token as string, { companyName: "Northwest Instrument" }),
    ]);
    expect([a.joined, b.joined].filter(Boolean)).toHaveLength(1);
    expect((await orgRows()).filter((o) => o.name === "Northwest Instrument")).toHaveLength(1);
  });

  it("refuses a token that is not one, without looking anything up", async () => {
    const { acceptHandoff } = await import("@/app/actions");
    who = null;
    for (const bad of ["", "abc", "../../etc/passwd-aaaaaaaaaaa", "%' OR 1=1 --aaaaaaaaaaaaaa"]) {
      expect((await acceptHandoff(bad, { companyName: "Anything" })).error, bad).toBe("Not found");
    }
    expect(await orgRows()).toHaveLength(2);
  });

  it("refuses an expired link", async () => {
    const { token } = await invite();
    await testDb.update(schema.clientShares).set({ expiresOn: "2020-01-01" })
      .where(eq(schema.clientShares.inviteToken, token as string));
    who = null;
    const { acceptHandoff } = await import("@/app/actions");
    expect((await acceptHandoff(token as string, { companyName: "Northwest" })).error)
      .toContain("no longer open");
  });

  it("refuses a withdrawn one", async () => {
    const { token } = await invite();
    await testDb.update(schema.clientShares).set({ status: "withdrawn" })
      .where(eq(schema.clientShares.inviteToken, token as string));
    who = null;
    const { acceptHandoff } = await import("@/app/actions");
    expect((await acceptHandoff(token as string, { companyName: "Northwest" })).error)
      .toContain("no longer open");
  });

  it("survives the exact sequence a browser performs", async () => {
    /*
     * Page load marks it opened, THEN the click accepts - and a first attempt
     * that trips the name check must leave the invitation open for a second.
     * Driven in that order because that is the order a person produces, and
     * an action that reads correctly in isolation can still be wrong in
     * sequence.
     */
    const { token } = await invite();
    who = null;
    const { acceptHandoff, markHandoffOpened } = await import("@/app/actions");
    await markHandoffOpened(token as string);
    expect((await shares())[0].status).toBe("pending");

    const clash = await acceptHandoff(token as string, { companyName: "Sierra Spectra" });
    expect(clash.error).toContain("already on Ridgeline");
    // Still open: a name they cannot have must not burn the invitation.
    expect((await shares())[0].status).toBe("pending");

    const ok = await acceptHandoff(token as string, { companyName: "Second Try Instruments" });
    expect(ok.joined).toBe(true);
    expect((await shares())[0].status).toBe("accepted");
    expect((await testDb.select().from(schema.orgs)).some((o) => o.name === "Second Try Instruments")).toBe(true);
  });

  it("refuses a company name already taken by an operator", async () => {
    const { token } = await invite();
    who = null;
    const { acceptHandoff } = await import("@/app/actions");
    const res = await acceptHandoff(token as string, { companyName: "Sierra Spectra" });
    expect(res.error).toContain("already on Ridgeline");
    // And the invitation is still open for them to try a different name.
    expect((await shares())[0].status).toBe("pending");
  });

  it("insists on a company name", async () => {
    const { res } = await accept({ companyName: "  " });
    expect(res.error).toContain("called");
  });
});

describe("whether they looked", () => {
  it("records the first open and only the first", async () => {
    // Sent-and-ignored and sent-and-read-twice are different outcomes, and the
    // difference is what decides whether somebody picks up the telephone.
    const { token } = await invite();
    const { markHandoffOpened } = await import("@/app/actions");
    await markHandoffOpened(token as string);
    const first = (await shares())[0].openedAt;
    expect(first).not.toBeNull();
    await markHandoffOpened(token as string);
    expect((await shares())[0].openedAt?.getTime()).toBe(first?.getTime());
  });

  it("shrugs at a token that is not one", async () => {
    const { markHandoffOpened } = await import("@/app/actions");
    await expect(markHandoffOpened("nope")).resolves.toBeUndefined();
  });
});
