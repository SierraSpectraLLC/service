// The bills pass, against a real database.
//
// It writes to the ledger without a human pressing anything that day, so the
// bar is the stipend pass's. The schedule arithmetic is proved in
// tests/stipends and tests/bills; what is proved here is the part a pure
// test cannot reach:
//
//   * running it twice posts once. The assertion is on the row count.
//   * what it writes is the row "Log an overhead expense" would have written
//     - no work order, not billable, dated the cycle day, carrying bill_id -
//     so the ledger, the rail and costing see it as overhead and nothing else.
//   * it catches up, oldest first, and a paused bill posts nothing.
//   * it stays inside its own workspace.
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
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); } }));

const SIERRA = 1, CASCADE = 2;
const SLOW = 30_000;
/** Shop time is Pacific; noon UTC on the 14th is the 14th everywhere. */
const NOW = new Date("2026-09-14T19:00:00Z");

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO app_settings (id) VALUES (1);
    INSERT INTO orgs (name, kind, is_operator) VALUES
      ('Sierra Spectra',     'provider', true),
      ('Cascade Instrument', 'provider', true);

    INSERT INTO bills (tenant_org_id, name, payee, kind, amount_cents, every_months, day_of_month, starts_on, active, autopay, person) VALUES
      (${SIERRA},  'Liability policy', 'The Hartford', 'Insurance', 41200, 1, 1,  '2026-07-01', true,  true,  ''),            -- 1: three months behind
      (${SIERRA},  'Health plan',      'Kaiser',       'Benefits',  62000, 1, 15, '2026-09-01', true,  false, 'Tess Nakamura'), -- 2: due the 15th, not yet
      (${SIERRA},  'Old phone line',   'Verizon',      'Phone',      9000, 1, 1,  '2026-01-01', false, true,  ''),            -- 3: paused
      (${CASCADE}, 'Their policy',     'Somebody',     'Insurance', 50000, 1, 1,  '2026-09-01', true,  true,  '');            -- 4: another shop
  `);
});

const rows = async () => testDb.select().from(schema.expenses).orderBy(schema.expenses.id);
const run = async () => (await import("@/lib/billRun")).runBills(NOW);

describe("runBills", () => {
  it("posts what is due, oldest first, as overhead rows the ledger already understands", async () => {
    const first = await run();
    // Sierra's policy owes July, August and September; Cascade's owes September.
    expect(first.posted.map((p) => [p.name, p.on])).toEqual([
      ["Liability policy", "2026-07-01"],
      ["Liability policy", "2026-08-01"],
      ["Liability policy", "2026-09-01"],
      ["Their policy", "2026-09-01"],
    ]);
    expect(first.failed).toEqual([]);

    const posted = await rows();
    expect(posted).toHaveLength(4);
    for (const r of posted) {
      expect(r.workOrderId).toBeNull();
      expect(r.billable).toBe(false);
      expect(r.reportId).toBeNull();
      expect(r.person).toBe("");
    }
    const july = posted[0];
    expect(july.tenantOrgId).toBe(SIERRA);
    expect(july.billId).toBe(1);
    expect(july.kind).toBe("Insurance");
    expect(july.amountCents).toBe(41200);
    expect(july.incurredOn).toBe("2026-07-01");
    expect(july.description).toBe("Liability policy - July 2026");
    expect(posted[3].tenantOrgId).toBe(CASCADE);
  }, SLOW);

  it("running it again writes nothing", async () => {
    const again = await run();
    expect(again.posted).toEqual([]);
    expect(await rows()).toHaveLength(4);
    const [policy] = await testDb.select().from(schema.bills).where((await import("drizzle-orm")).eq(schema.bills.id, 1));
    expect(policy.lastOn).toBe("2026-09-01");
  }, SLOW);

  it("leaves a bill that is not yet due, and a paused one, alone", async () => {
    const posted = await rows();
    expect(posted.some((r) => r.billId === 2)).toBe(false);
    expect(posted.some((r) => r.billId === 3)).toBe(false);
  }, SLOW);

  it("is what Overhead reads - and so is what Job costing never does", async () => {
    const { overheadExpense } = await import("@/lib/financeData");
    const overhead = await testDb.select({ id: schema.expenses.id }).from(schema.expenses).where(overheadExpense());
    expect(overhead).toHaveLength(4);
  }, SLOW);
});
