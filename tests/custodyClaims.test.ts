// Claims, the three ways they go - and the countersign.
//
// The ADR's promise for a claim is narrow: history enters a new custody when
// the holder cannot or will not seal, and it does so with the holder ASKED,
// the authors WARNED, a window RUN, and the holder's record frozen for them
// exactly as a seal would leave it. Nothing here moves a machine on a serial
// number alone - approveClaim did, and this is what replaces it.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));

const { eq } = await import("drizzle-orm");
const { accessRequests, custodyEpochs, engagementRecords, eventConfirmations, grants, instruments, systemEvents } = schema;
const C = await import("@/lib/custody/claims");
const K = await import("@/lib/custody/countersign");
const T = await import("@/lib/custody/transfer");
const { appendEvent } = await import("@/lib/custody/append");
const { custodyContext } = await import("@/lib/custody/load");
const { eventVisibility, EMBARGOED_MARKER, WITHHELD_MARKER } = await import("@/lib/custody/view");
const { verifyChain } = await import("@/lib/custody/hash");
const { CLAIM_NOTICE_DAYS } = await import("@/lib/custody/policy");

const PLATFORM = 1, LABZEN = 20, SS = 21, NORTHBAY = 23, SHELL = 25;
const INST = 1, DAY = 24 * 3600 * 1000;
const T0 = new Date("2026-09-01T12:00:00Z");
const actor = (orgId: number | null, operatorOrgId: number | null = null) =>
  ({ email: `u${orgId ?? operatorOrgId}@test`, name: "U", role: "staff", orgId, operatorOrgId });
const labzen = actor(null, LABZEN), ss = actor(null, SS), northbay = actor(NORTHBAY), platform = actor(null, PLATFORM);

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

beforeEach(async () => {
  await client.exec(`
    DELETE FROM event_confirmations; DELETE FROM access_requests; DELETE FROM transfers; DELETE FROM grants;
    DELETE FROM custody_epochs; DELETE FROM engagement_records; DELETE FROM custody_events; DELETE FROM system_shares;
    DELETE FROM instruments; DELETE FROM house_members; DELETE FROM orgs;
    INSERT INTO orgs (id, name, kind, is_operator, can_custody, can_service) VALUES
      (${PLATFORM}, 'Ridgeline', 'provider', true, false, true),
      (${LABZEN}, 'LabZen', 'provider', true, true, true),
      (${SS}, 'Sierra Spectra', 'provider', true, false, true);
    INSERT INTO orgs (id, name, kind, parent_org_id, can_custody) VALUES
      (${NORTHBAY}, 'Northbay Labs', 'client', ${PLATFORM}, true),
      (${SHELL}, 'Memberless Lab', 'client', ${PLATFORM}, true);
    INSERT INTO house_members (email, org_id, role) VALUES ('u20@test', ${LABZEN}, 'staff'), ('u21@test', ${SS}, 'staff');
    INSERT INTO instruments (id, external_id, client, model, owner_org_id, tenant_org_id)
      VALUES (${INST}, 'LZ-7', 'LabZen', 'QP2010', ${LABZEN}, ${LABZEN});
    INSERT INTO custody_epochs (id, instrument_id, n, custodian_org_id, custodian_name, close_kind)
      VALUES (1, ${INST}, 1, ${LABZEN}, 'LabZen', 'open');
    INSERT INTO grants (instrument_id, epoch_id, grantee_org_id, granted_by_org_id, kind) VALUES (${INST}, 1, ${SS}, ${LABZEN}, 'service');
    SELECT setval('orgs_id_seq', 100); SELECT setval('custody_epochs_id_seq', 100); SELECT setval('instruments_id_seq', 100);
  `);
  await appendEvent({ instrumentId: INST, kind: "intake", occurredAt: new Date("2026-01-05T12:00:00Z"), authorOrgId: LABZEN, custodianOrgId: LABZEN,
    whoGrade: "attested", howGrade: "document_only", provenance: { findings: "Bought at auction; seller says the turbo was rebuilt." },
    sourceKind: "manual", sourceId: "intake", epochId: 1 });
  await appendEvent({ instrumentId: INST, kind: "pm", occurredAt: new Date("2026-03-10T12:00:00Z"), authorOrgId: SS, custodianOrgId: LABZEN,
    whoGrade: "third_party", howGrade: "procedure_run", procedureKeys: [{ key: "qp2010/clean-ion-source", state: "done" }],
    provenance: { findings: "Source cleaned; the repeller was pitted and replaced." }, private: { price: "640.00" },
    sourceKind: "manual", sourceId: "pm", epochId: 1 });
});

