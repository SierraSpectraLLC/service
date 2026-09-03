// The new read path must say what the old one says.
//
// lib/serviceHistory was written because "0 VISITS THIS YEAR" meant "no closed
// work orders" - a fact about filing, not about service. Replacing it with a
// chain is only safe if the chain reproduces the answer it already gives, so
// this runs both implementations over one database and compares them.
//
// It also pins the append-only rules from the database's side, because an
// application-level invariant is worth one forgotten call site.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));

const { eq } = await import("drizzle-orm");
const { systemEvents, workOrders, tasks } = schema;
const { emitWorkOrderClosed, emitPmTask, emitCheckoutVerdict, emitCustodyEvent } = await import("@/lib/custody/emit");
const { completionsFromEvents } = await import("@/lib/custody/history");
const { appendEvent } = await import("@/lib/custody/append");
const { verifyChain } = await import("@/lib/custody/hash");
const { dayOf, visitsOf } = await import("@/lib/serviceHistory");
type Completion = import("@/lib/serviceHistory").Completion;

const SIERRA = 3, EMERY = 7, LABZEN = 8;
const INST = 1;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
});

beforeEach(async () => {
  await client.exec(`
    DELETE FROM grants; DELETE FROM custody_epochs;
    DELETE FROM checkout_verdicts; DELETE FROM custody_events;
    DELETE FROM task_results; DELETE FROM checklist_items; DELETE FROM tasks;
    DELETE FROM work_orders; DELETE FROM parts;
    -- Note there is no DELETE FROM system_events here: the append-only trigger
    -- refuses one, and the only sanctioned way for a chain to end is the
    -- machine itself going. Dropping the instrument cascades, which is exactly
    -- the hole the trigger leaves and this exercises it on every test.
    DELETE FROM instruments; DELETE FROM orgs;
    INSERT INTO orgs (id, name, kind, is_operator) VALUES (${SIERRA}, 'Sierra Spectra', 'provider', true);
    INSERT INTO orgs (id, name, kind, parent_org_id) VALUES (${EMERY}, 'Emery Pharma', 'client', ${SIERRA});
    INSERT INTO orgs (id, name, kind, is_operator) VALUES (${LABZEN}, 'LabZen', 'provider', true);
    INSERT INTO instruments (id, external_id, client, model, category, owner_org_id, tenant_org_id)
      VALUES (${INST}, 'EP-001', 'Emery Pharma', '6495C', 'LC-MS', ${EMERY}, ${SIERRA});
  `);
});

/** The old path, exactly as (dashboard)/page.tsx assembles it. */
async function completionsFromTables(): Promise<Completion[]> {
  const wos = await testDb.select().from(workOrders);
  const ts = await testDb.select().from(tasks);
  return [
    ...wos.flatMap((w) => (w.instrumentId === null || w.closedAt === null ? [] : [{
      instrumentId: w.instrumentId, day: dayOf(w.closedAt), planned: w.severity === "Planned",
    }])),
    ...ts.flatMap((t) => (
      t.instrumentId === null || t.state !== "Done" || t.completedAt === null
        || (t.origin !== "pm" && t.origin !== "pm_request")
        ? []
        : [{ instrumentId: t.instrumentId, day: dayOf(t.completedAt), planned: true }]
    )),
  ];
}

const closeWo = (id: number, day: string, severity: string, state = "closed") => client.exec(`
  INSERT INTO work_orders (id, tenant_org_id, number, instrument_id, org_id, title, severity, state,
    opened_on, close_summary, closed_at, resolved_at)
  VALUES (${id}, ${SIERRA}, 'WO-${id}', ${INST}, ${EMERY}, 'Job ${id}', '${severity}', '${state}',
    '${day}', 'Replaced the lamp and rebaselined.', '${day}T12:00:00Z', '${day}T12:00:00Z');
`);

const donePm = (id: number, day: string, origin = "pm") => client.exec(`
  INSERT INTO tasks (id, tenant_org_id, instrument_id, title, state, origin, due_date, completed_at)
  VALUES (${id}, ${SIERRA}, ${INST}, 'Quarterly PM', 'Done', '${origin}', '${day}', '${day}T09:00:00Z');
`);

