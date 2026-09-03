// The backfills, driven against a real database.
//
// These three scripts decide who is recorded as having held every machine on an
// instance and who was let in to work on it. Getting that wrong is not a bug
// somebody notices - it is a quiet reassignment, and the whole reason
// scripts/custody-parity writes its findings down instead of acting on them.
// So they are exercised rather than eyeballed: run them, run them again, and
// assert the second run is a no-op.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));

const { asc, eq } = await import("drizzle-orm");
const { custodyDiffs, custodyEpochs, grants, systemEvents } = schema;
const backfillEvents = (await import("../scripts/backfill-system-events")).main;
const backfillEpochs = (await import("../scripts/backfill-epochs")).main;
const backfillGrants = (await import("../scripts/backfill-grants")).main;
const parity = (await import("../scripts/custody-parity")).main;

const SIERRA = 3, EMERY = 7, LABZEN = 8;
/** Arguments are read from process.argv by each script, as when it is run. */
const withArgs = async (args: string[], run: () => Promise<void>) => {
  const saved = process.argv;
  process.argv = ["node", "script", ...args];
  try { await run(); } finally { process.argv = saved; }
};

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

beforeEach(async () => {
  await client.exec(`
    DELETE FROM custody_diffs; DELETE FROM grants; DELETE FROM custody_epochs;
    DELETE FROM provider_links; DELETE FROM system_shares; DELETE FROM stage_events;
    DELETE FROM work_orders; DELETE FROM tasks; DELETE FROM custody_events;
    DELETE FROM instruments; DELETE FROM orgs;
    INSERT INTO orgs (id, name, kind, is_operator) VALUES
      (${SIERRA}, 'Sierra Spectra', 'provider', true), (${LABZEN}, 'LabZen', 'provider', true);
    INSERT INTO orgs (id, name, kind, parent_org_id) VALUES (${EMERY}, 'Emery Pharma', 'client', ${SIERRA});
    INSERT INTO instruments (id, external_id, client, model, owner_org_id, tenant_org_id)
      VALUES (1, 'EP-001', 'Emery Pharma', '6495C', ${EMERY}, ${SIERRA});
    -- A machine nobody has recorded a handoff for: the ordinary case on an
    -- instance that has not been through a sale yet.
    INSERT INTO instruments (id, external_id, client, model, owner_org_id, tenant_org_id)
      VALUES (2, 'EP-002', 'Emery Pharma', '1260', ${EMERY}, ${SIERRA});

    INSERT INTO custody_events (instrument_id, kind, from_org_id, to_org_id, from_name, to_name, at)
      VALUES (1, 'intake', NULL, ${LABZEN}, '', 'LabZen', '2023-01-10T12:00:00Z'),
             (1, 'transfer', ${LABZEN}, ${EMERY}, 'LabZen', 'Emery Pharma', '2025-04-02T12:00:00Z');
    INSERT INTO work_orders (id, tenant_org_id, number, instrument_id, org_id, title, severity, state,
      opened_on, close_summary, closed_at)
      VALUES (1, ${SIERRA}, 'WO-1', 1, ${EMERY}, 'Source clean', 'Planned', 'closed', '2024-06-01',
              'Cleaned the source.', '2024-06-02T12:00:00Z'),
             (2, ${SIERRA}, 'WO-2', 1, ${EMERY}, 'HED fault', 'Down', 'closed', '2025-09-10',
              'Replaced the HED supply.', '2025-09-12T12:00:00Z'),
             -- Before the first handoff on file: history from before this
             -- platform, with no span to file it under.
             (3, ${SIERRA}, 'WO-0', 1, ${EMERY}, 'Ancient job', 'Down', 'closed', '2019-01-01',
              'Somebody else did this.', '2019-01-05T12:00:00Z');
    INSERT INTO stage_events (instrument_id, stage, kind, at) VALUES (1, 'Checkout', 'added', '2024-05-01T12:00:00Z');
    INSERT INTO system_shares (instrument_id, org_id, access, added_by) VALUES (1, ${SIERRA}, 'edit', 'joe@sierra.test');
    INSERT INTO provider_links (tenant_org_id, provider_org_id, created_by) VALUES (${SIERRA}, ${LABZEN}, 'joe@sierra.test');
  `);
});

const runAll = async () => {
  await withArgs([], backfillEvents);
  await withArgs(["--apply"], backfillEpochs);
  await withArgs(["--apply"], backfillGrants);
};

