// Scenario 1 from the ADR, end to end through the state machine.
//
// Foothill (a reseller) holds the machine. Sierra Spectra services it under a
// grant; Basin brokers a sale and paid for one exam. Foothill reviews what
// will travel, holds back one line of free text, seals; Delta accepts and
// brings Cascade in. Every step is a real write through lib/custody/transfer,
// and the assertions are the ADR's promises: the epoch closes at SEAL and
// nothing can be added to it after, from the app or from below it; every
// grant ends with a reason and its holder keeps a frozen record; the bundle
// hashes; and the five parties see exactly what tests/custodyView says they
// should - now from rows a transfer wrote rather than rows a fixture did.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
type Who = { email: string; name: string; role: string; orgId: number | null; operatorOrgId: number | null; rootOperatorOrgId: number | null } | null;
let who: Who = null;
vi.mock("@/db", () => ({ db: testDb }));
vi.mock("@/auth", () => ({ auth: async () => (who ? { user: who } : null) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Map() }));

const { and, eq } = await import("drizzle-orm");
const { custodyEpochs, custodyEvents, engagementRecords, grants, instruments, systemEvents, systemShares, transfers, orgInstrumentTags } = schema;
const T = await import("@/lib/custody/transfer");
type TT = typeof import("@/lib/custody/transfer");
type Actor = Parameters<TT["initiate"]>[0];
type SealedBundle = Parameters<TT["bundleHash"]>[0];
const { appendEvent } = await import("@/lib/custody/append");
const { custodyContext } = await import("@/lib/custody/load");
const { eventVisibility, WITHHELD_MARKER } = await import("@/lib/custody/view");
const { verifyChain } = await import("@/lib/custody/hash");

const PLATFORM = 1, FOOTHILL = 10, BASIN = 11, SIERRA = 12, DELTA = 13, CASCADE = 14, SHELL = 15;
const INST = 1;
const actor = (orgId: number | null, operatorOrgId: number | null = null): Actor =>
  ({ email: `u${orgId ?? operatorOrgId}@test`, name: "U", role: "staff", orgId, operatorOrgId });
const foothill = actor(null, FOOTHILL), delta = actor(DELTA), basin = actor(null, BASIN), sierra = actor(null, SIERRA), platform = actor(null, PLATFORM);

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

beforeEach(async () => {
  who = null;
  await client.exec(`
    DELETE FROM transfers; DELETE FROM grants; DELETE FROM custody_epochs; DELETE FROM engagement_records;
    DELETE FROM custody_events; DELETE FROM system_shares; DELETE FROM org_instrument_tags;
    DELETE FROM instruments; DELETE FROM house_members; DELETE FROM orgs; DELETE FROM feature_flags;
    INSERT INTO feature_flags (key, enabled) VALUES ('custody.transfers', true);
    INSERT INTO orgs (id, name, kind, is_operator, can_custody, can_service, can_broker) VALUES
      (${PLATFORM}, 'Ridgeline', 'provider', true, false, true, false),
      (${FOOTHILL}, 'Foothill Instruments', 'provider', true, true, true, true),
      (${BASIN}, 'Basin Analytical', 'provider', true, false, false, true),
      (${SIERRA}, 'Sierra Spectra', 'provider', true, false, true, false),
      (${CASCADE}, 'Cascade Service Co', 'provider', true, false, true, false);
    INSERT INTO orgs (id, name, kind, parent_org_id, can_custody) VALUES
      (${DELTA}, 'Delta Diagnostics', 'client', ${PLATFORM}, true),
      (${SHELL}, 'Memberless Lab', 'client', ${PLATFORM}, true);
    INSERT INTO house_members (email, org_id, role) VALUES ('u10@test', ${FOOTHILL}, 'staff');
    INSERT INTO instruments (id, external_id, client, model, category, owner_org_id, tenant_org_id)
      VALUES (${INST}, 'FH-201', 'Foothill Instruments', '6495C', 'LC-MS', ${FOOTHILL}, ${FOOTHILL});
    INSERT INTO custody_epochs (id, instrument_id, n, custodian_org_id, custodian_name, close_kind)
      VALUES (1, ${INST}, 1, ${FOOTHILL}, 'Foothill Instruments', 'open');
    INSERT INTO grants (instrument_id, epoch_id, grantee_org_id, granted_by_org_id, kind)
      VALUES (${INST}, 1, ${SIERRA}, ${FOOTHILL}, 'service');
    INSERT INTO system_shares (instrument_id, org_id, access) VALUES (${INST}, ${FOOTHILL}, 'edit'), (${INST}, ${SIERRA}, 'edit');
    -- Explicit ids above; the serials must start past them or the first row a
    -- transfer inserts collides with the fixture.
    SELECT setval('orgs_id_seq', 100); SELECT setval('custody_epochs_id_seq', 100); SELECT setval('instruments_id_seq', 100);
  `);
  await appendEvent({ instrumentId: INST, kind: "intake", occurredAt: new Date("2026-01-05T12:00:00Z"), authorOrgId: FOOTHILL,
    custodianOrgId: FOOTHILL, whoGrade: "attested", howGrade: "document_only",
    provenance: { findings: "Arrived from auction, lot 22 - the seller's binder mentions a prior HED fault." },
    private: { paid: "11,000" }, sourceKind: "manual", sourceId: "intake", epochId: 1 });
  await appendEvent({ instrumentId: INST, kind: "pm", occurredAt: new Date("2026-02-10T12:00:00Z"), authorOrgId: SIERRA,
    commissionerOrgId: FOOTHILL, custodianOrgId: FOOTHILL, whoGrade: "third_party", howGrade: "procedure_run",
    procedureKeys: [{ key: "6495c/replace-lamp", state: "done", reading: "4.1 mAU" }],
    provenance: { findings: "Lamp replaced; baseline within spec." }, private: { price: "480.00" },
    sourceKind: "manual", sourceId: "pm", epochId: 1 });
  await appendEvent({ instrumentId: INST, kind: "inspection", occurredAt: new Date("2026-05-02T12:00:00Z"), authorOrgId: SIERRA,
    commissionerOrgId: BASIN, custodianOrgId: FOOTHILL, whoGrade: "third_party", howGrade: "procedure_run",
    provenance: { findings: "Detector at 82% of nominal." }, private: { price: "310.00" },
    sourceKind: "manual", sourceId: "exam", epochId: 1 });
});

