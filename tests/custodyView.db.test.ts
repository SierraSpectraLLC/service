// The truth table again, this time against a database.
//
// tests/custodyView.test.ts pins the RULES over fixtures. This pins the
// LOADER: that real epoch, grant and event rows come back through
// custodyContext shaped exactly as viewOf was written to expect, and that the
// same five parties get the same answers they get in memory. A rule that is
// correct and a loader that hands it the wrong shape is a leak, and nothing in
// the pure suite can catch it.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));

const { custodyContext } = await import("@/lib/custody/load");
const { currentCustodianOrgId, openEpochOf } = await import("@/lib/custody/custodian");
const { eventVisibility, custodianLabel, authorLabel } = await import("@/lib/custody/view");
const { appendEvent } = await import("@/lib/custody/append");
const { emitWorkOrderClosed } = await import("@/lib/custody/emit");

// Scenario 1 from the ADR, as rows: Foothill held it and sold it through Basin
// to Delta; Sierra Spectra serviced it under Foothill, Cascade services it now.
const FOOTHILL = 10, BASIN = 11, SIERRA = 12, DELTA = 13, CASCADE = 14, STRANGER = 99;
const INST = 1, E1 = 1, E2 = 2;

const ORG = {
  [FOOTHILL]: { id: FOOTHILL, name: "Foothill Instruments", kind: "reseller" as const, showNameDownstream: false, verifiedAt: null },
  [SIERRA]: { id: SIERRA, name: "Sierra Spectra", kind: "provider" as const, showNameDownstream: true, verifiedAt: null },
  [CASCADE]: { id: CASCADE, name: "Cascade Service Co", kind: "provider" as const, showNameDownstream: false, verifiedAt: null },
};

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
});

beforeEach(async () => {
  await client.exec(`
    DELETE FROM grants; DELETE FROM custody_epochs; DELETE FROM instruments; DELETE FROM orgs;
    INSERT INTO orgs (id, name, kind, is_operator) VALUES
      (${FOOTHILL}, 'Foothill Instruments', 'provider', true),
      (${BASIN}, 'Basin Analytical', 'provider', true),
      (${SIERRA}, 'Sierra Spectra', 'provider', true),
      (${DELTA}, 'Delta Diagnostics', 'client', false),
      (${CASCADE}, 'Cascade Service Co', 'provider', true);
    INSERT INTO instruments (id, external_id, client, model, owner_org_id, tenant_org_id)
      VALUES (${INST}, 'NW-114', 'Delta Diagnostics', '6495C', ${DELTA}, ${SIERRA});

    -- Built the way it actually happens: epoch 1 opens, is worked, is sealed,
    -- and only then does epoch 2 open. Seeding it pre-sealed would have to get
    -- past the frozen-epoch guard, which is the guard working.
    INSERT INTO custody_epochs (id, instrument_id, n, custodian_org_id, custodian_name, close_kind, broker_org_id)
      VALUES (${E1}, ${INST}, 1, ${FOOTHILL}, 'Foothill Instruments', 'open', ${BASIN});

    INSERT INTO grants (instrument_id, epoch_id, grantee_org_id, granted_by_org_id, kind)
      VALUES (${INST}, ${E1}, ${SIERRA}, ${FOOTHILL}, 'service');
  `);

  const ev = async (over: Parameters<typeof appendEvent>[0]) => appendEvent(over);
  await ev({ instrumentId: INST, kind: "intake", occurredAt: new Date("2026-01-05T12:00:00Z"),
    authorOrgId: FOOTHILL, custodianOrgId: FOOTHILL, whoGrade: "attested", howGrade: "document_only",
    provenance: { findings: "Arrived from auction." }, sourceKind: "manual", sourceId: "s1-intake", epochId: E1 });
  await ev({ instrumentId: INST, kind: "pm", occurredAt: new Date("2026-02-10T12:00:00Z"),
    authorOrgId: SIERRA, commissionerOrgId: FOOTHILL, custodianOrgId: FOOTHILL,
    whoGrade: "third_party", howGrade: "procedure_run",
    procedureKeys: [{ key: "6495c/replace-lamp", state: "done" }],
    provenance: { findings: "Lamp replaced; baseline within spec." },
    private: { price: "480.00", contact: "Ray" }, sourceKind: "manual", sourceId: "s1-pm", epochId: E1 });
  await ev({ instrumentId: INST, kind: "inspection", occurredAt: new Date("2026-05-02T12:00:00Z"),
    authorOrgId: SIERRA, commissionerOrgId: BASIN, custodianOrgId: FOOTHILL,
    whoGrade: "third_party", howGrade: "procedure_run",
    provenance: { findings: "Detector at 82% of nominal." },
    private: { price: "310.00", site: "Foothill floor 2" }, sourceKind: "manual", sourceId: "s1-exam", epochId: E1 });
});

