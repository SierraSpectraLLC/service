// Offering a client blind, through the real action.
//
// Redaction reached the payload and stopped there. The covering note travelled
// beside it untouched - onto the recipient's screen and into the notification
// email - so a sender who was told the name would be held back had it
// forwarded on their behalf. These hold the door shut at the action, which is
// where it has to hold: the form's warning is a courtesy, and shareClient is
// reachable from anything holding a session.
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
/** What actually went out, so a blinded email can be read back. */
const sent: { clientName: string; summary: string; note: string }[] = [];

vi.mock("@/db", () => ({ db: testDb }));
vi.mock("@/auth", () => ({ auth: async () => (who ? { user: who } : null) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));

const JOE: Who = {
  email: "joe@sierra.test", name: "Joe", role: "owner",
  orgId: 3, operatorOrgId: 3, rootOperatorOrgId: 3,
};

/* 3 = Sierra Spectra, 4 = the shop it goes to, 7 = Emery Pharma, Sierra's client. */
beforeAll(async () => {
  const notify = await import("@/lib/notify");
  vi.spyOn(notify, "notifyClientShared").mockImplementation(async (o) => {
    sent.push({ clientName: o.clientName, summary: o.summary, note: o.note });
  });

  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES
      (3, 'Sierra Spectra', 'provider', true),
      (4, 'Northwest Instrument Services', 'provider', true);
    INSERT INTO orgs (id, name, kind, parent_org_id) VALUES (7, 'Emery Pharma', 'client', 3);
    SELECT setval('orgs_id_seq', 100);
    INSERT INTO provider_links (tenant_org_id, provider_org_id) VALUES (3, 4);
    INSERT INTO org_sites (org_id, tenant_org_id, name, address, contact_name, contact_phone, contact_email)
      VALUES (7, 3, 'Hayward', '2000 Sample Way, Hayward CA 94544', 'R. Diaz', '555-0100', 'rd@emery.test');
    INSERT INTO instruments (external_id, client, model, category, owner_org_id, tenant_org_id)
      VALUES ('EP-001', 'Emery Pharma', '6495C', 'LC-MS', 7, 3);
  `);
});

beforeEach(async () => {
  who = JOE;
  sent.length = 0;
  await client.exec(`DELETE FROM client_shares;`);
});

const FEE = {
  kind: "flat", feeCents: 200_000, feeBps: 0, windowMonths: 12,
  minCents: 0, maxCents: 0, note: "",
};
const share = async (over: Record<string, unknown> = {}) => {
  const { shareClient } = await import("@/app/actions");
  return shareClient(7, { toOrgIds: [4], note: "", terms: FEE, ...over } as never);
};

describe("a note that gives the client away", () => {
  it("is refused, and nothing is offered", async () => {
    const res = await share({ note: "Emery Pharma want the Hayward LC-MS covered" });
    expect(res.error).toContain("Emery Pharma");
    expect(await testDb.select().from(schema.clientShares)).toHaveLength(0);
    // And no email either - a refusal that had already sent one would be worse
    // than no check at all.
    expect(sent).toEqual([]);
  });

  it("is refused for a contact, a number or a door, not just the name", async () => {
    expect((await share({ note: "ask for R. Diaz on arrival" })).error).toContain("R. Diaz");
    expect((await share({ note: "ring 555-0100 first" })).error).toContain("555-0100");
    expect((await share({ note: "it is the one on 2000 Sample Way" })).error)
      .toContain("2000 Sample Way");
  });

  it("lets an honest note through", async () => {
    const res = await share({ note: "you take the second site, we keep the first" });
    expect(res.error).toBeUndefined();
    expect(res.sent).toBe(1);
  });

  it("allows the name once the sender turns blinding off, because that is a decision", async () => {
    /*
     * The escape hatch matters. Refusing outright would make a plain
     * introduction - which is a perfectly normal thing to send - impossible.
     * Unticking is deliberate; the default was not.
     */
    const res = await share({ blind: false, note: "Emery Pharma, as discussed" });
    expect(res.error).toBeUndefined();
    expect(sent[0].clientName).toBe("Emery Pharma");
  });
});

describe("what the notification carries", () => {
  it("names no client while the offer is blind", async () => {
    // The email is the one place nobody thinks to check, and these get
    // forwarded. It has to be as blind as the screen.
    await share({ note: "two systems, one site, straightforward" });
    expect(sent).toHaveLength(1);
    expect(sent[0].clientName).toBe("a client");
    expect(sent[0].summary).not.toContain("Emery");
    expect(sent[0].summary).toContain("in CA");
    expect(JSON.stringify(sent[0])).not.toContain("Sample Way");
    expect(JSON.stringify(sent[0])).not.toContain("rd@emery.test");
  });

  it("blinds by default the moment there is a fee to protect", async () => {
    await share({ note: "" });
    expect(sent[0].clientName).toBe("a client");
    expect((await testDb.select().from(schema.clientShares))[0].blind).toBe(true);
  });

  it("leaves a free introduction alone - there is nothing to go around", async () => {
    await share({ terms: { ...FEE, kind: "none" }, note: "" });
    expect(sent[0].clientName).toBe("Emery Pharma");
    expect((await testDb.select().from(schema.clientShares))[0].blind).toBe(false);
  });
});
