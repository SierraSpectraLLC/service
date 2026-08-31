// Reimbursements, as the two figures they are - and the reader for the one
// "Money out" was missing.
//
// The flaw, in the shop's words: "Reimbursements should reflect money that was
// paid out, not money that is pending, right?" Right. The lane's only
// reimbursement row summed SUBMITTED reports - claims, still in the account,
// the payable half of the position - under the heading Money out. A shop that
// had reimbursed its engineers all month read as having paid nothing.
//
// paidOutFigures is the other half: reports PAID in the window, cash basis on
// paidOn - the same rule "Paid this period" applies to money in with
// receivedOn. What is pinned here is the boundary of that rule, because every
// edge is a way the two figures bleed into each other: a submitted report is
// not paid, a report paid before the window is not this period's, and another
// workspace's payout is not this shop's money at all.
//
// Real Postgres, in-process, from the same DDL every deploy applies.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));
// financeData pulls the auth stack in through lib/authz; none of it is under
// test here, and next-auth will not even import outside a Next server.
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); } }));

const SIERRA = 1, CASCADE = 2;
/** The window under test: the calendar month containing the 26th. */
const FROM = "2026-08-01";

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO app_settings (id) VALUES (1);
    INSERT INTO orgs (name, kind, is_operator, parent_org_id) VALUES
      ('Sierra Spectra', 'provider', true, NULL),
      ('Cascade Instrument', 'provider', true, NULL);

    INSERT INTO expense_reports (tenant_org_id, person, status, submitted_by, paid_on) VALUES
      (${SIERRA}, 'Bill Reyes',   'paid',      'bill@sierra.test', '2026-08-12'),  -- 1: in the window
      (${SIERRA}, 'Bill Reyes',   'paid',      'bill@sierra.test', '2026-07-28'),  -- 2: paid LAST month
      (${SIERRA}, 'Steve Jones',  'submitted', 'steve@sierra.test', ''),           -- 3: pending, not out
      (${SIERRA}, 'Steve Jones',  'draft',     '',                  ''),           -- 4: not even claimed
      (${CASCADE},'Rita Okafor',  'paid',      'rita@cascade.test', '2026-08-15'), -- 5: someone else's shop
      (${SIERRA}, 'Bill Reyes',   'returned',  'bill@sierra.test', '2026-08-05');  -- 6: paid in error, clawed back

    INSERT INTO expenses (tenant_org_id, kind, description, amount_cents, incurred_on, logged_by, report_id) VALUES
      (${SIERRA}, 'Fuel',    'Fresno round trip', 6140, '2026-08-10', 'bill@sierra.test', 1),
      (${SIERRA}, 'Meals',   'Working lunch',     3860, '2026-08-10', 'bill@sierra.test', 1),
      (${SIERRA}, 'Lodging', 'July hotel',       20000, '2026-07-20', 'bill@sierra.test', 2),
      (${SIERRA}, 'Lodging', 'Hampton Inn',      31800, '2026-08-20', 'steve@sierra.test', 3),
      (${SIERRA}, 'Fuel',    'Unclaimed pocket',  4200, '2026-08-21', 'steve@sierra.test', NULL),
      (${CASCADE},'Per diem','Their install',    50000, '2026-08-14', 'rita@cascade.test', 5),
      (${SIERRA}, 'Parking', 'Paid then disputed', 7700, '2026-08-02', 'bill@sierra.test', 6);
  `);
});

describe("what counts as paid out", () => {
  it("sums the reports paid inside the window, and only those", async () => {
    const { paidOutFigures } = await import("@/lib/financeData");
    const out = await paidOutFigures(SIERRA, FROM);
    // Report 1 alone: $61.40 + $38.60. Not July's payout, not the submitted
    // claim, not the draft, not the pocket expense on no report at all.
    expect(out).toEqual({ reimbursedCents: 10000, reimbursedReports: 1 });
  });

  it("counts by when it was PAID, not when it was spent", async () => {
    // Cash basis. Widen the window to July and July's payout joins - the
    // spend dates never entered into it.
    const { paidOutFigures } = await import("@/lib/financeData");
    const out = await paidOutFigures(SIERRA, "2026-07-01");
    expect(out).toEqual({ reimbursedCents: 30000, reimbursedReports: 2 });
  });

  it("never counts a report that is not in the paid state", async () => {
    /*
     * The two figures must stay disjoint or the lane double-counts: the same
     * $318 hotel would sit in "awaiting payout" and in "paid out" at once.
     * And the DATE alone cannot police this - report 6 wears an in-window
     * paidOn from a payout that was clawed back, and only its status says the
     * money came home. Filtering on paidOn >= from without the status check
     * passes every other test in this file and still counts it.
     */
    const { paidOutFigures, spendFigures } = await import("@/lib/financeData");
    const [paid, pending] = await Promise.all([
      paidOutFigures(SIERRA, FROM), spendFigures(SIERRA),
    ]);
    expect(pending.reimbursementsCents).toBe(31800);
    expect(paid.reimbursedCents).toBe(10000);
  });

  it("does not read another workspace's payouts", async () => {
    const { paidOutFigures } = await import("@/lib/financeData");
    expect((await paidOutFigures(SIERRA, FROM)).reimbursedCents).toBe(10000);
    expect((await paidOutFigures(CASCADE, FROM)).reimbursedCents).toBe(50000);
  });

  it("says zero plainly when nothing left the building", async () => {
    const { paidOutFigures } = await import("@/lib/financeData");
    expect(await paidOutFigures(SIERRA, "2026-09-01"))
      .toEqual({ reimbursedCents: 0, reimbursedReports: 0 });
  });
});