/** Northbay files: the request row, then the notice. */
async function file(now = T0) {
  await client.exec(`INSERT INTO access_requests (id, instrument_id, org_id, kind, requested_by, message) VALUES (50, ${INST}, ${NORTHBAY}, 'claim', 'u23@test', 'We bought this in July; invoice attached.');`);
  const res = await C.noticeClaim(50, null, now);
  if (res.error) throw new Error(res.error);
  return res;
}
const claim = async () => (await testDb.select().from(accessRequests).where(eq(accessRequests.id, 50)))[0];
const epoch1 = async () => (await testDb.select().from(custodyEpochs).where(eq(custodyEpochs.id, 1)))[0];

describe("filing", () => {
  it("sets the window by policy and names who has to be told", async () => {
    const res = await file();
    expect(res.noticeEndsAt!.getTime()).toBe(T0.getTime() + CLAIM_NOTICE_DAYS * DAY);
    const who = await C.noticeAudience(INST);
    expect(who.custodianOrgId).toBe(LABZEN);
    expect(who.stewardOrgId).toBeNull();
    // Sierra wrote a line in the open tenure: its free text is what the window is about.
    expect(who.authorOrgIds).toEqual([SS]);
    expect(C.claimState(await claim(), T0)).toBe("window");
    expect(C.claimState(await claim(), new Date(T0.getTime() + 15 * DAY))).toBe("due");
  });

  it("names the steward when the holder has nobody who can read", async () => {
    await client.exec(`UPDATE custody_epochs SET custodian_org_id = ${SHELL}, custodian_name = 'Memberless Lab' WHERE id = 1; UPDATE instruments SET owner_org_id = ${SHELL} WHERE id = ${INST};`);
    const who = await C.noticeAudience(INST);
    expect(who.stewardOrgId).toBe(PLATFORM);
  });

  it("resolves at once on a dormant machine, leaving the gap as it was", async () => {
    // The holder sealed to nobody and walked away. The gap is already recorded;
    // a claimant should not wait fourteen days for nobody to object.
    const { id } = (await T.initiate(labzen, { instrumentId: INST, toOrgId: null })) as { id: number };
    await T.review(labzen, id, []); await T.seal(labzen, id);
    expect((await epoch1()).closeKind).toBe("dormant");
    const res = await file();
    expect(res.immediate).toBe(true);
    expect((await epoch1()).closeKind).toBe("dormant");
    const open = await T.openEpoch(INST);
    expect([open?.n, open?.custodianOrgId]).toEqual([2, NORTHBAY]);
    expect((await claim()).resolution).toBe("resolved_silent");
  });
});