const eventBySource = async (sourceId: string) =>
  (await testDb.select().from(systemEvents).where(eq(systemEvents.sourceId, sourceId)))[0];

/** Foothill sells to Delta through Basin, withholding the intake's free text. */
async function sellThroughBasin() {
  const started = await T.initiate(foothill, { instrumentId: INST, toOrgId: DELTA, brokerOrgId: BASIN, note: "PO 4471" });
  if (started.error !== undefined) throw new Error(started.error);
  const intake = await eventBySource("intake");
  const reviewed = await T.review(foothill, started.id, [intake.id]);
  if (reviewed.error !== undefined) throw new Error(reviewed.error);
  const sealed = await T.seal(foothill, started.id);
  if (sealed.error !== undefined) throw new Error(sealed.error);
  return { id: started.id, lines: reviewed.lines, ...sealed };
}

describe("initiating", () => {
  it("is the holder's move and nobody else's", async () => {
    expect((await T.initiate(sierra, { instrumentId: INST, toOrgId: DELTA })).error).toMatch(/current holder/);
    expect((await T.initiate(delta, { instrumentId: INST, toOrgId: DELTA })).error).toMatch(/current holder/);
    expect((await T.initiate(foothill, { instrumentId: INST, toOrgId: DELTA })).error).toBeUndefined();
  });

  it("refuses a recipient or broker without the capability", async () => {
    expect((await T.initiate(foothill, { instrumentId: INST, toOrgId: SIERRA })).error).toMatch(/cannot hold custody/);
    expect((await T.initiate(foothill, { instrumentId: INST, toOrgId: DELTA, brokerOrgId: SIERRA })).error).toMatch(/cannot broker/);
  });

  it("allows one transfer in flight per machine", async () => {
    await T.initiate(foothill, { instrumentId: INST, toOrgId: DELTA });
    expect((await T.initiate(foothill, { instrumentId: INST, toOrgId: null })).error).toMatch(/already under way/);
  });
});

