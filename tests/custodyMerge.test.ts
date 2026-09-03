// Two rows, one machine - the report and the fold, driven against a database.
//
// The merge is the one script in the custody work that rewrites hashes, so it
// is the one that gets exercised hardest: every child table re-pointed with
// nothing left dangling, the merged chain re-linked and verifying, the
// duplicate archived rather than deleted, its tag kept, and a duplicate that
// carries a sealed tenure refused outright - a received record is not ours to
// fold into anything.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));

const { asc, eq, sql } = await import("drizzle-orm");
const { instruments, orgInstrumentTags, systemEvents, tasks, workOrders } = schema;
const { findGroups } = await import("../scripts/dedupe-instruments");
const { mergeGroup } = await import("../scripts/merge-instruments");
const { appendEvent } = await import("@/lib/custody/append");
const { verifyChain } = await import("@/lib/custody/hash");

const SIERRA = 3, NORTHWEST = 4, EMERY = 7;
const CANON = 1, COPY = 2;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

beforeEach(async () => {
  await client.exec(`
    DELETE FROM org_instrument_tags; DELETE FROM grants; DELETE FROM custody_epochs; DELETE FROM system_shares;
    DELETE FROM tasks; DELETE FROM work_orders; DELETE FROM instruments; DELETE FROM orgs;
    INSERT INTO orgs (id, name, kind, is_operator) VALUES (${SIERRA}, 'Sierra Spectra', 'provider', true), (${NORTHWEST}, 'Northwest Instrument', 'provider', true);
    INSERT INTO orgs (id, name, kind, parent_org_id) VALUES (${EMERY}, 'Emery Pharma', 'client', ${SIERRA});
    -- The original, and the copy lib/clientShare made for the other shop.
    INSERT INTO instruments (id, external_id, client, model, manufacturer, serial, owner_org_id, tenant_org_id, created_at)
      VALUES (${CANON}, 'EP-001', 'Emery Pharma', '6495C', 'Agilent', 'SG12345', ${EMERY}, ${SIERRA}, '2025-01-01');
    INSERT INTO instruments (id, external_id, client, model, manufacturer, serial, source_ref, owner_org_id, tenant_org_id, created_at)
      VALUES (${COPY}, 'NW-114', 'Emery Pharma', '6495C', 'Agilent', 'SG12345', 'EP-001', ${EMERY}, ${NORTHWEST}, '2026-03-01');
    INSERT INTO system_shares (instrument_id, org_id, access) VALUES (${CANON}, ${SIERRA}, 'edit'), (${COPY}, ${NORTHWEST}, 'edit'), (${COPY}, ${SIERRA}, 'view');
    INSERT INTO work_orders (id, tenant_org_id, number, instrument_id, title, severity, state, opened_on) VALUES
      (1, ${SIERRA}, 'WO-1', ${CANON}, 'Ours', 'Down', 'closed', '2025-06-01'),
      (2, ${NORTHWEST}, 'WO-9', ${COPY}, 'Theirs', 'Down', 'closed', '2026-05-01');
    INSERT INTO tasks (tenant_org_id, instrument_id, title, state) VALUES (${NORTHWEST}, ${COPY}, 'Their task', 'Done');
    SELECT setval('instruments_id_seq', 100); SELECT setval('orgs_id_seq', 100);
  `);
  await appendEvent({ instrumentId: CANON, kind: "repair", occurredAt: new Date("2025-06-02T12:00:00Z"), recordedAt: new Date("2025-06-02T12:00:00Z"),
    authorOrgId: SIERRA, custodianOrgId: EMERY, whoGrade: "third_party", howGrade: "typed", provenance: { findings: "ours" }, sourceKind: "work_order", sourceId: "1" });
  await appendEvent({ instrumentId: COPY, kind: "repair", occurredAt: new Date("2026-05-02T12:00:00Z"), recordedAt: new Date("2026-05-02T12:00:00Z"),
    authorOrgId: NORTHWEST, custodianOrgId: EMERY, whoGrade: "third_party", howGrade: "typed", provenance: { findings: "theirs" }, sourceKind: "work_order", sourceId: "2" });
});