describe("the chain says what the three tables said", () => {
  it("agrees on a plain mix of closed jobs and completed PMs", async () => {
    await closeWo(1, "2026-03-04", "Down");
    await closeWo(2, "2026-05-20", "Planned");
    await donePm(10, "2026-04-02");
    await donePm(11, "2026-06-11", "pm_request");
    for (const id of [1, 2]) await emitWorkOrderClosed(id);
    for (const id of [10, 11]) await emitPmTask(id);

    expect(visitsOf(await completionsFromEvents([INST])))
      .toEqual(visitsOf(await completionsFromTables()));
  });

  it("agrees that one day with two pieces of work is one visit", async () => {
    // The dedupe lib/serviceHistory gets by construction: a PM done inside a
    // work order closed the same day is one visit, not two.
    await closeWo(1, "2026-03-04", "Planned");
    await donePm(10, "2026-03-04");
    await emitWorkOrderClosed(1);
    await emitPmTask(10);

    const fromEvents = visitsOf(await completionsFromEvents([INST]));
    expect(fromEvents).toEqual(visitsOf(await completionsFromTables()));
    expect(fromEvents).toHaveLength(1);
  });

  it("agrees that an unplanned job makes the whole day unplanned", async () => {
    // Planned-wins would let a routine PM ticked off during an emergency
    // callout report the callout as scheduled maintenance, hiding a breakage.
    await closeWo(1, "2026-03-04", "Down");
    await donePm(10, "2026-03-04");
    await emitWorkOrderClosed(1);
    await emitPmTask(10);

    const fromEvents = visitsOf(await completionsFromEvents([INST]));
    expect(fromEvents).toEqual(visitsOf(await completionsFromTables()));
    expect(fromEvents[0].planned).toBe(false);
  });

  it("counts neither a qualification verdict nor a handoff as a visit", async () => {
    // Real events, and neither is an engineer standing in the room - the same
    // line lib/serviceHistory draws when it refuses to count an audit row.
    await client.exec(`
      INSERT INTO checkout_verdicts (id, tenant_org_id, instrument_id, phase, verdict, source, summary, metrics, recorded_at)
        VALUES (1, ${SIERRA}, ${INST}, 'verify', 'pass', 'parsed', 'EI tune', '[{"name":"abundance","value":"91%","ok":true}]', '2026-02-01T12:00:00Z');
      INSERT INTO custody_events (id, instrument_id, kind, from_org_id, to_org_id, from_name, to_name, at)
        VALUES (1, ${INST}, 'intake', NULL, ${EMERY}, '', 'Emery Pharma', '2026-01-01T12:00:00Z');
    `);
    await emitCustodyEvent(1);
    await emitCheckoutVerdict(1);
    await closeWo(1, "2026-03-04", "Down");
    await emitWorkOrderClosed(1);

    expect(await testDb.select().from(systemEvents)).toHaveLength(3);
    expect(visitsOf(await completionsFromEvents([INST])))
      .toEqual(visitsOf(await completionsFromTables()));
  });

  it("ignores the shop's own to-do list, which is not the machine's history", async () => {
    await donePm(10, "2026-04-02", "");
    await emitPmTask(10);
    expect(await testDb.select().from(systemEvents)).toHaveLength(0);
    expect(await completionsFromEvents([INST])).toEqual([]);
    expect(await completionsFromTables()).toEqual([]);
  });

  /**
   * THE ONE DISAGREEMENT, and it is the old path that is wrong.
   *
   * setWorkOrderState stamps closed_at on 'cancelled' as well as 'closed', and
   * the dashboard filters on closed_at alone - so a job somebody cancelled
   * counts today as a service visit. The chain records what happened, and
   * nothing happened. Written down here rather than reproduced.
   */
  it("does not count a cancelled job as a visit, where the old path does", async () => {
    await closeWo(1, "2026-03-04", "Down", "cancelled");
    await emitWorkOrderClosed(1);
    expect(await testDb.select().from(systemEvents)).toHaveLength(0);
    expect(await completionsFromTables()).toHaveLength(1);
    expect(await completionsFromEvents([INST])).toHaveLength(0);
  });
});