describe("review", () => {
  it("shows the tenure as the recipient will read it, and holds back free text only", async () => {
    const { id } = (await T.initiate(foothill, { instrumentId: INST, toOrgId: DELTA })) as { id: number };
    const intake = await eventBySource("intake");
    const res = await T.review(foothill, id, [intake.id]);
    if (res.error !== undefined) throw new Error(res.error);
    const byKind = Object.fromEntries(res.lines.map((l) => [l.kind, l]));
    expect(byKind.intake.provenance.findings).toBe(WITHHELD_MARKER);
    expect(byKind.intake.withheld).toBe(true);
    expect(byKind.pm.provenance.findings).toBe("Lamp replaced; baseline within spec.");
    // Structured provenance never withholds: the reading is the point.
    expect(byKind.pm.procedureKeys).toEqual([{ key: "6495c/replace-lamp", state: "done", reading: "4.1 mAU" }]);
    // And nothing private is in the projection at all.
    expect(JSON.stringify(res.lines)).not.toContain("480.00");
    expect(JSON.stringify(res.lines)).not.toContain("11,000");
  });

  it("cannot seal what has not been reviewed", async () => {
    const { id } = (await T.initiate(foothill, { instrumentId: INST, toOrgId: DELTA })) as { id: number };
    expect((await T.seal(foothill, id)).error).toMatch(/Review what travels/);
  });
});

describe("sealing", () => {
  it("appends the transfer as the last line, freezes a hashed bundle, and closes the tenure", async () => {
    const sealed = await sellThroughBasin();
    const [epoch] = await testDb.select().from(custodyEpochs).where(eq(custodyEpochs.id, 1));
    expect(epoch.closeKind).toBe("sealed");
    expect(epoch.brokerOrgId).toBe(BASIN);
    expect(epoch.sealHash).toBe(sealed.sealHash);

    const chain = await testDb.select().from(systemEvents).where(eq(systemEvents.instrumentId, INST)).orderBy(systemEvents.id);
    const last = chain[chain.length - 1];
    expect(last.kind).toBe("transfer");
    expect(last.epochId).toBe(1);
    expect(last.hash).toBe(sealed.sealHash);
    expect(epoch.closedByEventId).toBe(last.id);
    expect(verifyChain(chain.map((r) => ({ ...r, procedureKeys: r.procedureKeys as never[], provenance: r.provenance as Record<string, unknown> })))).toEqual({ ok: true });

    const [rec] = await testDb.select().from(engagementRecords).where(eq(engagementRecords.id, sealed.bundleRecordId));
    expect(rec.kind).toBe("sealed");
    expect(rec.orgId).toBe(FOOTHILL);
    expect(rec.bundleHash).toBe(sealed.bundleHash);
    expect(T.bundleHash(rec.data as SealedBundle)).toBe(sealed.bundleHash);
    const bundle = rec.data as SealedBundle;
    expect(bundle.chain.map((c) => c.kind)).toEqual(["intake", "pm", "inspection", "transfer"]);
    expect(bundle.chain[0].provenance.findings).toBe(WITHHELD_MARKER);
    // The holder's own bundle keeps their own private dossier; the recipient never gets this object.
    expect(bundle.dossier.system.externalId).toBe("FH-201");
  });

  it("refuses every append into the sealed tenure, from the app and from below it", async () => {
    await sellThroughBasin();
    await expect(appendEvent({ instrumentId: INST, kind: "note", occurredAt: new Date(), authorOrgId: FOOTHILL, custodianOrgId: FOOTHILL,
      whoGrade: "self_reported", howGrade: "typed", sourceKind: "manual", sourceId: "late", epochId: 1 }))
      .rejects.toThrow(/frozen/);
    await expect(client.query(`INSERT INTO system_events (instrument_id, epoch_id, kind, occurred_at, prev_hash, hash) VALUES (${INST}, 1, 'note', now(), 'x', 'y')`))
      .rejects.toThrow(/closed as 'sealed' and is frozen/);
  });

  it("ends every grant on the tenure with a reason, and each grantee keeps a frozen record", async () => {
    await sellThroughBasin();
    const [g] = await testDb.select().from(grants).where(eq(grants.granteeOrgId, SIERRA));
    expect(g.endReason).toBe("epoch_closed");
    expect(g.endedAt).not.toBeNull();
    const theirs = await testDb.select().from(engagementRecords).where(and(eq(engagementRecords.orgId, SIERRA), eq(engagementRecords.kind, "revoked")));
    expect(theirs).toHaveLength(1);
  });

  it("marks the withheld lines, records the moment, and leaves the machine in transit", async () => {
    await sellThroughBasin();
    expect((await eventBySource("intake")).withheld).toBe(true);
    expect((await eventBySource("pm")).withheld).toBe(false);
    const [moved] = await testDb.select().from(custodyEvents);
    expect([moved.kind, moved.fromOrgId, moved.toOrgId]).toEqual(["transfer", FOOTHILL, DELTA]);
    // Sealed, not yet accepted: nobody holds it, and the pointer still says Foothill.
    expect(await T.openEpoch(INST)).toBeNull();
    expect((await testDb.select().from(instruments))[0].ownerOrgId).toBe(FOOTHILL);
  });
});

