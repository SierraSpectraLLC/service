// The loader behind "By maintenance": completed PMs, and what their parts cost.
//
// The pure attribution rule is pinned in tests/pmCosting. This is the wiring -
// that the loader finds a completed PM at all (a Done task carrying a schedule
// id, which is a shape costingBoard has never looked at), reaches its parts
// through pm_schedule_id, and stops at the tenant boundary like every other
// workspace-wide money reader.
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
// invoiceData pulls the auth stack in through its neighbours; none of it is
// under test here, and next-auth will not import outside a Next server.
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const SIERRA = 1, PUGET = 2, CASCADE = 3;
const TODAY = "2026-08-31";

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO app_settings (id) VALUES (1);
    INSERT INTO orgs (name, kind, is_operator, parent_org_id) VALUES
      ('Sierra Spectra',      'provider', true,  NULL),
      ('Puget Diagnostics',   'client',   false, NULL),
      ('Cascade Instrument',  'provider', true,  NULL);

    INSERT INTO instruments (tenant_org_id, external_id, client, model, name, owner_org_id) VALUES
      (${SIERRA},  'T-001', 'Puget', 'LCMS-8050', 'Puget MS bench', ${PUGET}),
      (${CASCADE}, 'C-001', 'Someone else', 'GCMS-QP2020', '', NULL);

    INSERT INTO work_orders (tenant_org_id, number, instrument_id, org_id, title, state, opened_on) VALUES
      (${SIERRA}, 'WO-0412', 1, ${PUGET}, 'Vacuum fault', 'closed', '2026-08-01');

    -- Schedule 1: quarterly, three completions. Schedule 2: took no parts.
    INSERT INTO pm_schedules (tenant_org_id, instrument_id, title, every_days, next_due) VALUES
      (${SIERRA},  1, 'Quarterly source clean', 91, '2026-11-13'),
      (${SIERRA},  1, 'Annual leak check',     365, '2027-08-14'),
      (${CASCADE}, 2, 'Quarterly source clean', 91, '2026-11-13');

    INSERT INTO tasks (tenant_org_id, instrument_id, title, state, origin, pm_schedule_id, completed_at) VALUES
      (${SIERRA},  1, 'Quarterly source clean', 'Done',  'pm', 1, '2026-02-10'),  -- 1
      (${SIERRA},  1, 'Quarterly source clean', 'Done',  'pm', 1, '2026-05-12'),  -- 2
      (${SIERRA},  1, 'Quarterly source clean', 'Done',  'pm', 1, '2026-08-14'),  -- 3
      (${SIERRA},  1, 'Annual leak check',      'Done',  'pm', 2, '2026-08-20'),  -- 4: no parts
      (${SIERRA},  1, 'Quarterly source clean', 'Open',  'pm', 1, NULL),          -- 5: not done
      (${SIERRA},  1, 'Rebuild the roughing pump', 'Done', '',  NULL, '2026-08-18'), -- 6: not a PM
      (${CASCADE}, 2, 'Quarterly source clean', 'Done',  'pm', 3, '2026-08-15');  -- 7: another shop

    INSERT INTO parts
      (instrument_id, kind, name, cost, cost_cents, status, installed_at, pm_schedule_id, work_order_id) VALUES
      -- The August visit: a kit, its four contents at zero, and a loose seal.
      (1, 'kit',  'Source maintenance kit', '$1,200.00', 120000, 'Installed', '2026-08-14', 1, NULL),
      (1, 'part', 'Cone',      '', 0,     'Installed', '2026-08-14', 1, NULL),
      (1, 'part', 'Extractor', '', 0,     'Installed', '2026-08-14', 1, NULL),
      (1, 'part', 'O-ring',    '', 0,     'Installed', '2026-08-14', 1, NULL),
      (1, 'part', 'Filter',    '', 0,     'Installed', '2026-08-14', 1, NULL),
      (1, 'part', 'Ion source seal', '$86.00', 8600, 'Installed', '2026-08-14', 1, NULL),
      -- Already costed as a work order's part: the row above must not claim it.
      (1, 'part', 'Turbo controller', '$900.00', 90000, 'Installed', '2026-08-12', 1, 1),
      -- February's visit, long out of a 30-day window.
      (1, 'part', 'Source seal', '$412.00', 41200, 'Installed', '2026-02-10', 1, NULL),
      -- Fitted since the last completion: real money, not on a finished job.
      (1, 'part', 'Spare cone', '$140.00', 14000, 'Installed', '2026-08-25', 1, NULL),
      -- Never fitted, so never spent.
      (1, 'part', 'Backup kit', '$1,200.00', 120000, 'Ordered', '', 1, NULL),
      -- Somebody else's shop entirely.
      (2, 'part', 'Their seal', '$500.00', 50000, 'Installed', '2026-08-15', 3, NULL);
  `);
});

const board = async (days: number, tenant: number | null = SIERRA) =>
  (await import("@/lib/invoiceData")).pmCostingBoard(TODAY, days, tenant);

describe("pmCostingBoard", () => {
  it("finds a completed PM, which costing has never looked at", () => {
    // The whole point: a Done task carrying a schedule id. There is no work
    // order here, no invoice, and nothing costingBoard's queries would reach.
    return board(30).then((b) => {
      expect(b.rows.map((r) => r.title)).toEqual(["Quarterly source clean"]);
      expect(b.rows[0]!.systemName).toBe("Puget MS bench");
      expect(b.rows[0]!.orgName).toBe("Puget Diagnostics");
      expect(b.rows[0]!.completedOn).toBe("2026-08-14");
    });
  });

  it("sums the kit once and adds the loose part", async () => {
    // $1,200 kit + four contents at zero + an $86 seal. The $900 controller is
    // the work order's, and the row says so rather than reading low in silence.
    const b = await board(30);
    expect(b.rows[0]!.partsCents).toBe(128600);
    expect(b.rows[0]!.parts).toBe(6);
    expect(b.rows[0]!.note).toBe("parts costed on WO-0412");
    expect(b.totalCents).toBe(128600);
  });

  it("counts the PM that took no parts instead of listing it", async () => {
    const b = await board(30);
    expect(b.quiet).toBe(1);   // the annual leak check
  });

  it("opens onto the record it is reporting", async () => {
    const b = await board(30);
    expect(b.rows[0]!.href).toBe("/instruments/1#task-3");
  });

  it("puts February's seal on February, not on August", async () => {
    // A year's window shows all three visits. The seal fitted on the day of the
    // February visit belongs to it - not to whichever completion is newest.
    const b = await board(365);
    const feb = b.rows.find((r) => r.completedOn === "2026-02-10")!;
    expect(feb.partsCents).toBe(41200);
    expect(b.rows.find((r) => r.completedOn === "2026-08-14")!.partsCents).toBe(128600);
    // May took nothing, and the part fitted on the 25th waits for November.
    expect(b.quiet).toBe(2);
  });

  it("stops at the tenant boundary", async () => {
    // Cascade's own PM, on Cascade's system, with Cascade's $500 seal. Sierra
    // sees none of it - the same rule every workspace-wide reader here follows.
    const sierra = await board(365);
    expect(sierra.rows.some((r) => r.orgName === "")).toBe(false);
    expect(sierra.totalCents).toBe(169800);

    const cascade = await board(365, CASCADE);
    expect(cascade.rows).toHaveLength(1);
    expect(cascade.totalCents).toBe(50000);
  });
});
