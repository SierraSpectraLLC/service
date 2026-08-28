// A lead in front of four shops, over real Postgres.
//
// Two guarantees that cannot be checked in the pure rules. First, the
// redaction is done by the READ - a shop that has not claimed a lead is
// handed an object built without the contact details, whatever a component
// later does with it. Second, the race has one winner, and it is settled by
// the database rather than by a check-then-write that two claims can both
// pass.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));

const { leadsFor, wasOffered } = await import("@/lib/leadData");
const { and, eq } = await import("drizzle-orm");

/** 3 = the finder. 4 and 5 = the shops it went to. 6 was never offered it. */
beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES
      (3, 'Sierra Spectra', 'provider', true),
      (4, 'Northwest Instrument Services', 'provider', true),
      (5, 'Cascade Analytical', 'provider', true),
      (6, 'Somebody Else Entirely', 'provider', true);
    SELECT setval('orgs_id_seq', 100);
    INSERT INTO leads (id, tenant_org_id, contact_name, contact_email, contact_phone,
                       org_name, address, region, blurb, systems,
                       fee_kind, fee_bps, fee_window_months, created_by)
      VALUES (1, 3, 'Dr. P. Osei', 'posei@xyzbio.test', '555-0142',
              'XYZ Biosciences', '44 Kendall St, Cambridge MA 02142',
              'Boston metro', 'No PM cover since their FSE left.',
              '[{"category":"LC-MS","model":"API 5000","count":4}]',
              'percent', 500, 12, 'joe@sierra.test');
    SELECT setval('leads_id_seq', 100);
    INSERT INTO lead_offers (lead_id, to_org_id) VALUES (1, 4), (1, 5);
  `);
});

const PRIVATE = ["contactName", "contactEmail", "contactPhone", "orgName", "address"];

describe("what a shop sees before it commits", () => {
  it("is offered the work, and not the lab", async () => {
    const { offered } = await leadsFor(4);
    expect(offered).toHaveLength(1);
    const lead = offered[0];
    expect(lead.region).toBe("Boston metro");
    expect(lead.systems[0].model).toBe("API 5000");
    expect(lead.terms.feeBps).toBe(500);
    expect(lead.fromName).toBe("Sierra Spectra");
    for (const key of PRIVATE) expect(lead).not.toHaveProperty(key);
  });

  it("cannot recover the details from what was sent over the wire", async () => {
    /*
     * The row exists in this database with a name, an address and a telephone
     * number on it. None of the three is in the object a component receives,
     * so no render, no dev-tools panel and no serialized payload can leak it.
     */
    const { offered } = await leadsFor(4);
    const wire = JSON.stringify(offered);
    expect(wire).not.toContain("XYZ Biosciences");
    expect(wire).not.toContain("Kendall");
    expect(wire).not.toContain("555-0142");
    expect(wire).not.toContain("posei@");
  });

  it("is not told how many other shops are looking at it", async () => {
    // The finder is told; a bidder who knew they were one of five would price
    // it differently, and it is not their number.
    const { offered } = await leadsFor(4);
    expect(offered[0].offeredTo).toBe(0);
  });

  it("never reaches a shop it was not offered to", async () => {
    const { mine, offered } = await leadsFor(6);
    expect(mine).toEqual([]);
    expect(offered).toEqual([]);
    expect(await wasOffered(1, 6)).toBe(false);
    expect(await wasOffered(1, 4)).toBe(true);
  });

  it("never reaches a workspace that could not be resolved", async () => {
    // A NULL is not a scope. Platform staff have no lead board.
    expect(await leadsFor(null)).toEqual({ mine: [], offered: [] });
  });
});

describe("what the finder sees", () => {
  it("keeps their own lead in full - they typed it", async () => {
    const { mine, offered } = await leadsFor(3);
    expect(offered).toEqual([]);
    expect(mine).toHaveLength(1);
    expect(mine[0].orgName).toBe("XYZ Biosciences");
    expect(mine[0].contactEmail).toBe("posei@xyzbio.test");
    expect(mine[0].open).toBe(true);
  });

  it("is told how many shops it went to", async () => {
    const { mine } = await leadsFor(3);
    expect(mine[0].offeredTo).toBe(2);
  });
});

describe("one lab, one winner", () => {
  it("settles the race in the database, not in the reader", async () => {
    /*
     * Both shops load the board, both see it open, both press claim. A
     * check-then-write passes twice and the lab gets two telephone calls; the
     * status predicate on the UPDATE means exactly one row comes back.
     */
    const claim = (orgId: number) => testDb.update(schema.leads)
      .set({ status: "claimed", claimedByOrgId: orgId, claimedAt: new Date() })
      .where(and(eq(schema.leads.id, 1), eq(schema.leads.status, "open")))
      .returning({ id: schema.leads.id });

    const [first, second] = await Promise.all([claim(4), claim(5)]);
    const won = [first, second].filter((r) => r.length > 0);
    expect(won).toHaveLength(1);

    const [row] = await testDb.select().from(schema.leads).where(eq(schema.leads.id, 1));
    expect(row.status).toBe("claimed");
    expect([4, 5]).toContain(row.claimedByOrgId);
  });

  it("gives the contact details to the shop that won, and to nobody else", async () => {
    const [row] = await testDb.select().from(schema.leads).where(eq(schema.leads.id, 1));
    const winner = row.claimedByOrgId as number;
    const loser = winner === 4 ? 5 : 4;

    const won = (await leadsFor(winner)).offered[0];
    expect(won.orgName).toBe("XYZ Biosciences");
    expect(won.contactPhone).toBe("555-0142");
    expect(won.open).toBe(true);

    const lost = (await leadsFor(loser)).offered[0];
    // Still on their board, and still says what it was - so nobody is left
    // believing they have it - but the half they did not pay for is gone.
    expect(lost.status).toBe("claimed");
    expect(lost.region).toBe("Boston metro");
    expect(lost.open).toBe(false);
    for (const key of PRIVATE) expect(lost).not.toHaveProperty(key);
  });

  it("tells the finder who took it", async () => {
    const { mine } = await leadsFor(3);
    expect(mine[0].status).toBe("claimed");
    expect(["Northwest Instrument Services", "Cascade Analytical"])
      .toContain(mine[0].claimedByName);
  });
});
