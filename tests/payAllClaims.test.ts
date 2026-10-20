// Paying one person everything on the desk in one payout.
//
// The interesting failures are not arithmetic, they are who and which:
//
//   * two people's claims must never ride one payout - Bill's total and
//     Adam's are two transfers, and pooling them is a check nobody can write;
//   * a claim the travel rules flagged must stop the whole payout, not be
//     silently skipped, or the confirmation number would claim to cover money
//     it did not;
//   * every claim lands paid with the same date and confirmation number, each
//     with its own audit line, exactly as if it had been paid alone.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { payoutGroups } from "@/lib/expenseReports";

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

const ROOT = 1, SIERRA = 2, OTHER = 3;
const OWNER: Who = {
  email: "owner@sierra.test", name: "Dana Reyes", role: "owner",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: ROOT,
};
const OTHER_OWNER: Who = { ...OWNER, email: "owner@other.test", operatorOrgId: OTHER };
/** The platform's own operator: what they file carries no tenant stamp at all. */
const PLATFORM_OWNER: Who = { ...OWNER, email: "owner@ridgeline.test", operatorOrgId: ROOT };

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES
      (${ROOT}, 'Ridgeline', 'provider', true),
      (${SIERRA}, 'Sierra Spectra', 'provider', true),
      (${OTHER}, 'Other Shop', 'provider', true);
    INSERT INTO app_settings (id, operator_org_id) VALUES (1, ${ROOT});
    INSERT INTO house_members (email, org_id, role, name) VALUES
      ('owner@sierra.test', ${SIERRA}, 'owner', 'Dana Reyes'),
      ('owner@other.test',  ${OTHER},  'owner', 'Other Owner'),
      ('owner@ridgeline.test', ${ROOT}, 'owner', 'Root Owner');
  `);
});

beforeEach(async () => {
  who = OWNER;
  await client.exec(`DELETE FROM expenses; DELETE FROM expense_reports; DELETE FROM audit_log;`);
});

/** A submitted claim with one row per amount, straight into the tables. */
const claim = async (person: string, amounts: number[], opts: { flagged?: boolean; tenant?: number | null; title?: string } = {}) => {
  const tenant = opts.tenant === undefined ? SIERRA : opts.tenant;
  const r = await client.query<{ id: number }>(
    `INSERT INTO expense_reports (tenant_org_id, person, status, title)
     VALUES ($1, $2, 'submitted', $3) RETURNING id`,
    [tenant, person, opts.title ?? `${person}'s trip`],
  );
  const id = r.rows[0].id;
  for (const [i, cents] of amounts.entries()) {
    await client.query(
      `INSERT INTO expenses (tenant_org_id, report_id, kind, description, amount_cents, incurred_on, person, allowance_state)
       VALUES ($1, $2, 'Fuel', 'gas', $3, '2026-09-1${i}', $4, $5)`,
      [tenant, id, cents, person, opts.flagged && i === 0 ? "flagged" : ""],
    );
  }
  return id;
};

const reports = async () =>
  (await client.query<{ id: number; person: string; status: string; paid_on: string; paid_ref: string }>(
    `SELECT id, person, status, paid_on, paid_ref FROM expense_reports ORDER BY id`)).rows;

const payAll = async (ids: number[], person: string, reference = "CONF-88231") => {
  const { payExpenseReports } = await import("@/app/money/actions");
  return payExpenseReports(ids, { person, paidOn: "2026-10-01", reference });
};

describe("grouping the desk by person", () => {
  const r = (id: number, person: string, cents: number, flaggedCount = 0) =>
    ({ id, person, status: "submitted", flaggedCount, expenses: [{ amountCents: cents }] });

  it("never pools two people, and totals each", () => {
    const groups = payoutGroups([r(1, "Bill Harner", 4324), r(2, "Adam Cole", 1000), r(3, "Bill Harner", 1405)]);
    expect(groups.map((g) => [g.person, g.claims.map((c) => c.id), g.payableCents])).toEqual([
      ["Bill Harner", [1, 3], 5729],
      ["Adam Cole", [2], 1000],
    ]);
  });

  it("leaves a flagged claim out of the total, and says it is waiting", () => {
    const [g] = payoutGroups([r(1, "Bill Harner", 4324), r(2, "Bill Harner", 9999, 1)]);
    expect(g.payable.map((c) => c.id)).toEqual([1]);
    expect(g.payableCents).toBe(4324);
    expect(g.waiting).toBe(1);
  });
});

