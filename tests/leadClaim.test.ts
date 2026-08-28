// Claiming a lead, through the real actions.
//
// The half a pure test cannot reach: a claim is a RACE and a SALE at once, so
// what these hold down is that exactly one shop wins it, that winning produces
// the fee on the same ledger a handover's fee lands on, and that a percentage
// with no client attached never quietly measures itself against the winner's
// whole book.
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

/** 3 = the finder, 4 and 5 = the shops it goes to. */
const JOE: Who = {
  email: "joe@sierra.test", name: "Joe", role: "owner",
  orgId: 3, operatorOrgId: 3, rootOperatorOrgId: 3,
};
const DANA: Who = {
  email: "dana@nwis.test", name: "Dana", role: "owner",
  orgId: 4, operatorOrgId: 4, rootOperatorOrgId: 4,
};
const CASS: Who = {
  email: "cass@cascade.test", name: "Cass", role: "owner",
  orgId: 5, operatorOrgId: 5, rootOperatorOrgId: 5,
};

const LEAD = {
  contactName: "Dr. P. Osei", contactEmail: "posei@xyzbio.test", contactPhone: "555-0142",
  orgName: "XYZ Biosciences", address: "44 Kendall St, Cambridge MA 02142",
  region: "Boston metro", blurb: "No PM cover since their FSE left.",
  systems: [{ category: "LC-MS", model: "API 5000", count: 4 }],
};
const EITHER = {
  kind: "either", feeCents: 200_000, feeBps: 500, windowMonths: 12,
  minCents: 0, maxCents: 0, note: "",
};