describe("accepting", () => {
  it("is the recipient's move, opens their tenure, and moves the pointer for the old surfaces", async () => {
    const { id } = await sellThroughBasin();
    expect((await T.accept(foothill, id)).error).toMatch(/recipient/);
    expect((await T.accept(basin, id)).error).toMatch(/recipient/);
    const res = await T.accept(delta, id);
    expect(res.error).toBeUndefined();
    const open = await T.openEpoch(INST);
    expect([open?.n, open?.custodianOrgId, open?.custodianName]).toEqual([2, DELTA, "Delta Diagnostics"]);
    const [inst] = await testDb.select().from(instruments);
    expect(inst.ownerOrgId).toBe(DELTA);
    expect(inst.client).toBe("Delta Diagnostics");
    const shares = await testDb.select().from(systemShares).where(eq(systemShares.instrumentId, INST));
    expect(shares.map((s) => s.orgId).sort()).toEqual([SIERRA, DELTA].sort());
    expect((await testDb.select().from(transfers))[0].status).toBe("accepted");
  });

  it("gives the five parties exactly what the ADR says, from rows a transfer wrote", async () => {
    const { id } = await sellThroughBasin();
    await T.accept(delta, id);
    const open = (await T.openEpoch(INST))!;
    await client.exec(`INSERT INTO grants (instrument_id, epoch_id, grantee_org_id, granted_by_org_id, kind) VALUES (${INST}, ${open.id}, ${CASCADE}, ${DELTA}, 'service');`);
    await appendEvent({ instrumentId: INST, kind: "pm", occurredAt: new Date("2026-07-14T12:00:00Z"), authorOrgId: CASCADE,
      commissionerOrgId: DELTA, custodianOrgId: DELTA, whoGrade: "third_party", howGrade: "typed",
      provenance: { findings: "Quarterly PM complete." }, private: { price: "520.00" }, sourceKind: "manual", sourceId: "s2pm", epochId: open.id });

    const levels = async (v: number) => Object.fromEntries((await custodyContext(v, INST)).epochs.map((e) => [e.epoch.n, e.level]));
    expect(await levels(FOOTHILL)).toEqual({ 1: "full", 2: "none" });
    expect(await levels(BASIN)).toEqual({ 1: "full", 2: "none" });
    expect(await levels(SIERRA)).toEqual({ 1: "full", 2: "none" });
    expect(await levels(DELTA)).toEqual({ 1: "prov", 2: "full" });
    expect(await levels(CASCADE)).toEqual({ 1: "prov", 2: "full" });

    // Delta reads the sealed tenure as provenance: the withheld intake shows
    // the marker, the PM's text shows, no price anywhere.
    const ctx = await custodyContext(DELTA, INST);
    const e1 = ctx.chain.epochs.find((e) => e.n === 1)!;
    const intake = ctx.chain.events.find((e) => e.sourceId === "intake")!;
    const pm = ctx.chain.events.find((e) => e.sourceId === "pm")!;
    expect(eventVisibility(DELTA, intake, e1, ctx.chain).provenance?.findings).toBe(WITHHELD_MARKER);
    expect(eventVisibility(DELTA, pm, e1, ctx.chain)).toMatchObject({ level: "prov", private: null });
    expect(eventVisibility(DELTA, pm, e1, ctx.chain).provenance?.findings).toBe("Lamp replaced; baseline within spec.");
    // Foothill, a party, still reads its own withheld text.
    expect(eventVisibility(FOOTHILL, intake, e1, ctx.chain).provenance?.findings).toContain("prior HED fault");
  });
});