describe("paying everything one person is owed", () => {
  it("marks every claim paid with the one date and confirmation number", async () => {
    const a = await claim("Bill Harner", [4324]);
    const b = await claim("Bill Harner", [3000, 4250, 3100]);
    const res = await payAll([a, b], "Bill Harner");
    expect(res).toEqual({ paid: 2, cents: 4324 + 10350 });
    for (const row of await reports()) {
      expect(row).toMatchObject({ status: "paid", paid_on: "2026-10-01", paid_ref: "CONF-88231" });
    }
    // Each claim keeps its own line, and says which payout it was part of.
    const lines = (await client.query<{ entity_id: number; action: string }>(
      `SELECT entity_id, action FROM audit_log WHERE entity_type = 'expense_report' ORDER BY entity_id`)).rows;
    expect(lines.map((l) => Number(l.entity_id))).toEqual([a, b]);
    expect(lines[0].action).toContain("one payout of $146.74 covering 2 claims");
    expect(lines[0].action).toContain("CONF-88231");
  });

  it("refuses two people's claims in one payout, and pays neither", async () => {
    const bill = await claim("Bill Harner", [4324]);
    const adam = await claim("Adam Cole", [1000]);
    expect((await payAll([bill, adam], "Bill Harner")).error).toContain("not all one person's");
    expect((await reports()).every((r) => r.status === "submitted")).toBe(true);
  });

  it("refuses the whole payout when any claim has an unapproved row", async () => {
    const ok = await claim("Bill Harner", [4324]);
    const flagged = await claim("Bill Harner", [3000], { flagged: true });
    expect((await payAll([ok, flagged], "Bill Harner")).error).toContain("not been approved");
    expect((await reports()).every((r) => r.status === "submitted")).toBe(true);
  });

  it("wants the confirmation number", async () => {
    const a = await claim("Bill Harner", [4324]);
    expect((await payAll([a], "Bill Harner", "  ")).error).toContain("confirmation number");
  });

  it("refuses a claim already paid, rather than paying it twice", async () => {
    const a = await claim("Bill Harner", [4324]);
    expect((await payAll([a], "Bill Harner")).error).toBeUndefined();
    expect((await payAll([a], "Bill Harner")).error).toContain("paid, not awaiting payout");
  });

  it("cannot reach another company's claims", async () => {
    const theirs = await claim("Bill Harner", [4324], { tenant: OTHER });
    expect((await payAll([theirs], "Bill Harner")).error).toBe("Not found");
    who = OTHER_OWNER;
    const ours = await claim("Bill Harner", [4324]);
    expect((await payAll([ours], "Bill Harner")).error).toBe("Not found");
  });

  it("pays a claim with no tenant stamp - the platform operator's own", async () => {
    // Every claim the platform's own staff open is stamped null. Matching it
    // with `tenant = NULL` updated nothing: the ledger and the audit trail said
    // paid, and the claim sat on the desk awaiting payout. Both doors.
    who = PLATFORM_OWNER;
    const a = await claim("Bill Harner", [4324], { tenant: null });
    const b = await claim("Bill Harner", [1405], { tenant: null });
    const c = await claim("Bill Harner", [2380], { tenant: null });
    expect(await payAll([a, b], "Bill Harner")).toEqual({ paid: 2, cents: 5729 });
    const { payExpenseReport } = await import("@/app/money/actions");
    expect((await payExpenseReport(c, { paidOn: "2026-10-01", reference: "check 1044" })).error).toBeUndefined();
    expect((await reports()).map((r) => r.status)).toEqual(["paid", "paid", "paid"]);
  });
});
