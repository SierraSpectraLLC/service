// What actually lands when a quote is saved.
//
// The form half is tests/agreementKinds. This is the other half, and the one
// that matters after somebody CHANGES a kind: a contract with a $5,000 parts
// allowance, four visits and forty hours, switched to Quote and saved.
//
// Hiding the boxes is not enough. A number left behind in a column nobody can
// see is a number nobody can correct, and these columns are read - drawdown,
// the coverage card, the client's own page all sum them. So cleanAgreement
// zeroes what the kind does not have, the same way it already zeroes a cap
// when unlimited is ticked.
//
// Real Postgres, in-process, from the same DDL every deploy applies.
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
  orgId: number | null; operatorOrgId: number | null; rootOperatorOrgId: number | null;
};
let who: Who;
vi.mock("@/auth", () => ({ auth: async () => ({ user: who }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const ROOT = 1, SIERRA = 2, FEDERON = 3;

const OWNER: Who = {
  email: "joe@sierra.test", name: "Joe Vincent", role: "owner",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: ROOT,
};

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator, parent_org_id) VALUES
      (${ROOT},    'Ridgeline',      'provider', true,  NULL),
      (${SIERRA},  'Sierra Spectra', 'provider', true,  NULL),
      (${FEDERON}, 'Federon',        'client',   false, ${SIERRA});
    INSERT INTO app_settings (id, operator_org_id) VALUES (1, ${ROOT});
    INSERT INTO house_members (email, org_id, role, name) VALUES
      ('joe@sierra.test', ${SIERRA}, 'owner', 'Joe Vincent');
  `);
});

beforeEach(async () => {
  who = OWNER;
  await client.exec(`DELETE FROM agreements; DELETE FROM audit_log;`);
});

/** Everything filled in, the way a full-service contract is. */
const FULL = {
  number: "SS-AC-9", title: "Annual service contract", status: "active",
  startsOn: "2026-03-01", endsOn: "2027-02-28", renewNoticeDays: "60",
  visitsIncluded: "4", partsAllowance: "5000", laborIncludedHours: "40",
  partsUnlimited: false, visitsUnlimited: false, laborUnlimited: false,
  pmPartsIncluded: true, includedKits: [{ partNumber: "G1960-60101", name: "Source kit", qty: 2 }],
  hourlyRate: "150", instrumentIds: [], value: "18000", note: "",
};

const saved = async () => (await testDb.select().from(schema.agreements))[0]!;

describe("saving one kind of paper", () => {
  it("keeps every entitlement on a contract", async () => {
    const { addAgreement } = await import("@/app/actions");
    expect(await addAgreement(FEDERON, { ...FULL, kind: "contract" })).not.toHaveProperty("error");
    const a = await saved();
    expect(a.visitsIncluded).toBe(4);
    expect(a.partsAllowanceCents).toBe(500000);
    expect(a.laborIncludedMinutes).toBe(2400);
    expect(a.hourlyRateCents).toBe(15000);
    expect(a.pmPartsIncluded).toBe(true);
    expect(a.includedKits).toContain("G1960-60101");
    expect(a.renewNoticeDays).toBe(60);
    expect(a.valueCents).toBe(1800000);
  });

  it("lands a quote with no entitlements, whatever the draft was carrying", async () => {
    /*
     * The kind-change case, sent through with every entitlement field set -
     * exactly what a draft holds a moment after somebody clicks Quote on a
     * contract they had half typed. None of it may reach the row: drawdown,
     * the coverage card and the client's page all sum these columns, and a
     * quote reporting "4 visits included" is a promise nobody made.
     */
    const { addAgreement } = await import("@/app/actions");
    await addAgreement(FEDERON, { ...FULL, kind: "quote" });
    const a = await saved();
    expect(a.visitsIncluded).toBe(0);
    expect(a.partsAllowanceCents).toBe(0);
    expect(a.laborIncludedMinutes).toBe(0);
    expect(a.hourlyRateCents).toBeNull();
    expect(a.pmPartsIncluded).toBe(false);
    expect(a.includedKits).toBe("");
  });

  it("drops the unlimited flags too, not just the caps", async () => {
    // Unlimited is the louder claim of the two: a quote flagged unlimited
    // parts reads on the coverage card as a contract that covers everything.
    const { addAgreement } = await import("@/app/actions");
    await addAgreement(FEDERON, {
      ...FULL, kind: "po", partsUnlimited: true, visitsUnlimited: true, laborUnlimited: true,
    });
    const a = await saved();
    expect([a.partsUnlimited, a.visitsUnlimited, a.laborUnlimited]).toEqual([false, false, false]);
  });

  it("keeps the amount and the dates on every kind", async () => {
    // The figure is the thing all four have. Losing it would be a worse bug
    // than the one being fixed.
    const { addAgreement } = await import("@/app/actions");
    for (const kind of ["po", "quote", "invoice"]) {
      await client.exec(`DELETE FROM agreements;`);
      await addAgreement(FEDERON, { ...FULL, kind });
      const a = await saved();
      expect(`${kind}: ${a.valueCents}`).toBe(`${kind}: 1800000`);
      expect(`${kind}: ${a.startsOn}`).toBe(`${kind}: 2026-03-01`);
      expect(`${kind}: ${a.endsOn}`).toBe(`${kind}: 2027-02-28`);
    }
  });

  it("zeroes the renewal notice on an invoice, which does not lapse", async () => {
    /*
     * renewNoticeDays defaults to 60, and `standing` reads it: left at 60 on a
     * kind whose form no longer shows the field, an invoice would start
     * reporting "Up for renewal" sixty days before its due date - driven by a
     * number nobody can see, about an event that does not happen.
     */
    const { addAgreement } = await import("@/app/actions");
    await addAgreement(FEDERON, { ...FULL, kind: "invoice" });
    expect((await saved()).renewNoticeDays).toBe(0);

    await client.exec(`DELETE FROM agreements;`);
    await addAgreement(FEDERON, { ...FULL, kind: "quote" });
    expect((await saved()).renewNoticeDays).toBe(60);   // a quote does lapse
  });
});
