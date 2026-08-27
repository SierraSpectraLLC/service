// The queries behind a maintenance plan, against real Postgres.
//
// The rules are held down by tests/pmPlan; this is the half that lives in a
// WHERE clause, and it is here for the reason every other query test in this
// project is: A NULL IS NOT A SCOPE, and neither is an org id. pm_plans is one
// instance-wide table, and "what is UCSF owed" asked by the wrong service
// company must come back empty rather than come back with somebody else's
// commitment on it.
//
// It also pins what counts as a preventive visit delivered, which is the one
// decision on this page a client would argue with.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });

vi.mock("@/db", () => ({ db: testDb }));

const SIERRA = 1, CASCADE = 2, UCSF = 3, RIVAL_LAB = 4;
const TODAY = "2026-08-27";

/*
 * Two service companies. Sierra services UCSF; Cascade services a lab of their
 * own AND has written a plan of their own for UCSF's id - which is the thing a
 * name or an org id alone would let leak, since a client can be serviced by
 * more than one provider and both stamp rows against the same org.
 */
beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (name, kind, is_operator, parent_org_id) VALUES
      ('Sierra Spectra', 'provider', true, NULL),
      ('Cascade Instrument', 'provider', true, NULL),
      ('UCSF', 'client', false, 1),
      ('Rival Lab', 'client', false, 2);

    INSERT INTO pm_plans (tenant_org_id, org_id, category, per_year) VALUES
      (1, 3, 'LC-MS', 2),
      (1, 3, 'LC',    1),
      (1, 3, '',      1),
      (2, 3, 'LC-MS', 9),   -- Cascade's own commitment to the same lab
      (2, 4, '',      4);

    INSERT INTO instruments (tenant_org_id, external_id, client, model, category, owner_org_id, archived) VALUES
      (1, 'MS-01',  'UCSF', 'QExactive',  'LC-MS', 3, false),
      (1, 'MS-02',  'UCSF', 'QExactive',  'LC-MS', 3, false),
      (1, 'LC-01',  'UCSF', '1290',       'LC',    3, false),
      (1, 'GC-01',  'UCSF', '8890',       'GC',    3, false),
      (1, 'OLD-01', 'UCSF', 'retired',    'LC-MS', 3, true),
      (2, 'CAS-01', 'Rival Lab', 'TSQ',   'LC-MS', 4, false);

    -- MS-01: one visit in May, and three schedules closed on that ONE day.
    -- MS-02: nothing this year, one last December.
    -- LC-01: a client-requested PM, which counts.
    -- GC-01: a corrective call-out and an unfinished PM, neither of which does.
    INSERT INTO tasks (tenant_org_id, instrument_id, title, state, origin, completed_at) VALUES
      (1, 1, 'Pump seals',     'Done', 'pm',         '2026-05-14T12:00:00Z'),
      (1, 1, 'Detector lamp',  'Done', 'pm',         '2026-05-14T12:00:00Z'),
      (1, 1, 'Annual service', 'Done', 'pm',         '2026-05-14T12:00:00Z'),
      (1, 2, 'Annual service', 'Done', 'pm',         '2025-12-03T12:00:00Z'),
      (1, 3, 'They called us', 'Done', 'pm_request', '2026-04-02T12:00:00Z'),
      (1, 4, 'Emergency',      'Done', '',           '2026-04-02T12:00:00Z'),
      (1, 4, 'Scheduled PM',   'Open', 'pm',         NULL);
  `);
});

describe("a plan belongs to the service company that made it", () => {
  it("reads its own commitments to a client", async () => {
    const { plansFor } = await import("@/lib/pmPlanData");
    const mine = await plansFor(SIERRA, UCSF);
    expect(mine.map((p) => `${p.category || "*"}:${p.perYear}`).sort())
      .toEqual(["*:1", "LC-MS:2", "LC:1"]);
  });

  it("does not read the other company's commitment to the same client", async () => {
    /*
     * Cascade promised UCSF nine a year. Same org id, different service
     * company, and an org id alone would have handed Sierra's page a number
     * Sierra never agreed to - beside Sierra's name, on Sierra's board.
     */
    const { plansFor } = await import("@/lib/pmPlanData");
    expect((await plansFor(SIERRA, UCSF)).some((p) => p.perYear === 9)).toBe(false);
    expect((await plansFor(CASCADE, UCSF)).map((p) => p.perYear)).toEqual([9]);
  });

  it("gives platform staff the instance, which is the support path", async () => {
    const { plansFor } = await import("@/lib/pmPlanData");
    expect(await plansFor(null)).toHaveLength(5);
    expect(await plansFor(SIERRA)).toHaveLength(3);
  });
});

describe("what counts as a visit delivered", () => {
  it("counts a day once, however many schedules closed on it", async () => {
    const { pmDaysByInstrument } = await import("@/lib/pmPlanData");
    const days = await pmDaysByInstrument([1], 2026);
    // Three rows come back; the rule collapses them, and the collapse is
    // asserted where it lives - here we pin that the fetch found all three, so
    // a future "SELECT DISTINCT" cannot quietly make the rule untestable.
    expect(days.get(1)).toEqual(["2026-05-14", "2026-05-14", "2026-05-14"]);
  });

  it("counts a PM the client asked for", async () => {
    // pm_request carries no schedule on purpose, so completing it does not move
    // a contract's calendar. It is still a preventive visit we made, and a
    // client who phoned for their PM instead of waiting must not read "behind".
    const { pmDaysByInstrument } = await import("@/lib/pmPlanData");
    expect(await pmDaysByInstrument([3], 2026).then((m) => m.get(3))).toEqual(["2026-04-02"]);
  });

  it("counts neither a corrective call-out nor an unfinished PM", async () => {
    const { pmDaysByInstrument } = await import("@/lib/pmPlanData");
    expect(await pmDaysByInstrument([4], 2026).then((m) => m.get(4))).toBeUndefined();
  });
});

describe("a client's coverage", () => {
  it("puts every system against the plan that governs its class", async () => {
    const { coverageForOrg } = await import("@/lib/pmPlanData");
    const { rows } = await coverageForOrg({ orgId: UCSF, tenantOrgId: SIERRA, today: TODAY });
    const by = new Map(rows.map((r) => [r.externalId, r.coverage]));

    // Two a year, one done in May: on track, next owed by the end of December.
    expect(by.get("MS-01")?.state).toBe("on_track");
    expect(by.get("MS-01")?.done).toBe(1);
    expect(by.get("MS-01")?.nextOwedBy).toBe("2026-12-31");

    // Two a year, nothing this year - last December's does not pay for this one.
    expect(by.get("MS-02")?.state).toBe("behind");
    expect(by.get("MS-02")?.done).toBe(0);

    // One a year, done in April.
    expect(by.get("LC-01")?.state).toBe("complete");

    // No LC-MS or LC row names a GC, so the catch-all covers it: one a year,
    // none done, and not yet late because an annual plan falls due in December.
    expect(by.get("GC-01")?.state).toBe("on_track");
    expect(by.get("GC-01")?.perYear).toBe(1);
  });

  it("leaves archived systems off the board", async () => {
    // A retired unit that never had its second PM is not a debt somebody has
    // to explain, and a board full of them is a board nobody reads.
    const { coverageForOrg } = await import("@/lib/pmPlanData");
    const { rows } = await coverageForOrg({ orgId: UCSF, tenantOrgId: SIERRA, today: TODAY });
    expect(rows.map((r) => r.externalId)).not.toContain("OLD-01");
  });

  it("leads with whoever is behind", async () => {
    const { coverageForOrg } = await import("@/lib/pmPlanData");
    const { rows } = await coverageForOrg({ orgId: UCSF, tenantOrgId: SIERRA, today: TODAY });
    expect(rows[0].externalId).toBe("MS-02");
  });

  it("shows the other company's client none of it", async () => {
    const { coverageForOrg } = await import("@/lib/pmPlanData");
    const { rows, plans } = await coverageForOrg({ orgId: UCSF, tenantOrgId: CASCADE, today: TODAY });
    // Cascade's plan for UCSF exists, but not one of Sierra's systems does.
    expect(plans.map((p) => p.perYear)).toEqual([9]);
    expect(rows).toEqual([]);
  });
});

describe("the shop-wide board", () => {
  it("shows one workspace its own clients and nobody else's", async () => {
    const { coverageBoard } = await import("@/lib/pmPlanData");
    const board = await coverageBoard({
      tenantOrgId: SIERRA, today: TODAY,
      orgs: [{ id: UCSF, name: "UCSF" }, { id: RIVAL_LAB, name: "Rival Lab" }],
    });
    /*
     * Rival Lab is passed in deliberately - a caller could get the org list
     * wrong, and the tenant stamp on the rows is what has to hold. Their
     * systems and their plan are Cascade's, so under Sierra's tenant the client
     * has neither and drops off the board entirely.
     */
    expect(board.map((c) => c.orgName)).toEqual(["UCSF"]);
    expect(board[0].rows).toHaveLength(4);
  });

  it("agrees with the per-client reader, system for system", async () => {
    // Two surfaces, one answer. They are separate functions because one query
    // per client would not do for a board; if they ever disagree, a number said
    // to a client's face disagrees with the number on their own page.
    const { coverageBoard, coverageForOrg } = await import("@/lib/pmPlanData");
    const [board] = await coverageBoard({
      tenantOrgId: SIERRA, today: TODAY, orgs: [{ id: UCSF, name: "UCSF" }],
    });
    const solo = await coverageForOrg({ orgId: UCSF, tenantOrgId: SIERRA, today: TODAY });
    expect(board.rows).toEqual(solo.rows);
  });
});

describe("one system's own standing", () => {
  it("reads the same answer its client's board shows", async () => {
    const { coverageForSystem } = await import("@/lib/pmPlanData");
    const got = await coverageForSystem({
      instrumentId: 1, ownerOrgId: UCSF, category: "LC-MS",
      tenantOrgId: SIERRA, today: TODAY,
    });
    expect(got.plan?.perYear).toBe(2);
    expect(got.coverage.state).toBe("on_track");
    expect(got.coverage.done).toBe(1);
  });

  it("has no plan for a system nobody owns", async () => {
    // A bench unit the house is stewarding is promised to nobody, so there is
    // no entitlement to be behind on. Not a query - an answer.
    const { coverageForSystem } = await import("@/lib/pmPlanData");
    const got = await coverageForSystem({
      instrumentId: 1, ownerOrgId: null, category: "LC-MS",
      tenantOrgId: SIERRA, today: TODAY,
    });
    expect(got.plan).toBeNull();
    expect(got.coverage.state).toBe("unplanned");
  });

  it("does not read the neighbouring company's plan for the same client", async () => {
    const { coverageForSystem } = await import("@/lib/pmPlanData");
    const got = await coverageForSystem({
      instrumentId: 1, ownerOrgId: UCSF, category: "LC-MS",
      tenantOrgId: SIERRA, today: TODAY,
    });
    expect(got.plan?.perYear).not.toBe(9);
  });
});

describe("the categories offered when writing a plan", () => {
  it("are the ones actually in that client's fleet", async () => {
    const { fleetCategories } = await import("@/lib/pmPlanData");
    // Archived systems contribute nothing - offering a class only a retired
    // unit had is offering a plan row that will never govern anything.
    expect(await fleetCategories(UCSF, SIERRA)).toEqual(["GC", "LC", "LC-MS"]);
  });

  it("are empty for a client of another workspace", async () => {
    const { fleetCategories } = await import("@/lib/pmPlanData");
    expect(await fleetCategories(RIVAL_LAB, SIERRA)).toEqual([]);
  });
});