describe("appending", () => {
  it("is idempotent per source row, so the backfill can repair an emitter", async () => {
    await closeWo(1, "2026-03-04", "Down");
    const first = await emitWorkOrderClosed(1);
    const second = await emitWorkOrderClosed(1);
    expect(first).toMatchObject({ created: true });
    expect(second).toMatchObject({ created: false, id: (first as { id: number }).id });
    expect(await testDb.select().from(systemEvents)).toHaveLength(1);
  });

  it("chains each event onto the last, and the chain verifies", async () => {
    await closeWo(1, "2026-03-04", "Down");
    await closeWo(2, "2026-05-20", "Planned");
    await donePm(10, "2026-04-02");
    await emitWorkOrderClosed(1);
    await emitPmTask(10);
    await emitWorkOrderClosed(2);

    const rows = await testDb.select().from(systemEvents).orderBy(systemEvents.id);
    expect(rows[0].prevHash).toBe("");
    expect(rows[1].prevHash).toBe(rows[0].hash);
    expect(rows[2].prevHash).toBe(rows[1].hash);
    expect(verifyChain(rows.map((r) => ({
      id: r.id, kind: r.kind, occurredAt: r.occurredAt, authorOrgId: r.authorOrgId,
      procedureKeys: r.procedureKeys as never[], provenance: r.provenance as Record<string, unknown>,
      prevHash: r.prevHash, hash: r.hash,
    })))).toEqual({ ok: true });
  });

  it("cannot fork a machine's chain, even from two racing writers", async () => {
    // The unique on (instrument_id, prev_hash) is what serializes appends: the
    // neon-http driver has no transactions, so SELECT ... FOR UPDATE is not
    // available and the index does the job from below.
    await Promise.all([1, 2, 3, 4, 5].map((n) => appendEvent({
      instrumentId: INST, kind: "note", occurredAt: new Date(`2026-0${n}-01T12:00:00Z`),
      authorOrgId: SIERRA, custodianOrgId: EMERY, whoGrade: "self_reported", howGrade: "typed",
      sourceKind: "manual", sourceId: `race-${n}`,
    })));
    const rows = await testDb.select().from(systemEvents).orderBy(systemEvents.id);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.prevHash)).size).toBe(5);
    for (const [i, r] of rows.entries()) expect(r.prevHash).toBe(i === 0 ? "" : rows[i - 1].hash);
  });

  it("refuses to file into an epoch that does not exist", async () => {
    await expect(appendEvent({
      instrumentId: INST, kind: "note", occurredAt: new Date(), authorOrgId: null,
      custodianOrgId: null, whoGrade: "attested", howGrade: "typed",
      sourceKind: "manual", epochId: 999,
    })).rejects.toThrow(/does not exist/);
  });

  it("refuses to file into an epoch that has been sealed", async () => {
    // The holder sealed a bundle over exactly these events and somebody else
    // received it. Appending afterwards rewrites a record that has left.
    await client.exec(`
      INSERT INTO custody_epochs (id, instrument_id, n, custodian_org_id, close_kind, sealed_at)
      VALUES (77, ${INST}, 1, ${EMERY}, 'sealed', now());
    `);
    await expect(appendEvent({
      instrumentId: INST, kind: "note", occurredAt: new Date(), authorOrgId: null,
      custodianOrgId: EMERY, whoGrade: "attested", howGrade: "typed",
      sourceKind: "manual", epochId: 77,
    })).rejects.toThrow(/closed as 'sealed' and is frozen/);
  });

  it("does not re-judge an event that is already recorded", async () => {
    // The backfill runs over rows the live path already wrote, and by then the
    // epoch they landed in may have closed. Idempotence comes first.
    await closeWo(1, "2026-03-04", "Down");
    await emitWorkOrderClosed(1);
    const [row] = await testDb.select().from(systemEvents);
    await client.exec(`
      INSERT INTO custody_epochs (id, instrument_id, n, custodian_org_id, close_kind, sealed_at)
      VALUES (78, ${INST}, 2, ${EMERY}, 'sealed', now());
    `);
    await expect(appendEvent({
      instrumentId: INST, kind: "repair", occurredAt: new Date(), authorOrgId: SIERRA,
      custodianOrgId: EMERY, whoGrade: "third_party", howGrade: "typed",
      sourceKind: "work_order", sourceId: "1", epochId: 78,
    })).resolves.toMatchObject({ created: false, id: row.id });
  });
});