describe("the report", () => {
  it("finds the copy by serial and by source_ref, and proposes the original", async () => {
    const groups = await findGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].canonicalId).toBe(CANON);
    expect(groups[0].ids.sort()).toEqual([CANON, COPY]);
    expect(groups[0].blocked).toEqual([]);
  });

  it("blocks a group whose duplicate carries a sealed tenure", async () => {
    await client.exec(`INSERT INTO custody_epochs (instrument_id, n, custodian_org_id, close_kind, sealed_at) VALUES (${COPY}, 1, ${EMERY}, 'sealed', now());`);
    const [g] = await findGroups();
    expect(g.blocked[0]).toMatch(/sealed epoch/);
    const res = await mergeGroup(CANON, true);
    expect("error" in res && res.error).toMatch(/blocked/);
  });

  it("writes nothing", async () => {
    await findGroups();
    await mergeGroup(CANON, false);
    expect((await testDb.select().from(instruments).where(eq(instruments.id, COPY)))[0].archived).toBe(false);
    expect((await testDb.select().from(workOrders).where(eq(workOrders.instrumentId, COPY)))).toHaveLength(1);
  });
});

describe("the fold", () => {
  it("re-points every child, leaves no orphan, re-links the chain, and keeps the tag", async () => {
    const res = await mergeGroup(CANON, true);
    if ("error" in res) throw new Error(res.error);

    // Nothing points at the duplicate any more, in any table that can.
    const dangling: string[] = [];
    for (const table of ["work_orders", "tasks", "system_shares", "system_events", "custody_events", "attachments", "parts", "pm_schedules", "audit_log"]) {
      const [{ n }] = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE instrument_id = ${COPY}`)).rows;
      if (n) dangling.push(`${table}:${n}`);
    }
    expect(dangling).toEqual([]);
    expect((await testDb.select().from(workOrders).where(eq(workOrders.instrumentId, CANON)))).toHaveLength(2);
    expect((await testDb.select().from(tasks).where(eq(tasks.instrumentId, CANON)))).toHaveLength(1);

    // The chain: both events on the canonical, one genesis, and it verifies.
    const chain = await testDb.select().from(systemEvents).where(eq(systemEvents.instrumentId, CANON)).orderBy(asc(systemEvents.id));
    expect(chain).toHaveLength(2);
    expect(chain.filter((e) => e.prevHash === "")).toHaveLength(1);
    expect(verifyChain(chain.map((r) => ({ ...r, procedureKeys: r.procedureKeys as never[], provenance: r.provenance as Record<string, unknown> })))).toEqual({ ok: true });
    expect(res.relinked).toBe(2);
    expect(res.after).not.toBe(res.before);

    // The duplicate is archived, not gone, and its tag survives for the shop that used it.
    const [dup] = await testDb.select().from(instruments).where(eq(instruments.id, COPY));
    expect(dup.archived).toBe(true);
    expect(dup.notes).toContain("Folded into EP-001");
    const [tag] = await testDb.select().from(orgInstrumentTags).where(eq(orgInstrumentTags.instrumentId, CANON));
    expect(tag.externalId).toBe("NW-114");

    // A share the canonical already had is dropped, the other moves.
    expect(res.dropped).toBe(1);
    expect(res.moved.system_shares).toBe(1);
  });

  it("leaves the trigger armed afterwards", async () => {
    const res = await mergeGroup(CANON, true);
    if ("error" in res) throw new Error(res.error);
    const [e] = await testDb.select().from(systemEvents).where(eq(systemEvents.instrumentId, CANON));
    await expect(testDb.update(systemEvents).set({ kind: "note" }).where(eq(systemEvents.id, e.id))).rejects.toThrow(/append-only/);
  });

  it("is a no-op the second time", async () => {
    await mergeGroup(CANON, true);
    const again = await mergeGroup(CANON, true);
    // The archived copy still shares a serial, so the report still groups it -
    // but there is nothing left to move.
    if ("error" in again) throw new Error(again.error);
    expect(Object.keys(again.moved)).toEqual([]);
    expect(again.relinked).toBe(0);
    void sql;
  });
});