describe("the holder folded - silence", () => {
  it("does nothing before the window ends, then moves custody and freezes the holder's record", async () => {
    await file();
    const early = await C.runClaimResolutions(new Date(T0.getTime() + 13 * DAY));
    expect(early.resolved).toEqual([]);
    expect((await epoch1()).closeKind).toBe("open");

    const due = new Date(T0.getTime() + CLAIM_NOTICE_DAYS * DAY + 3600_000);
    const late = await C.runClaimResolutions(due);
    expect(late.resolved).toEqual([50]);
    const e1 = await epoch1();
    expect(e1.closeKind).toBe("claimed");
    expect(e1.findingsEmbargoUntil!.getTime()).toBe(T0.getTime() + CLAIM_NOTICE_DAYS * DAY);
    // The holder never turned up and still keeps their bundle, hashed.
    const [bundle] = await testDb.select().from(engagementRecords).where(eq(engagementRecords.orgId, LABZEN));
    expect(bundle.kind).toBe("sealed");
    expect(bundle.bundleHash).toHaveLength(64);
    // Sierra's grant ended and Sierra keeps a record too.
    const [g] = await testDb.select().from(grants).where(eq(grants.granteeOrgId, SS));
    expect(g.endReason).toBe("epoch_closed");
    // The claimant's tenure is open and the pointer follows for the old surfaces.
    const open = await T.openEpoch(INST);
    expect([open?.n, open?.custodianOrgId]).toEqual([2, NORTHBAY]);
    expect((await testDb.select().from(instruments))[0].ownerOrgId).toBe(NORTHBAY);
    // The chain ends in a claim event and still verifies.
    const chain = await testDb.select().from(systemEvents).where(eq(systemEvents.instrumentId, INST)).orderBy(systemEvents.id);
    expect(chain[chain.length - 1].kind).toBe("claim");
    expect(verifyChain(chain.map((r) => ({ ...r, procedureKeys: r.procedureKeys as never[], provenance: r.provenance as Record<string, unknown> })))).toEqual({ ok: true });
    // Running again does nothing: resolved is resolved.
    expect((await C.runClaimResolutions(due)).resolved).toEqual([]);
  });

  it("gives the claimant structure at once and free text only when the clock has run", async () => {
    const noticed = await file();
    await C.runClaimResolutions(new Date(T0.getTime() + CLAIM_NOTICE_DAYS * DAY + 3600_000));
    const ctx = await custodyContext(NORTHBAY, INST);
    const e1 = ctx.chain.epochs.find((e) => e.n === 1)!;
    const pm = ctx.chain.events.find((e) => e.sourceId === "pm")!;
    // Before the embargo lifts (a resolution run late is dated to the window's end regardless):
    const before = eventVisibility(NORTHBAY, pm, e1, ctx.chain, new Date(T0.getTime() + 2 * DAY));
    expect(before.level).toBe("prov");
    expect(before.procedureKeys).toEqual([{ key: "qp2010/clean-ion-source", state: "done" }]);
    expect(before.provenance?.findings).toBe(EMBARGOED_MARKER);
    // After:
    const after = eventVisibility(NORTHBAY, pm, e1, ctx.chain, new Date(noticed.noticeEndsAt!.getTime() + 1));
    expect(after.provenance?.findings).toBe("Source cleaned; the repeller was pitted and replaced.");
    expect(after.private).toBeNull();
    // Sierra, a party to its own line, never waits.
    expect(eventVisibility(SS, pm, e1, ctx.chain, new Date(T0.getTime() + 2 * DAY)).provenance?.findings).toContain("repeller");
  });

  it("lets an author hold back its own line during the window, and that holds forever", async () => {
    await file();
    const pm = (await testDb.select().from(systemEvents).where(eq(systemEvents.sourceId, "pm")))[0];
    expect((await C.withholdOwnLine(labzen, pm.id)).error).toMatch(/author/);
    expect((await C.withholdOwnLine(ss, pm.id)).error).toBeUndefined();
    await C.runClaimResolutions(new Date(T0.getTime() + CLAIM_NOTICE_DAYS * DAY + 3600_000));
    const ctx = await custodyContext(NORTHBAY, INST);
    const e1 = ctx.chain.epochs.find((e) => e.n === 1)!;
    const seen = eventVisibility(NORTHBAY, ctx.chain.events.find((e) => e.sourceId === "pm")!, e1, ctx.chain, new Date("2030-01-01"));
    expect(seen.provenance?.findings).toBe(WITHHELD_MARKER);
    expect(seen.procedureKeys).toHaveLength(1);
  });
});

describe("the holder answers", () => {
  it("by sealing to the claimant, which settles the claim with a better grade", async () => {
    await file();
    const { id } = (await T.initiate(labzen, { instrumentId: INST, toOrgId: NORTHBAY })) as { id: number };
    await T.review(labzen, id, []);
    expect((await T.seal(labzen, id)).error).toBeUndefined();
    await C.markSealedByHolder(INST, NORTHBAY);
    expect((await claim()).resolution).toBe("sealed_by_holder");
    expect((await epoch1()).closeKind).toBe("sealed");
    // The cron finds nothing to do.
    expect((await C.runClaimResolutions(new Date("2030-01-01"))).resolved).toEqual([]);
  });

  it("by objecting, which parks it for a person and stops the clock", async () => {
    await file();
    expect((await C.dispute(northbay, 50, "it is ours")).error).toMatch(/holder, its steward or an author/);
    expect((await C.dispute(ss, 50, "We serviced it for LabZen in March; they still own it.")).error).toBeUndefined();
    expect((await claim()).resolution).toBe("disputed");
    expect((await C.runClaimResolutions(new Date("2030-01-01"))).resolved).toEqual([]);
    expect((await epoch1()).closeKind).toBe("open");
    // The platform decides. Denying moves nothing.
    expect((await C.decideDisputed(platform, 50, false)).error).toBeUndefined();
    expect((await claim()).status).toBe("denied");
    expect((await epoch1()).closeKind).toBe("open");
  });

  it("and a granted dispute runs the same resolution silence would have", async () => {
    await file();
    await C.dispute(labzen, 50, "no");
    expect((await C.decideDisputed(platform, 50, true)).error).toBeUndefined();
    expect((await epoch1()).closeKind).toBe("claimed");
    expect((await T.openEpoch(INST))?.custodianOrgId).toBe(NORTHBAY);
  });
});