/** Foothill sells through Basin; only one epoch may be open at a time. */
async function sellToDelta() {
  await client.exec(`
    UPDATE custody_epochs SET close_kind = 'sealed', sealed_at = '2026-06-01T12:00:00Z' WHERE id = ${E1};
    INSERT INTO custody_epochs (id, instrument_id, n, custodian_org_id, custodian_name, close_kind)
      VALUES (${E2}, ${INST}, 2, ${DELTA}, 'Delta Diagnostics', 'open');
    UPDATE grants SET ended_at = '2026-06-01T12:00:00Z', end_reason = 'epoch_closed' WHERE epoch_id = ${E1};
    INSERT INTO grants (instrument_id, epoch_id, grantee_org_id, granted_by_org_id, kind)
      VALUES (${INST}, ${E2}, ${CASCADE}, ${DELTA}, 'service');
  `);
  await appendEvent({ instrumentId: INST, kind: "pm", occurredAt: new Date("2026-07-14T12:00:00Z"),
    authorOrgId: CASCADE, commissionerOrgId: DELTA, custodianOrgId: DELTA,
    whoGrade: "third_party", howGrade: "typed",
    provenance: { findings: "Quarterly PM complete." }, private: { price: "520.00" },
    sourceKind: "manual", sourceId: "s2-pm", epochId: E2 });
}

const levels = async (viewer: number | null) =>
  Object.fromEntries((await custodyContext(viewer, INST)).epochs.map((e) => [e.epoch.n, e.level]));

describe("the level matrix, loaded from rows", () => {
  beforeEach(sellToDelta);

  it("matches the fixture suite for all five parties", async () => {
    expect(await levels(FOOTHILL)).toEqual({ 1: "full", 2: "none" });
    expect(await levels(BASIN)).toEqual({ 1: "full", 2: "none" });
    expect(await levels(SIERRA)).toEqual({ 1: "full", 2: "none" });
    expect(await levels(DELTA)).toEqual({ 1: "prov", 2: "full" });
    expect(await levels(CASCADE)).toEqual({ 1: "prov", 2: "full" });
  });

  it("tells a stranger nothing at all", async () => {
    expect((await custodyContext(STRANGER, INST)).epochs).toEqual([]);
    expect((await custodyContext(null, INST)).epochs).toEqual([]);
  });

  it("keeps the provider's view of the epoch it worked, grant long since ended", async () => {
    const ctx = await custodyContext(SIERRA, INST);
    const e1 = ctx.epochs.find((e) => e.epoch.n === 1)!;
    expect(e1.level).toBe("full");
    expect(e1.reason).toBe("grantee");
  });
});