const RESET = `
  DELETE FROM referral_fees; DELETE FROM lead_offers; DELETE FROM leads;
  DELETE FROM invoice_lines; DELETE FROM invoices;
  DELETE FROM orgs WHERE id > 5;
`;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES
      (3, 'Sierra Spectra', 'provider', true),
      (4, 'Northwest Instrument Services', 'provider', true),
      (5, 'Cascade Analytical', 'provider', true);
    SELECT setval('orgs_id_seq', 100);
    -- Joe has both shops on his own list; a lead goes to shops you have added,
    -- never to the instance.
    INSERT INTO provider_links (tenant_org_id, provider_org_id) VALUES (3, 4), (3, 5);
  `);
});

beforeEach(async () => { who = null; await client.exec(RESET); });

const post = async (over: Record<string, unknown> = {}) => {
  who = JOE;
  const { postLead } = await import("@/app/actions");
  return postLead({ ...LEAD, terms: EITHER, toOrgIds: [4, 5], ...over } as never);
};
const fees = async () => testDb.select().from(schema.referralFees);

describe("offering it", () => {
  it("goes only to the shops that were picked", async () => {
    const res = await post();
    expect(res.error).toBeUndefined();
    expect(res.sent).toBe(2);
    const offers = await testDb.select().from(schema.leadOffers);
    expect(offers.map((o) => o.toOrgId).sort()).toEqual([4, 5]);
  });

  it("refuses a shop the finder has not added, however the id arrived", async () => {
    /*
     * A picker is not a permission. The action re-checks against provider_links
     * because this one posts a third party's telephone number into somebody
     * else's workspace, and the id comes off the wire.
     */
    const res = await post({ toOrgIds: [99] });
    expect(res.error).toContain("Pick who to offer it to");
    expect(await testDb.select().from(schema.leads)).toHaveLength(0);
  });

  it("refuses one nobody could act on", async () => {
    expect((await post({ contactEmail: "", contactPhone: "" })).error).toContain("email or a phone");
    expect((await post({ region: "" })).error).toContain("where it is");
    expect((await post({ terms: { ...EITHER, kind: "none" } })).error).toContain("finder's fee");
  });
});

describe("taking it", () => {
  it("gives it to the first shop and turns the second away", async () => {
    await post();
    const { claimLead } = await import("@/app/actions");
    const [lead] = await testDb.select().from(schema.leads);

    who = DANA;
    expect(await claimLead(lead.id, "flat")).toEqual({ claimed: true });
    who = CASS;
    expect((await claimLead(lead.id, "flat")).error).toContain("already taken");

    const [after] = await testDb.select().from(schema.leads);
    expect(after.claimedByOrgId).toBe(4);
    expect(after.claimedBy).toBe("dana@nwis.test");
  });

  it("never lets the finder claim their own", async () => {
    /*
     * "Not found" rather than "that is yours": a lead is only claimable off
     * your own offers list, and the finder was never on it - linkProvider
     * refuses your own workspace, so nobody can offer a lead to themselves.
     * lib/lead's own-lead guard sits behind this one as defence in depth.
     */
    await post();
    const [lead] = await testDb.select().from(schema.leads);
    who = JOE;
    const { claimLead } = await import("@/app/actions");
    expect((await claimLead(lead.id, "flat")).error).toBe("Not found");
    expect((await testDb.select().from(schema.leads))[0].status).toBe("open");
  });

  it("never lets a shop it was not offered to take it", async () => {
    await post({ toOrgIds: [4] });
    const [lead] = await testDb.select().from(schema.leads);
    who = CASS;
    const { claimLead } = await import("@/app/actions");
    expect((await claimLead(lead.id, "flat")).error).toBe("Not found");
    expect((await testDb.select().from(schema.leads))[0].status).toBe("open");
  });

  it("refuses an either/or claimed without saying which, and leaves it open", async () => {
    /*
     * Settled before the claim on purpose. A claim that could not produce a
     * fee would hand over the name and the telephone number and leave the
     * finder holding an agreement of no agreed shape.
     */
    await post();
    const [lead] = await testDb.select().from(schema.leads);
    who = DANA;
    const { claimLead } = await import("@/app/actions");
    expect((await claimLead(lead.id, "")).error).toContain("which of the two");
    expect((await testDb.select().from(schema.leads))[0].status).toBe("open");
    expect(await fees()).toHaveLength(0);
  });
});

describe("the fee it raises", () => {
  it("lands on the same ledger a handover's fee lands on", async () => {
    await post();
    const [lead] = await testDb.select().from(schema.leads);
    who = DANA;
    const { claimLead } = await import("@/app/actions");
    await claimLead(lead.id, "flat");

    const [fee] = await fees();
    expect(fee.leadId).toBe(lead.id);
    expect(fee.shareId).toBeNull();          // a lead's fee has no handover
    expect(fee.payeeOrgId).toBe(3);
    expect(fee.payerOrgId).toBe(4);
    // The payee's receivable, so the payee's stamp - same rule as a share's.
    expect(fee.tenantOrgId).toBe(3);
    expect(fee.kind).toBe("flat");
    expect(fee.feeCents).toBe(200_000);
  });

  it("names itself off the lead, so the ledger can say who it is for", async () => {
    // Not copied into a note. leadId already says where the fee came from, and
    // a name copied at claim time would go stale the moment either side
    // corrected the spelling.
    await post();
    const [lead] = await testDb.select().from(schema.leads);
    who = DANA;
    const { claimLead } = await import("@/app/actions");
    await claimLead(lead.id, "flat");

    const { feesFor } = await import("@/lib/referralData");
    expect((await feesFor(4)).owed[0].clientName).toBe("XYZ Biosciences");
    expect((await feesFor(3)).earned[0].clientName).toBe("XYZ Biosciences");
    expect((await feesFor(4)).owed[0].leadId).toBe(lead.id);
  });

  it("records whichever of the two they took, not the offer", async () => {
    // "Either" is only ever an offer. What lands is the one they picked, so
    // nothing downstream carries a choice that was already made.
    await post();
    const [lead] = await testDb.select().from(schema.leads);
    who = DANA;
    const { claimLead } = await import("@/app/actions");
    await claimLead(lead.id, "percent");

    const [fee] = await fees();
    expect(fee.kind).toBe("percent");
    expect(fee.feeBps).toBe(500);
    expect(fee.feeCents).toBe(0);
    expect(fee.endsOn).not.toBe("");         // a percent has a window; a flat does not
  });

  it("starts pointing at no client, because there is not one yet", async () => {
    /*
     * A handover names the client as it accepts, because accepting CREATES it.
     * A lead names nobody - the winner has a phone number and has to go and
     * win the work.
     */
    await post();
    const [lead] = await testDb.select().from(schema.leads);
    who = DANA;
    const { claimLead } = await import("@/app/actions");
    await claimLead(lead.id, "percent");
    expect((await fees())[0].clientOrgId).toBeNull();
  });
});

describe("pointing the fee at a client", () => {
  const claim = async () => {
    await post();
    const [lead] = await testDb.select().from(schema.leads);
    who = DANA;
    const { claimLead } = await import("@/app/actions");
    await claimLead(lead.id, "percent");
    return (await fees())[0];
  };

  it("refuses to compute a percentage against nothing", async () => {
    /*
     * The dangerous case. billedForFee is scoped by client organization, and a
     * confident zero written over a figure the payer had reported is worse
     * than no button at all.
     */
    const fee = await claim();
    const { recomputeReferralFee } = await import("@/app/actions");
    who = DANA;
    expect((await recomputeReferralFee(fee.id)).error).toContain("Point this fee at the client");
  });

  it("takes the payer's own client, and then computes", async () => {
    const fee = await claim();
    const { linkFeeClient, recomputeReferralFee } = await import("@/app/actions");
    who = DANA;
    const [xyz] = await testDb.insert(schema.orgs)
      .values({ name: "XYZ Biosciences", kind: "client", parentOrgId: 4 }).returning();
    expect(await linkFeeClient(fee.id, xyz.id)).toEqual({});

    const [inv] = await testDb.insert(schema.invoices).values({
      number: "INV-1", orgId: xyz.id, tenantOrgId: 4, status: "sent",
      issuedOn: (await fees())[0].startsOn, dueOn: "2027-01-01",
    }).returning();
    await testDb.insert(schema.invoiceLines).values({
      invoiceId: inv.id, description: "PM", qty: 1000, unitCents: 4_800_000,
    });
    expect(await recomputeReferralFee(fee.id)).toEqual({ billed: 4_800_000 });
    expect((await fees())[0].billedCents).toBe(4_800_000);
  });

  it("never lets the payee choose what their own percentage is measured on", async () => {
    // Picking which of somebody else's clients the percentage is taken of is
    // picking the number you are paid.
    const fee = await claim();
    const [xyz] = await testDb.insert(schema.orgs)
      .values({ name: "XYZ Biosciences", kind: "client", parentOrgId: 4 }).returning();
    const { linkFeeClient } = await import("@/app/actions");
    who = JOE;
    expect((await linkFeeClient(fee.id, xyz.id)).error).toBe("Not found");
    expect((await fees())[0].clientOrgId).toBeNull();
  });

  it("never takes another workspace's client", async () => {
    const fee = await claim();
    const [theirs] = await testDb.insert(schema.orgs)
      .values({ name: "Somebody Else's Lab", kind: "client", parentOrgId: 5 }).returning();
    const { linkFeeClient } = await import("@/app/actions");
    who = DANA;
    expect((await linkFeeClient(fee.id, theirs.id)).error).toContain("not one of your clients");
    expect((await fees())[0].clientOrgId).toBeNull();
  });
});

describe("pulling it back", () => {
  it("lets the finder withdraw it while nobody has it", async () => {
    await post();
    const [lead] = await testDb.select().from(schema.leads);
    who = JOE;
    const { withdrawLead } = await import("@/app/actions");
    expect(await withdrawLead(lead.id)).toEqual({});
    expect((await testDb.select().from(schema.leads))[0].status).toBe("withdrawn");
  });

  it("will not withdraw one somebody has already taken", async () => {
    await post();
    const [lead] = await testDb.select().from(schema.leads);
    who = DANA;
    const { claimLead, withdrawLead } = await import("@/app/actions");
    await claimLead(lead.id, "flat");
    who = JOE;
    expect((await withdrawLead(lead.id)).error).toContain("already taken");
  });

  it("will not let another shop withdraw somebody else's lead", async () => {
    await post();
    const [lead] = await testDb.select().from(schema.leads);
    who = DANA;
    const { withdrawLead } = await import("@/app/actions");
    expect((await withdrawLead(lead.id)).error).toBe("Not found");
    expect((await testDb.select().from(schema.leads))[0].status).toBe("open");
  });
});