describe("the holder is not on the platform", () => {
  it("is the steward's to answer, and a steward seal is what the record says", async () => {
    await client.exec(`UPDATE custody_epochs SET custodian_org_id = ${SHELL}, custodian_name = 'Memberless Lab' WHERE id = 1; UPDATE instruments SET owner_org_id = ${SHELL}, tenant_org_id = ${PLATFORM} WHERE id = ${INST};`);
    await file();
    // The steward can object...
    expect((await C.dispute(platform, 50, "checking")).error).toBeUndefined();
    await client.exec(`UPDATE access_requests SET resolution = '' WHERE id = 50;`);
    // ...or seal on the shell's behalf, which reads as steward_sealed.
    const { id } = (await T.initiate(platform, { instrumentId: INST, toOrgId: NORTHBAY })) as { id: number };
    await T.review(platform, id, []);
    expect((await T.seal(platform, id)).error).toBeUndefined();
    expect((await epoch1()).closeKind).toBe("steward_sealed");
  });
});

describe("countersign", () => {
  it("upgrades an attested line to third-party, records who confirmed, and the chain does not move", async () => {
    const intake = (await testDb.select().from(systemEvents).where(eq(systemEvents.sourceId, "intake")))[0];
    const chainBefore = await testDb.select().from(systemEvents).where(eq(systemEvents.instrumentId, INST)).orderBy(systemEvents.id);
    const req = await K.requestCountersign(intake.id, "Sierra Spectra", "u20@test");
    expect(req.status).toBe("pending");
    // Only Sierra answers for Sierra.
    expect((await K.confirmCountersign(labzen, req.id)).error).toMatch(/provider that was named/);
    expect((await K.confirmCountersign(ss, req.id)).error).toBeUndefined();
    const after = (await testDb.select().from(systemEvents).where(eq(systemEvents.id, intake.id)))[0];
    expect(after.whoGrade).toBe("third_party");
    // The author stays: it is hashed, and the holder did write the line. The
    // confirmation row is what says Sierra stood behind it.
    expect(after.authorOrgId).toBe(LABZEN);
    expect(after.hash).toBe(intake.hash);
    expect(after.prevHash).toBe(intake.prevHash);
    const chainAfter = await testDb.select().from(systemEvents).where(eq(systemEvents.instrumentId, INST)).orderBy(systemEvents.id);
    expect(chainAfter.map((e) => e.hash)).toEqual(chainBefore.map((e) => e.hash));
    expect(verifyChain(chainAfter.map((r) => ({ ...r, procedureKeys: r.procedureKeys as never[], provenance: r.provenance as Record<string, unknown> })))).toEqual({ ok: true });
    const [conf] = await testDb.select().from(eventConfirmations);
    expect([conf.status, conf.orgId, conf.decidedBy]).toEqual(["confirmed", SS, "u21@test"]);
  });

  it("waits as an invitation for a provider not on the platform, then adopts them when they join", async () => {
    const intake = (await testDb.select().from(systemEvents).where(eq(systemEvents.sourceId, "intake")))[0];
    const req = await K.requestCountersign(intake.id, "Cascade Service Co", "u20@test");
    expect(req.status).toBe("invited");
    await client.exec(`INSERT INTO orgs (id, name, kind, is_operator) VALUES (30, 'Cascade Service Co', 'provider', true);`);
    expect(await K.adoptInvitations(30, "cascade service co")).toBe(1);
    const [row] = await testDb.select().from(eventConfirmations);
    expect([row.status, row.orgId]).toEqual(["pending", 30]);
  });

  it("declining leaves the line exactly as the holder wrote it", async () => {
    const intake = (await testDb.select().from(systemEvents).where(eq(systemEvents.sourceId, "intake")))[0];
    const req = await K.requestCountersign(intake.id, "Sierra Spectra", "u20@test");
    expect((await K.declineCountersign(ss, req.id, "not ours")).error).toBeUndefined();
    const after = (await testDb.select().from(systemEvents).where(eq(systemEvents.id, intake.id)))[0];
    expect([after.whoGrade, after.authorOrgId]).toEqual(["attested", LABZEN]);
    expect((await K.requestCountersign(intake.id, "Sierra Spectra", "u20@test")).status).toBe("pending");
  });
});