describe("payloads through the loader", () => {
  beforeEach(sellToDelta);

  it("hands the broker the exam it paid for and not the PM it did not", async () => {
    const ctx = await custodyContext(BASIN, INST);
    const e1 = ctx.epochs.find((e) => e.epoch.n === 1)!.epoch;
    const exam = ctx.chain.events.find((e) => e.sourceId === "s1-exam")!;
    const pm = ctx.chain.events.find((e) => e.sourceId === "s1-pm")!;
    expect(eventVisibility(BASIN, exam, e1, ctx.chain).private).toEqual({ price: "310.00", site: "Foothill floor 2" });
    expect(eventVisibility(BASIN, pm, e1, ctx.chain).private).toBeNull();
    expect(eventVisibility(BASIN, pm, e1, ctx.chain).provenance)
      .toEqual({ findings: "Lamp replaced; baseline within spec." });
  });

  it("gives the buyer the structured half of the epoch it bought and no prices", async () => {
    const ctx = await custodyContext(DELTA, INST);
    const e1 = ctx.epochs.find((e) => e.epoch.n === 1)!.epoch;
    const pm = ctx.chain.events.find((e) => e.sourceId === "s1-pm")!;
    const seen = eventVisibility(DELTA, pm, e1, ctx.chain);
    expect(seen.level).toBe("prov");
    expect(seen.private).toBeNull();
    expect(seen.procedureKeys).toEqual([{ key: "6495c/replace-lamp", state: "done" }]);
  });

  it("shows the previous holder nothing of the epoch after its own", async () => {
    const ctx = await custodyContext(FOOTHILL, INST);
    const e2 = ctx.epochs.find((e) => e.epoch.n === 2)!.epoch;
    const pm = ctx.chain.events.find((e) => e.sourceId === "s2-pm")!;
    const seen = eventVisibility(FOOTHILL, pm, e2, ctx.chain);
    expect(seen).toMatchObject({ level: "none", provenance: null, private: null, procedureKeys: null });
  });

  it("anonymizes the seller to the buyer and withholds an opted-out provider", async () => {
    const ctx = await custodyContext(DELTA, INST);
    const e1v = ctx.epochs.find((e) => e.epoch.n === 1)!;
    expect(custodianLabel(DELTA, e1v.epoch, ORG[FOOTHILL], ctx.chain)).toBe("Reseller, anonymized");
    const intake = ctx.chain.events.find((e) => e.sourceId === "s1-intake")!;
    // Foothill authored its own intake; naming the author would name the custodian.
    expect(authorLabel(DELTA, intake, ORG[FOOTHILL], "prov")).toBe("custodian at the time");
    const pm = ctx.chain.events.find((e) => e.sourceId === "s1-pm")!;
    expect(authorLabel(DELTA, pm, ORG[SIERRA], "prov")).toBe("Sierra Spectra");
    const now = ctx.chain.events.find((e) => e.sourceId === "s2-pm")!;
    expect(authorLabel(STRANGER, now, ORG[CASCADE], "prov")).toBe("Service provider (name withheld by provider)");
  });
});

describe("the derived custodian", () => {
  beforeEach(sellToDelta);

  it("reads the holder off the open epoch", async () => {
    expect(await currentCustodianOrgId(INST)).toEqual({ held: true, orgId: DELTA, name: "Delta Diagnostics" });
    expect((await openEpochOf(INST))?.n).toBe(2);
  });

  it("says 'nobody holds it' differently from 'the house holds it'", async () => {
    // instruments.owner_org_id has always been nullable and has always meant
    // house stewardship. A caller has to be able to tell that from a machine
    // nothing has been recorded about at all.
    await client.exec(`UPDATE custody_epochs SET custodian_org_id = NULL, custodian_name = 'house stewardship' WHERE id = ${E2};`);
    expect(await currentCustodianOrgId(INST)).toEqual({ held: true, orgId: null, name: "house stewardship" });
    await client.exec(`DELETE FROM grants; DELETE FROM custody_epochs;`);
    expect(await currentCustodianOrgId(INST)).toEqual({ held: false, orgId: null, name: "" });
    expect((await custodyContext(DELTA, INST)).untracked).toBe(true);
  });
});

describe("a machine with no custody history", () => {
  it("is untracked rather than invisible, and leaks nothing either way", async () => {
    await client.exec(`
      DELETE FROM grants; DELETE FROM custody_epochs;
      INSERT INTO instruments (id, external_id, client, model, owner_org_id, tenant_org_id)
        VALUES (2, 'NW-115', 'Delta Diagnostics', '1260', ${DELTA}, ${SIERRA});
      INSERT INTO work_orders (id, tenant_org_id, number, instrument_id, org_id, title, severity, state,
        opened_on, close_summary, closed_at)
      VALUES (1, ${SIERRA}, 'WO-1', 2, ${DELTA}, 'Job', 'Down', 'closed', '2026-03-04',
        'Swapped the pump head.', '2026-03-04T12:00:00Z');
    `);
    // The emitter must still file the event; it just has no span to file it in.
    await emitWorkOrderClosed(1);
    const ctx = await custodyContext(DELTA, 2);
    expect(ctx.untracked).toBe(true);
    expect(ctx.epochs).toEqual([]);
    expect(ctx.chain.events).toHaveLength(1);
    expect(ctx.chain.events[0].epochId).toBeNull();
  });
});