describe("the other endings", () => {
  it("seals to nobody as dormant, and the last holder can resume", async () => {
    const { id } = (await T.initiate(foothill, { instrumentId: INST, toOrgId: null })) as { id: number };
    await T.review(foothill, id, []);
    const sealed = await T.seal(foothill, id);
    expect(sealed.error).toBeUndefined();
    const [epoch] = await testDb.select().from(custodyEpochs).where(eq(custodyEpochs.id, 1));
    expect(epoch.closeKind).toBe("dormant");
    expect((await testDb.select().from(instruments))[0].ownerOrgId).toBeNull();
    expect((await testDb.select().from(custodyEvents))[0].kind).toBe("release");
    expect((await T.resume(delta, INST)).error).toMatch(/last holder/);
    const back = await T.resume(foothill, INST);
    expect(back.error).toBeUndefined();
    expect((await T.openEpoch(INST))?.n).toBe(2);
    // The sealed tenure stays sealed: history continued, never reopened.
    expect((await testDb.select().from(custodyEpochs).where(eq(custodyEpochs.id, 1)))[0].closeKind).toBe("dormant");
  });

  it("lets the recipient decline before the seal with nothing moved, and after it as dormant", async () => {
    const { id } = (await T.initiate(foothill, { instrumentId: INST, toOrgId: DELTA })) as { id: number };
    expect((await T.decline(delta, id)).error).toBeUndefined();
    expect((await testDb.select().from(custodyEpochs).where(eq(custodyEpochs.id, 1)))[0].closeKind).toBe("open");
    const second = await sellThroughBasin();
    expect((await T.decline(delta, second.id)).error).toBeUndefined();
    expect((await testDb.select().from(custodyEpochs).where(eq(custodyEpochs.id, 1)))[0].closeKind).toBe("dormant");
  });

  it("seals as a steward for a memberless client, and says who acted", async () => {
    await client.exec(`
      UPDATE custody_epochs SET custodian_org_id = ${SHELL}, custodian_name = 'Memberless Lab' WHERE id = 1;
      UPDATE instruments SET owner_org_id = ${SHELL}, tenant_org_id = ${PLATFORM} WHERE id = ${INST};
    `);
    expect((await T.initiate(foothill, { instrumentId: INST, toOrgId: DELTA })).error).toMatch(/current holder/);
    const { id } = (await T.initiate(platform, { instrumentId: INST, toOrgId: DELTA })) as { id: number };
    await T.review(platform, id, []);
    expect((await T.seal(platform, id)).error).toBeUndefined();
    const [epoch] = await testDb.select().from(custodyEpochs).where(eq(custodyEpochs.id, 1));
    expect(epoch.closeKind).toBe("steward_sealed");
    const [moved] = await testDb.select().from(custodyEvents);
    const ev = await eventBySource(String(moved.id));
    expect((ev.private as { stewardedBy: string }).stewardedBy).toBe("u1@test");
  });
});

describe("through the server actions", () => {
  it("refuses everything with the flag off, and runs with it on", async () => {
    who = { email: "u10@test", name: "F", role: "staff", orgId: null, operatorOrgId: FOOTHILL, rootOperatorOrgId: PLATFORM };
    const { initiateTransfer } = await import("@/app/actions");
    const { forgetFlags } = await import("@/lib/custody/flags");
    await client.exec(`UPDATE feature_flags SET enabled = false WHERE key = 'custody.transfers'`);
    forgetFlags();
    expect((await initiateTransfer(INST, { toOrgId: DELTA })).error).toMatch(/not enabled/);
    await client.exec(`UPDATE feature_flags SET enabled = true WHERE key = 'custody.transfers'`);
    forgetFlags();
    const res = await initiateTransfer(INST, { toOrgId: DELTA, brokerOrgId: BASIN });
    expect(res.error).toBeUndefined();
    expect(res.id).toBeTruthy();
  });
});

describe("a client handed on without the copy", () => {
  it("grants and tags the same row instead of forking it", async () => {
    const { attachInstead } = await import("@/lib/clientShareData");
    const before = (await testDb.select().from(instruments)).length;
    const made = await attachInstead({
      payload: {
        version: 1, client: { name: "Foothill's client", kind: "client" }, sites: [],
        systems: [{ sourceRef: "FH-201", model: "6495C", category: "LC-MS", location: "", siteName: "", modules: [] }],
        pms: [], parts: [], refs: [], from: { operator: "Foothill", by: "u10@test", on: "2026-09-01" }, note: "",
      } as never,
      senderTenantOrgId: FOOTHILL, destTenantOrgId: CASCADE, actor: "owner@cascade.test",
    });
    expect(made.systems).toBe(1);
    expect((await testDb.select().from(instruments)).length).toBe(before);
    const [g] = await testDb.select().from(grants).where(eq(grants.granteeOrgId, CASCADE));
    expect([g.epochId, g.kind]).toEqual([1, "service"]);
    const [tag] = await testDb.select().from(orgInstrumentTags).where(eq(orgInstrumentTags.orgId, CASCADE));
    expect(tag.instrumentId).toBe(INST);
    expect(tag.externalId).toBeTruthy();
    expect((await testDb.select().from(systemShares).where(eq(systemShares.orgId, CASCADE)))).toHaveLength(1);
  });
});
