// Which expense rows are overhead, now that a claim can name a client.
//
// The bug, in the shop's words: a plug bought for LabZen on a handshake showed
// under Reimbursements (right - Bill is owed for it) AND under Overhead as
// $24 of running cost. It is not a running cost; it is what the shop absorbed
// for LabZen, and Job costing counts it there. What is pinned here is the
// boundary: a claim with no client is still overhead, a job's expense never
// was, and a claim that names a client is neither.
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

const SIERRA = 1, LABZEN = 2;
const SLOW = 30_000;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO app_settings (id) VALUES (1);
    INSERT INTO orgs (name, kind, is_operator, parent_org_id) VALUES
      ('Sierra Spectra', 'provider', true,  NULL),
      ('LabZen',         'client',   false, ${SIERRA});

    INSERT INTO work_orders (tenant_org_id, number, org_id, title, state, opened_on) VALUES
      (${SIERRA}, 'WO-0412', ${LABZEN}, 'Vacuum fault', 'closed', '2026-08-01');

    INSERT INTO expense_reports (tenant_org_id, person, title, status, org_id, work_order_id, submitted_at) VALUES
      (${SIERRA}, 'Bill Harner', 'Plug for the shop',  'submitted', NULL,      NULL, '2026-09-14'),  -- 1: overhead, claimed
      (${SIERRA}, 'Bill Harner', '15A plug for SQD',   'submitted', ${LABZEN}, NULL, '2026-09-14');  -- 2: absorbed for LabZen

    INSERT INTO expenses (tenant_org_id, report_id, work_order_id, kind, description, amount_cents, incurred_on) VALUES
      (${SIERRA}, NULL, NULL, 'other', 'Internet, August',  8999, '2026-09-01'),  -- 1: plain overhead
      (${SIERRA}, 1,    NULL, 'other', 'Plug for the shop', 2380, '2026-09-14'),  -- 2: overhead, on a claim
      (${SIERRA}, 2,    NULL, 'other', '15A plug for SQD',  2380, '2026-09-14'),  -- 3: a client's, on a claim
      (${SIERRA}, NULL, 1,    'other', 'Job part',          7000, '2026-08-08');  -- 4: a job's
  `);
});

describe("overheadExpense", () => {
  it("keeps the running costs and the claim with no client, and drops the job's and the client's", async () => {
    const { overheadExpense } = await import("@/lib/financeData");
    const rows = await testDb.select({ id: schema.expenses.id }).from(schema.expenses)
      .where(overheadExpense()).orderBy(schema.expenses.id);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  }, SLOW);

});
