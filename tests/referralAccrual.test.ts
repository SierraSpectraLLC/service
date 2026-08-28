// What a percentage referral fee is a percentage OF.
//
// The number lives in the PAYER's database and the referrer never sees the
// rows it came from - so the whole arrangement rests on this sum being right
// and being narrow. Four ways it could be wrong, all of them expensive:
// counting another workspace's invoices, counting the payer's other clients,
// counting work outside the window, and counting paper that was never sent.
//
// Real Postgres, in-process PGlite from the same drizzle/schema-sync.sql every
// deploy applies, because every one of those is a WHERE clause.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

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

const { billedForFee } = await import("@/lib/referralData");
const { accruedCents } = await import("@/lib/referral");

/** 3 = Sierra, the referrer. 4 = Northwest, who accepted and now bills. */
const FEE = {
  payerOrgId: 4, clientOrgId: 40, startsOn: "2026-08-28", endsOn: "2027-08-27",
};

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES
      (3, 'Sierra Spectra', 'provider', true),
      (4, 'Northwest Instrument Services', 'provider', true);
    INSERT INTO orgs (id, name, kind, parent_org_id) VALUES
      (40, 'Emery Pharma', 'client', 4),        -- Northwest's copy
      (41, 'Somebody Else', 'client', 4),       -- another of Northwest's clients
      (42, 'Emery Pharma (ours)', 'client', 3); -- Sierra's own
    SELECT setval('orgs_id_seq', 100);

    INSERT INTO invoices (id, tenant_org_id, org_id, number, status, issued_on) VALUES
      -- Northwest, this client, inside the window: counts.
      (1, 4, 40, 'NW-1', 'sent',    '2026-10-01'),
      (2, 4, 40, 'NW-2', 'paid',    '2027-03-01'),
      -- Not sent: a draft is a thing somebody is still writing.
      (3, 4, 40, 'NW-3', 'draft',   '2026-11-01'),
      -- Cancelled: nobody was asked for this money.
      (4, 4, 40, 'NW-4', 'void',    '2026-11-02'),
      -- After the window closed: year two is not a twelve-month deal.
      (5, 4, 40, 'NW-5', 'sent',    '2027-10-01'),
      -- Northwest's OTHER client: not this referral's work.
      (6, 4, 41, 'NW-6', 'sent',    '2026-12-01'),
      -- SIERRA's own invoice to their own Emery. Another workspace entirely.
      (7, 3, 42, 'SS-1', 'sent',    '2026-12-01');
    SELECT setval('invoices_id_seq', 100);

    INSERT INTO invoice_lines (invoice_id, kind, description, qty, unit_cents, covered) VALUES
      (1, 'labor',    'PM visit',   8000, 15000, false),   -- 8 h x $150 = $1,200
      (1, 'part',     'Kit',        1000, 62000, false),   -- $620
      -- Covered by a contract: it prices at zero on the invoice, so it is not
      -- money asked for and must not be money a fee is taken of.
      (1, 'part',     'Under contract', 1000, 99900, true),
      (2, 'labor',    'Repair',     4000, 15000, false),   -- $600
      (3, 'labor',    'Draft work', 9000, 15000, false),
      (4, 'labor',    'Cancelled',  9000, 15000, false),
      (5, 'labor',    'Year two',   9000, 15000, false),
      (6, 'labor',    'Other client', 9000, 15000, false),
      (7, 'labor',    'Our own work', 9000, 15000, false);
  `);
});

describe("what the percentage is taken of", () => {
  it("sums only this payer, this client, this window, and paper that went out", async () => {
    // $1,200 + $620 from NW-1, $600 from NW-2. Nothing else qualifies.
    expect(await billedForFee(FEE)).toBe(120_000 + 62_000 + 60_000);
  });

  it("ignores a line the client's contract already paid for", async () => {
    // A covered line prices at zero on the invoice itself; charging a referral
    // fee on it would be a fee on money nobody was asked for.
    const billed = await billedForFee(FEE);
    expect(billed).toBeLessThan(120_000 + 62_000 + 60_000 + 99_900);
  });

  it("never reaches into the referrer's own workspace", async () => {
    /*
     * Sierra has their own Emery Pharma and their own invoices to it. A sum
     * that crossed the tenant line would have the referrer earning a
     * commission on their own work.
     */
    const asIfUnscoped = await billedForFee({ ...FEE, payerOrgId: 3, clientOrgId: 42 });
    expect(asIfUnscoped).toBe(135_000);           // Sierra's own, read as Sierra
    expect(await billedForFee(FEE)).toBe(242_000); // unchanged by its existence
  });

  it("is zero, not an error, before anybody has billed anything", async () => {
    expect(await billedForFee({ ...FEE, clientOrgId: 41, startsOn: "2030-01-01", endsOn: "2030-12-31" }))
      .toBe(0);
    // A share with no client behind it can accrue nothing at all.
    expect(await billedForFee({ ...FEE, clientOrgId: null })).toBe(0);
  });

  it("turns into the fee by the rule the ledger prints", async () => {
    const billed = await billedForFee(FEE);
    expect(accruedCents({
      kind: "percent", feeCents: 0, feeBps: 500, startsOn: FEE.startsOn, endsOn: FEE.endsOn,
      billedCents: billed, billedFrom: "invoices", paidCents: 0, status: "open",
    })).toBe(Math.round(billed * 0.05));
  });
});
