// The loader behind "Absorbed for a client": claims filed against a client
// with no job, and what their rows add up to.
//
// The pure rule is pinned in tests/absorbedSpend. This is the wiring - that
// the loader takes only the claims with a client and no job, reaches their
// rows through report_id, names the client, and stops at the tenant boundary
// like every other workspace-wide money reader.
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

const SIERRA = 1, LABZEN = 2, CASCADE = 3, RIVAL = 4;
const TODAY = "2026-08-31";
const SLOW = 30_000;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO app_settings (id) VALUES (1);
    INSERT INTO orgs (name, kind, is_operator, parent_org_id) VALUES
      ('Sierra Spectra',     'provider', true,  NULL),
      ('LabZen',             'client',   false, ${SIERRA}),
      ('Cascade Instrument', 'provider', true,  NULL),
      ('Rival Labs',         'client',   false, ${CASCADE});

    INSERT INTO work_orders (tenant_org_id, number, org_id, title, state, opened_on) VALUES
      (${SIERRA}, 'WO-0412', ${LABZEN}, 'Vacuum fault', 'closed', '2026-08-01');

    INSERT INTO expense_reports (tenant_org_id, person, title, status, org_id, work_order_id, submitted_at) VALUES
      (${SIERRA},  'Tess Nakamura', 'Turbo controller for the QE', 'paid',      ${LABZEN}, NULL, '2026-08-20'),  -- 1
      (${SIERRA},  'Tess Nakamura', 'Courier to Reno',             'submitted', ${LABZEN}, NULL, '2026-08-06'),  -- 2
      (${SIERRA},  'Tess Nakamura', 'Sent back',                   'returned',  ${LABZEN}, NULL, '2026-08-07'),  -- 3
      (${SIERRA},  'Tess Nakamura', 'On the job',                  'paid',      NULL,      1,    '2026-08-08'),  -- 4
      (${SIERRA},  'Tess Nakamura', 'Overhead',                    'paid',      NULL,      NULL, '2026-08-09'),  -- 5
      (${CASCADE}, 'Somebody Else', 'Their handshake',             'paid',      ${RIVAL},  NULL, '2026-08-10');  -- 6

    INSERT INTO expenses (tenant_org_id, report_id, kind, description, amount_cents, incurred_on) VALUES
      (${SIERRA},  1, 'other', 'Turbo controller', 42000, '2026-08-18'),
      (${SIERRA},  1, 'other', 'Shipping',          3000, '2026-08-19'),
      (${SIERRA},  2, 'other', 'Courier',           8000, '2026-08-04'),
      (${SIERRA},  2, 'other', 'Long ago',          9000, '2026-02-01'),
      (${SIERRA},  3, 'other', 'Refused',          50000, '2026-08-07'),
      (${SIERRA},  4, 'other', 'Job part',         70000, '2026-08-08'),
      (${SIERRA},  5, 'other', 'Overhead',         60000, '2026-08-09'),
      (${CASCADE}, 6, 'other', 'Theirs',           99000, '2026-08-10');
  `);
});

const board = async (days: number, tenant: number | null = SIERRA) =>
  (await import("@/lib/invoiceData")).absorbedBoard(TODAY, days, tenant);

describe("absorbedBoard", () => {
  it("adds up the claims filed against a client with no job, and nothing else", async () => {
    const b = await board(30);
    expect(b.rows.map((c) => [c.orgName, c.totalCents])).toEqual([["LabZen", 53_000]]);
    expect(b.rows[0].claims.map((k) => [k.id, k.title, k.amountCents]))
      .toEqual([[1, "Turbo controller for the QE", 45_000], [2, "Courier to Reno", 8_000]]);
  }, SLOW);

  it("widens with the window", async () => {
    const b = await board(365);
    expect(b.rows[0].totalCents).toBe(62_000);
  }, SLOW);

  it("stops at the tenant boundary", async () => {
    const theirs = await board(30, CASCADE);
    expect(theirs.rows.map((c) => [c.orgName, c.totalCents])).toEqual([["Rival Labs", 99_000]]);
  }, SLOW);
});