describe("the database refuses to let history be edited", () => {
  let id = 0;
  beforeEach(async () => {
    await closeWo(1, "2026-03-04", "Down");
    const r = await emitWorkOrderClosed(1);
    id = (r as { id: number }).id;
  });

  it("blocks a direct UPDATE of anything that travelled", async () => {
    await expect(testDb.update(systemEvents).set({ kind: "note" }).where(eq(systemEvents.id, id)))
      .rejects.toThrow(/append-only/);
    await expect(testDb.update(systemEvents).set({ occurredAt: new Date("2020-01-01") }).where(eq(systemEvents.id, id)))
      .rejects.toThrow(/append-only/);
    await expect(testDb.update(systemEvents).set({ hash: "forged" }).where(eq(systemEvents.id, id)))
      .rejects.toThrow(/append-only/);
    await expect(testDb.update(systemEvents).set({ provenance: { summary: "something else" } }).where(eq(systemEvents.id, id)))
      .rejects.toThrow(/append-only/);
  });

  it("blocks a DELETE of one line out of a machine's history", async () => {
    await expect(testDb.delete(systemEvents).where(eq(systemEvents.id, id))).rejects.toThrow(/append-only/);
  });

  it("lets the chain go when the machine itself goes", async () => {
    // The one sanctioned ending. Without this hole the chain would quietly make
    // deleting a system impossible - a regression dressed up as an invariant.
    await testDb.delete(schema.instruments).where(eq(schema.instruments.id, INST));
    expect(await testDb.select().from(systemEvents)).toHaveLength(0);
  });

  it("allows the two holes that exist on purpose", async () => {
    // withheld, because free text is held back at seal and during a claim
    // window; epoch_id, because Phase 3 places events into spans that did not
    // exist when they were written. Neither is hashed.
    await testDb.update(systemEvents).set({ withheld: true }).where(eq(systemEvents.id, id));
    await testDb.update(systemEvents).set({ epochId: 4 }).where(eq(systemEvents.id, id));
    const [row] = await testDb.select().from(systemEvents).where(eq(systemEvents.id, id));
    expect(row.withheld).toBe(true);
    expect(row.epochId).toBe(4);
  });
});

describe("the split at write", () => {
  it("keeps prices, the ask and the requester off the travelling half", async () => {
    await closeWo(1, "2026-03-04", "Down");
    await client.exec(`
      UPDATE work_orders SET body = 'The MS in room 2 is down, call Ray on 555-0100' WHERE id = 1;
      INSERT INTO parts (instrument_id, name, part_number, status, cost, po, installed_at)
        VALUES (${INST}, 'D2 lamp', 'G1314-60101', 'Installed', '480.00', 'PO-91', '2026-03-04');
    `);
    await emitWorkOrderClosed(1);
    const [row] = await testDb.select().from(systemEvents);
    const prov = row.provenance as Record<string, unknown>;
    const priv = row.private as Record<string, unknown>;

    expect(prov.summary).toBe("Replaced the lamp and rebaselined.");
    // The part NUMBER travels - it is what the next holder needs to buy one.
    expect(prov.parts).toEqual([{ partNumber: "G1314-60101", name: "D2 lamp" }]);
    for (const leak of ["ask", "requestedBy", "price", "cost", "po", "number", "title"]) {
      expect(prov[leak]).toBeUndefined();
    }
    expect(priv.ask).toContain("555-0100");
    expect((priv.parts as { cost: string }[])[0].cost).toBe("480.00");
  });

  it("grades an outside shop's work third-party and the owner's own self-reported", async () => {
    await closeWo(1, "2026-03-04", "Down");
    await emitWorkOrderClosed(1);
    const [byProvider] = await testDb.select().from(systemEvents);
    expect(byProvider.whoGrade).toBe("third_party");
    expect(byProvider.custodianOrgId).toBe(EMERY);

    await client.exec(`UPDATE instruments SET owner_org_id = ${SIERRA} WHERE id = ${INST};`);
    await closeWo(2, "2026-04-04", "Down");
    await emitWorkOrderClosed(2);
    const rows = await testDb.select().from(systemEvents).orderBy(systemEvents.id);
    expect(rows[1].whoGrade).toBe("self_reported");
  });

  it("calls a worked checklist a procedure run and a bare sentence typed", async () => {
    await donePm(10, "2026-04-02");
    await client.exec(`
      INSERT INTO checklist_items (task_id, text, done, heading) VALUES (10, 'Remove source', true, false);
    `);
    await donePm(11, "2026-05-02");
    await emitPmTask(10);
    await emitPmTask(11);
    const rows = await testDb.select().from(systemEvents).orderBy(systemEvents.id);
    expect(rows[0].howGrade).toBe("procedure_run");
    expect(rows[1].howGrade).toBe("typed");
  });
});
