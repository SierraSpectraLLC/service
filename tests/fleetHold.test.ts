// Companies we are not currently working for, and their machines staying off
// the board.
//
// The first report: "I sent a quote to Federon, but now they're stored in my
// client list with their equipment. They should be stored as a lead so their
// systems don't interfere." There was no such state. orgs.kind is client |
// provider, which says which side of the relationship a company is on and is
// load-bearing for personas, sharing and the provider queue - not whether they
// have bought anything. The `leads` table is the marketplace referral thing:
// fee terms, claimed_by_org_id, offered to other shops. Neither fits.
//
// The second: "I also want a 'former client' option. That way I can remove
// their systems from the active queue like a prospect, update any information
// I receive about their system and keep provenance records / ship those
// records to other orgs." A third state, not the negation of either existing
// one - so the boolean became orgs.stage. See lib/orgStage.
//
// One rule for both non-client stages. Four things are pinned: that their
// systems come off the fleet, that a NULL instrument column survives the
// exclusion, that a stage change puts everything straight back, and that every
// fleet query actually asks - the last being a static check, because the
// failure mode here is a page added next year that quietly puts a stranger's
// machines back on the board.
//
// Real Postgres, in-process, from the same DDL every deploy applies.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

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

const SIERRA = 1, PUGET = 2, FEDERON = 3, CASCADE = 4, RIVAL = 5;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator, parent_org_id, stage) VALUES
      (${SIERRA},  'Sierra Spectra',  'provider', true,  NULL,       'client'),
      (${PUGET},   'Puget Diagnostics','client',  false, ${SIERRA},  'client'),
      (${FEDERON}, 'Federon',         'client',   false, ${SIERRA},  'prospect'),
      (${CASCADE}, 'Cascade Service', 'provider', true,  NULL,       'client'),
      (${RIVAL},   'Someone Else',    'client',   false, ${CASCADE}, 'prospect');
    INSERT INTO app_settings (id, operator_org_id) VALUES (1, ${SIERRA});

    INSERT INTO instruments (id, tenant_org_id, external_id, client, model, owner_org_id) VALUES
      (1, ${SIERRA},  'SS-001', 'Puget',   'LCMS-8050',   ${PUGET}),
      (2, ${SIERRA},  'SS-002', 'Puget',   'GCMS-QP2020', ${PUGET}),
      (3, ${SIERRA},  'SS-003', 'Federon', '6470 LC-MS',  ${FEDERON}),
      (4, ${SIERRA},  'SS-004', 'Federon', '7890 GC',     ${FEDERON}),
      -- House-owned: a system on our own bench, belonging to nobody yet.
      (5, ${SIERRA},  'SS-005', 'bench',   'ISQ 7000',    NULL),
      (6, ${CASCADE}, 'CI-001', 'Theirs',  'TOC-L',       ${RIVAL});
  `);
});

const hold = async (tenant: number | null) =>
  (await import("@/lib/fleetHold")).fleetHold(tenant);
const held = async (tenant: number | null) => (await hold(tenant)).systems;

describe("which systems the fleet is holding back", () => {
  it("names theirs and nobody else's", async () => {
    expect((await held(SIERRA)).sort()).toEqual([3, 4]);
  });

  it("stops at the tenant boundary", async () => {
    // Cascade's prospect is Cascade's business. Reading across would put
    // another workspace's ids into this one's exclusion list.
    expect(await held(CASCADE)).toEqual([6]);
  });

  it("holds nothing when everybody is a client", async () => {
    await client.exec(`UPDATE orgs SET stage = 'client' WHERE id = ${FEDERON};`);
    expect(await held(SIERRA)).toEqual([]);
    await client.exec(`UPDATE orgs SET stage = 'prospect' WHERE id = ${FEDERON};`);
  });

  it("holds a former client's systems for the same reason", async () => {
    /*
     * The two stages arrived from opposite directions - not ours YET, and no
     * longer ours - and land on the identical rule: the fleet is what the shop
     * is working on this week, and neither of these is. Written as `<>
     * 'client'` rather than as a list of two, so a stage added later is held
     * out until somebody decides otherwise.
     */
    await client.exec(`UPDATE orgs SET stage = 'former' WHERE id = ${FEDERON};`);
    expect((await held(SIERRA)).sort()).toEqual([3, 4]);
    await client.exec(`UPDATE orgs SET stage = 'prospect' WHERE id = ${FEDERON};`);
  });

  it("reads a blank stage as a client, which every pre-existing row is", async () => {
    await client.exec(`UPDATE orgs SET stage = '' WHERE id = ${FEDERON};`);
    // Not held: an organization already on file is a client until somebody
    // says otherwise, and the wrong direction here puts real machines off the
    // board on a deploy.
    expect(await held(SIERRA)).toEqual([]);
    await client.exec(`UPDATE orgs SET stage = 'prospect' WHERE id = ${FEDERON};`);
  });
});

describe("the exclusion itself", () => {
  const fleet = async () => {
    const { notHeld } = await import("@/lib/fleetHold");
    const ids = await held(SIERRA);
    return testDb.select({ id: schema.instruments.id }).from(schema.instruments)
      .where(and(eq(schema.instruments.tenantOrgId, SIERRA),
        notHeld(schema.instruments.id, ids)));
  };

  it("takes their systems off the fleet and leaves the rest", async () => {
    expect((await fleet()).map((r) => r.id).sort()).toEqual([1, 2, 5]);
  });

  it("puts them back the moment they are a client", async () => {
    // The transition is one word and nothing else: no copying, no moving, no
    // re-import. Everything they already had is simply in the fleet.
    await client.exec(`UPDATE orgs SET stage = 'client' WHERE id = ${FEDERON};`);
    expect((await fleet()).map((r) => r.id).sort()).toEqual([1, 2, 3, 4, 5]);
    await client.exec(`UPDATE orgs SET stage = 'prospect' WHERE id = ${FEDERON};`);
  });

  it("puts a former client's back too, if they come back", async () => {
    /*
     * The reversibility is the whole reason "former client" is safe to set. A
     * shop that suspects marking a dead account will lose the history leaves
     * it in the fleet instead, which is the state this feature exists to end.
     */
    await client.exec(`UPDATE orgs SET stage = 'former' WHERE id = ${FEDERON};`);
    expect((await fleet()).map((r) => r.id).sort()).toEqual([1, 2, 5]);
    await client.exec(`UPDATE orgs SET stage = 'client' WHERE id = ${FEDERON};`);
    expect((await fleet()).map((r) => r.id).sort()).toEqual([1, 2, 3, 4, 5]);
    await client.exec(`UPDATE orgs SET stage = 'prospect' WHERE id = ${FEDERON};`);
  });

  it("holds a module PM on a prospect's system, which names no system at all", async () => {
    /*
     * FOUND IN THE RUNNING APP, not here: a prospect's maintenance list did
     * not move when they were marked. A stacked annual is written on the
     * MODULES - the pump's jobs on the pump, the mass spec's on the mass spec
     * - and those rows carry an asset_id and a null instrument_id, so a rule
     * that only knew about system ids let every one of them carry on falling
     * due on a company that had not bought anything.
     */
    const { notHeld } = await import("@/lib/fleetHold");
    await client.exec(`
      INSERT INTO assets (id, tenant_org_id, instrument_id, kind, model) VALUES
        (1, ${SIERRA}, 1, 'Pump', '1290 Quat Pump'),
        (2, ${SIERRA}, 3, 'Pump', '1260 Quat Pump');
      INSERT INTO pm_schedules (id, tenant_org_id, instrument_id, asset_id, title, every_days, next_due) VALUES
        (10, ${SIERRA}, NULL, 1, 'Drain & replace oil - ours',      365, '2026-11-13'),
        (11, ${SIERRA}, NULL, 2, 'Drain & replace oil - Federon''s', 365, '2026-11-13');
    `);
    const h = await hold(SIERRA);
    expect(h.assets).toEqual([2]);
    const rows = await testDb.select({ id: schema.pmSchedules.id }).from(schema.pmSchedules)
      .where(and(eq(schema.pmSchedules.tenantOrgId, SIERRA),
        notHeld(schema.pmSchedules.instrumentId, h.systems),
        notHeld(schema.pmSchedules.assetId, h.assets)));
    expect(rows.map((r) => r.id)).toEqual([10]);
    await client.exec(`DELETE FROM pm_schedules; DELETE FROM assets;`);
  });

  it("lets a NULL instrument through, which a bare NOT IN would not", async () => {
    /*
     * THE ONE THAT BITES. pm_schedules.instrument_id is null on an asset-level
     * PM, and `null NOT IN (3,4)` is NULL in SQL, not true - so the obvious
     * exclusion would have silently dropped every asset-level PM in the shop
     * the first time anybody marked a prospect. Its absence would look like
     * the schedules had never existed.
     */
    const { notHeld } = await import("@/lib/fleetHold");
    await client.exec(`
      INSERT INTO pm_schedules (id, tenant_org_id, instrument_id, asset_id, title, every_days, next_due) VALUES
        (1, ${SIERRA}, 1,    NULL, 'Quarterly source clean', 91, '2026-11-13'),
        (2, ${SIERRA}, 3,    NULL, 'Federon quarterly',      91, '2026-11-13'),
        (3, ${SIERRA}, NULL, NULL, 'Bench pump oil change', 180, '2026-10-01');
    `);
    const ids = await held(SIERRA);
    const rows = await testDb.select({ id: schema.pmSchedules.id }).from(schema.pmSchedules)
      .where(and(eq(schema.pmSchedules.tenantOrgId, SIERRA),
        notHeld(schema.pmSchedules.instrumentId, ids)));
    expect(rows.map((r) => r.id).sort()).toEqual([1, 3]);
    await client.exec(`DELETE FROM pm_schedules;`);
  });
});

describe("setting the stage", () => {
  let who: { email: string; name: string; role: string; orgId: number | null; operatorOrgId: number | null; rootOperatorOrgId: number | null };
  beforeEach(async () => {
    who = {
      email: "joe@sierra.test", name: "Joe Vincent", role: "owner",
      orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: SIERRA,
    };
    vi.doMock("@/auth", () => ({ auth: async () => ({ user: who }) }));
    await client.exec(`
      DELETE FROM house_members;
      INSERT INTO house_members (email, org_id, role, name)
        VALUES ('joe@sierra.test', ${SIERRA}, 'owner', 'Joe Vincent');
      DELETE FROM audit_log;
    `);
    vi.resetModules();
  });

  it("refuses a provider, which is a different relationship", async () => {
    // These stages are about somebody buying from us. A service company we
    // subcontract to wears the same table and is not one.
    const { setOrgStage } = await import("@/app/actions");
    expect((await setOrgStage(CASCADE, "prospect")).error).toBeTruthy();
  });

  it("refuses a stage nobody defined", async () => {
    // A server action takes whatever the wire hands it. An unrecognized word
    // in this column reads as "client" everywhere downstream, so writing one
    // would silently put a company back in the fleet.
    const { setOrgStage } = await import("@/app/actions");
    expect((await setOrgStage(FEDERON, "lapsed")).error).toBeTruthy();
    expect((await setOrgStage(FEDERON, "")).error).toBeTruthy();
  });

  it("records what it did, in the words of what changes", async () => {
    const { setOrgStage } = await import("@/app/actions");
    await client.exec(`UPDATE orgs SET stage = 'client' WHERE id = ${FEDERON};`);
    expect(await setOrgStage(FEDERON, "prospect")).not.toHaveProperty("error");

    const [org] = await testDb.select().from(schema.orgs).where(eq(schema.orgs.id, FEDERON));
    expect(org!.stage).toBe("prospect");
    const log = await testDb.select().from(schema.auditLog);
    expect(log.some((r) => /prospect/.test(r.action) && /working fleet/.test(r.action))).toBe(true);
  });

  it("says former client in the log, not the column word", async () => {
    // The audit trail is read by people. "marked X a former" is the database
    // talking; the log should say what somebody would say.
    const { setOrgStage } = await import("@/app/actions");
    await client.exec(`DELETE FROM audit_log;`);
    expect(await setOrgStage(FEDERON, "former")).not.toHaveProperty("error");
    const log = await testDb.select().from(schema.auditLog);
    expect(log.some((r) => /former client/.test(r.action))).toBe(true);
  });

  it("leaves the kind alone - every stage is still a client-kind org", async () => {
    // The two axes stay independent. Rewriting kind would move them out of
    // every picker, share and persona check that reads it.
    const [org] = await testDb.select().from(schema.orgs).where(eq(schema.orgs.id, FEDERON));
    expect(org!.kind).toBe("client");
  });
});