describe("events, then epochs", () => {
  it("files each event under the span it happened in", async () => {
    await runAll();
    const epochs = await testDb.select().from(custodyEpochs).orderBy(asc(custodyEpochs.n));
    expect(epochs.map((e) => [e.n, e.custodianOrgId, e.closeKind]))
      .toEqual([[1, LABZEN, "sealed"], [2, EMERY, "open"]]);

    const events = await testDb.select().from(systemEvents)
      .where(eq(systemEvents.instrumentId, 1)).orderBy(asc(systemEvents.occurredAt));
    const placed = events.map((e) => [e.sourceKind, e.occurredAt.toISOString().slice(0, 10), e.epochId]);
    expect(placed).toEqual([
      // Before the first handoff: "before Ridgeline", and no epoch to claim it.
      ["work_order", "2019-01-05", null],
      // An intake opens the first tenure and has nothing before it to close.
      ["custody_event", "2023-01-10", epochs[0].id],
      ["backfill", "2024-05-01", epochs[0].id],
      ["work_order", "2024-06-02", epochs[0].id],
      // The transfer CLOSES epoch 1 rather than opening epoch 2: sealing
      // freezes a bundle over the closing epoch's events, and the handoff is
      // the last line of the record its holder hands over.
      ["custody_event", "2025-04-02", epochs[0].id],
      ["work_order", "2025-09-12", epochs[1].id],
    ]);
  });

  it("stamps each event with whoever held the machine at the time", async () => {
    await runAll();
    const events = await testDb.select().from(systemEvents)
      .where(eq(systemEvents.sourceKind, "work_order")).orderBy(asc(systemEvents.occurredAt));
    // 2019 predates every handoff on file, so nobody is named - not "the first
    // owner, probably", which would put another shop's work under a name that
    // did not do it.
    expect(events.map((e) => e.custodianOrgId)).toEqual([null, LABZEN, EMERY]);
  });

  it("gives a machine with no handoff on file no epoch at all", async () => {
    await runAll();
    expect(await testDb.select().from(custodyEpochs).where(eq(custodyEpochs.instrumentId, 2))).toHaveLength(0);
  });

  it("is a no-op on a second run, which is what makes it a repair tool", async () => {
    await runAll();
    const before = await testDb.select().from(systemEvents);
    const epochsBefore = await testDb.select().from(custodyEpochs);
    await runAll();
    expect(await testDb.select().from(systemEvents)).toHaveLength(before.length);
    expect(await testDb.select().from(custodyEpochs)).toHaveLength(epochsBefore.length);
    expect(await testDb.select().from(grants)).toHaveLength((await testDb.select().from(grants)).length);
  });

  it("writes nothing at all on a dry run", async () => {
    await withArgs([], backfillEvents);
    await withArgs([], backfillEpochs);
    expect(await testDb.select().from(custodyEpochs)).toHaveLength(0);
    expect((await testDb.select().from(systemEvents)).every((e) => e.epochId === null)).toBe(true);
  });
});

describe("grants", () => {
  it("turns a share into a service grant on the open epoch, and a fleet link into a scoped one", async () => {
    await runAll();
    const [open] = await testDb.select().from(custodyEpochs).where(eq(custodyEpochs.closeKind, "open"));
    const rows = await testDb.select().from(grants).orderBy(asc(grants.granteeOrgId));
    expect(rows.map((g) => [g.granteeOrgId, g.kind, g.epochId]))
      .toEqual([[SIERRA, "service", open.id], [LABZEN, "service", open.id]]);
    // A fleet-wide arrangement and somebody deliberately let onto one machine
    // are not the same promise, so the scope says which this was.
    expect((rows.find((g) => g.granteeOrgId === LABZEN)!.scope as { fleet?: boolean }).fleet).toBe(true);
    expect((rows.find((g) => g.granteeOrgId === SIERRA)!.scope as { fleet?: boolean }).fleet).toBeUndefined();
  });

  it("invents no grant on a closed epoch", async () => {
    // A share row carries no history: it cannot say which previous holder let
    // an org in, and dating it into a sealed tenure would manufacture a party
    // to a record that has already shipped.
    await runAll();
    const sealed = await testDb.select().from(custodyEpochs).where(eq(custodyEpochs.closeKind, "sealed"));
    const rows = await testDb.select().from(grants);
    expect(rows.some((g) => sealed.some((e) => e.id === g.epochId))).toBe(false);
  });

  it("does not stack duplicates when it runs twice", async () => {
    await runAll();
    const n = (await testDb.select().from(grants)).length;
    await withArgs(["--apply"], backfillGrants);
    expect(await testDb.select().from(grants)).toHaveLength(n);
  });
});

describe("parity", () => {
  it("is clean when the pointer and the chain agree", async () => {
    await runAll();
    await withArgs(["--apply"], parity);
    expect(await testDb.select().from(custodyDiffs)).toHaveLength(0);
  });

  it("records a disagreement and changes nothing", async () => {
    await runAll();
    // Somebody repointed the owner by hand, the way the form allows.
    await client.exec(`UPDATE instruments SET owner_org_id = ${LABZEN} WHERE id = 1;`);
    await withArgs(["--apply"], parity);
    const [diff] = await testDb.select().from(custodyDiffs);
    expect(diff.externalId).toBe("EP-001");
    expect(diff.storedOrgId).toBe(LABZEN);
    expect(diff.derivedOrgId).toBe(EMERY);
    // AND THE POINTER IS UNTOUCHED. Reassigning machines on a deploy because a
    // script preferred one of two answers is the failure this exists to prevent.
    const [inst] = await testDb.select().from(schema.instruments).where(eq(schema.instruments.id, 1));
    expect(inst.ownerOrgId).toBe(LABZEN);
    const [open] = await testDb.select().from(custodyEpochs).where(eq(custodyEpochs.closeKind, "open"));
    expect(open.custodianOrgId).toBe(EMERY);
  });

  it("does not call a machine with no custody history a disagreement", async () => {
    await runAll();
    await withArgs(["--apply"], parity);
    expect((await testDb.select().from(custodyDiffs)).some((d) => d.instrumentId === 2)).toBe(false);
  });
});
