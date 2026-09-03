// Paper and screen write the same line.
//
// The promise Phase 7 makes is that a PM ticked on a phone and the same PM
// ticked on a printed sheet, scanned and confirmed, land on the chain as
// byte-identical provenance. If they did not, the chain would say the surface
// mattered when only the work did - and the surface is exactly the kind of
// thing that leaks a shop's habits to the next holder. The reader is
// deterministic too: no model, a fill ratio a test can pin.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));

const { eq } = await import("drizzle-orm");
const { eventDrafts, pmSchedules, sheetInstances, signoffs, systemEvents, tasks, custodyAckRequests } = schema;
const { buildPmEvent, runProblems } = await import("@/lib/custody/pmEvent");
const { buildLayout, isSheetLayout, LAYOUT_VERSION } = await import("@/lib/custody/sheetLayout");
const { readMarks, callState, byUncertainty, FILL_FLOOR } = await import("@/lib/custody/marks");
const { planStatus } = await import("@/lib/custody/plan");
const S = await import("@/lib/custody/sheets");
const { canonical } = await import("@/lib/custody/hash");

const SIERRA = 3, EMERY = 7, INST = 1;
const sierra = { email: "tech@sierra.test", name: "Tech", role: "staff", orgId: null, operatorOrgId: SIERRA };
const lab = { email: "ray@emery.test", name: "Ray", role: "client_editor", orgId: EMERY, operatorOrgId: null };

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

beforeEach(async () => {
  await client.exec(`
    DELETE FROM custody_ack_requests; DELETE FROM signoffs; DELETE FROM event_drafts; DELETE FROM sheet_instances;
    DELETE FROM tasks; DELETE FROM pm_schedules; DELETE FROM procedures; DELETE FROM custody_epochs; DELETE FROM instruments; DELETE FROM orgs;
    INSERT INTO orgs (id, name, kind, is_operator, can_service) VALUES (${SIERRA}, 'Sierra Spectra', 'provider', true, true);
    INSERT INTO orgs (id, name, kind, parent_org_id, can_custody) VALUES (${EMERY}, 'Emery Pharma', 'client', ${SIERRA}, true);
    INSERT INTO instruments (id, external_id, client, model, owner_org_id, tenant_org_id) VALUES (${INST}, 'EP-001', 'Emery Pharma', '6495C', ${EMERY}, ${SIERRA});
    INSERT INTO custody_epochs (id, instrument_id, n, custodian_org_id, custodian_name, close_kind) VALUES (1, ${INST}, 1, ${EMERY}, 'Emery Pharma', 'open');
    INSERT INTO procedures (id, tenant_org_id, asset_type, kind, name, key, interval_days, checklist, parts, result_type) VALUES
      (10, ${SIERRA}, 'Detector', 'task', 'Replace lamp', '6495c/replace-lamp', 180, 'Power down\nSwap the lamp\nRe-baseline', '[{"name":"D2 lamp","number":"G1314-60101"}]', 'pass_fail'),
      (11, ${SIERRA}, 'system', 'test', 'Leak check', 'any/leak-check', 365, '', '', 'reading');
    INSERT INTO pm_schedules (id, tenant_org_id, instrument_id, title, every_days, next_due, procedure_id) VALUES
      (1, ${SIERRA}, ${INST}, 'Replace lamp', 180, '2026-09-01', 10), (2, ${SIERRA}, ${INST}, 'Leak check', 365, '2026-09-01', 11);
    SELECT setval('orgs_id_seq', 100); SELECT setval('custody_epochs_id_seq', 100); SELECT setval('procedures_id_seq', 100); SELECT setval('pm_schedules_id_seq', 100);
  `);
});

const SAME_INPUTS = {
  steps: [
    // No unit here: both surfaces take it from the procedure, never from input.
    { key: "any/leak-check", state: "done" as const, reading: "0.4", condition: "" },
    { key: "6495c/replace-lamp", state: "skip" as const, reason: "no lamp on the van", partNumber: "G1314-60101", lot: "L-771" },
  ],
  findings: "Leak rate fine; lamp still due.",
  privateNotes: "Ray was out; left the report with reception.",
  setVersion: 1,
  technician: "Dana K",
};

describe("one builder", () => {
  it("builds identical provenance from either surface, and keeps the surface private", () => {
    const a = buildPmEvent({ ...SAME_INPUTS, surface: "screen" });
    const b = buildPmEvent({ ...SAME_INPUTS, surface: "sheet" });
    expect(canonical(a.provenance)).toBe(canonical(b.provenance));
    expect(canonical(a.procedureKeys)).toBe(canonical(b.procedureKeys));
    expect(a.private.surface).toBe("screen");
    expect(b.private.surface).toBe("sheet");
    expect(a.howGrade).toBe("procedure_run");
  });

  it("does not care what order the steps arrived in", () => {
    const a = buildPmEvent({ ...SAME_INPUTS, surface: "screen" });
    const b = buildPmEvent({ ...SAME_INPUTS, steps: [...SAME_INPUTS.steps].reverse(), surface: "screen" });
    expect(canonical(a.procedureKeys)).toBe(canonical(b.procedureKeys));
  });

  it("puts the skip reason on the travelling half and the lot on the other", () => {
    const e = buildPmEvent({ ...SAME_INPUTS, surface: "sheet" });
    const lamp = e.procedureKeys.find((k) => k.key === "6495c/replace-lamp")!;
    expect(lamp).toEqual({ key: "6495c/replace-lamp", state: "skip", reason: "no lamp on the van", partNumber: "G1314-60101" });
    expect(JSON.stringify(e.provenance)).not.toContain("L-771");
    expect(JSON.stringify(e.provenance)).not.toContain("reception");
    expect((e.private.lots as Record<string, string>)["6495c/replace-lamp"]).toBe("L-771");
  });

  it("refuses a skip with no reason and a run with no name", () => {
    expect(runProblems({ ...SAME_INPUTS, surface: "screen", steps: [{ key: "x", state: "skip" }] })[0]).toMatch(/reason travels/);
    expect(runProblems({ ...SAME_INPUTS, surface: "screen", technician: "" })[0]).toMatch(/technician/);
  });
});

describe("the layout", () => {
  it("is frozen by version and keeps every box square and on the page", () => {
    const l = buildLayout([{ key: "a", title: "A", reading: true }, { key: "b", title: "B" }]);
    expect(l.version).toBe(LAYOUT_VERSION);
    expect(isSheetLayout(l)).toBe(true);
    for (const r of l.rows) {
      for (const b of [r.done, r.skip, r.na, ...r.comb]) {
        expect(b.x + b.w).toBeLessThanOrEqual(1); expect(b.y + b.h).toBeLessThanOrEqual(1);
      }
      // Square on paper: width fraction x 8.5 == height fraction x 11.
      expect(r.done.w * 8.5).toBeCloseTo(r.done.h * 11, 5);
    }
    expect(l.rows[0].comb).toHaveLength(6);
    expect(l.rows[1].comb).toHaveLength(0);
  });

  it("rejects a layout that came back mangled", () => {
    expect(isSheetLayout({ version: 1, rows: [{ key: "a" }] })).toBe(false);
    expect(isSheetLayout(null)).toBe(false);
  });
});

/** A white page with ink painted into the given boxes. */
function paint(layout: ReturnType<typeof buildLayout>, w: number, h: number, marks: Record<string, ("done" | "skip" | "na")[]>, coverage = 0.8) {
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const r of layout.rows) {
    for (const k of marks[r.key] ?? []) {
      const b = r[k];
      const x0 = Math.round(b.x * w), x1 = Math.round((b.x + b.w) * w), y0 = Math.round(b.y * h), y1 = Math.round((b.y + b.h) * h);
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = ((x1 - x0) / 2) * coverage, ry = ((y1 - y0) / 2) * coverage;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) { const i = (y * w + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = 20; }
      }
    }
  }
  return rgba;
}

describe("the mark reader", () => {
  const layout = buildLayout([{ key: "a", title: "A" }, { key: "b", title: "B" }, { key: "c", title: "C" }]);
  const W = 1275, H = 1650;

  it("reads a filled box as its state, with confidence", () => {
    const marks = readMarks(paint(layout, W, H, { a: ["done"], b: ["skip"] }), W, H, layout);
    expect(marks.map((m) => m.state)).toEqual(["done", "skip", null]);
    expect(marks[0].confidence).toBeGreaterThan(0.6);
    expect(marks[2].confidence).toBeGreaterThan(0.9);
  });

  it("refuses to call a row with two boxes filled, and says so", () => {
    const [m] = readMarks(paint(layout, W, H, { a: ["done", "skip"] }), W, H, layout);
    expect(m.state).toBeNull();
    expect(m.confidence).toBe(0);
  });

  it("does not mistake a faint smudge for a tick", () => {
    expect(callState({ done: FILL_FLOOR / 2, skip: 0, na: 0 }).state).toBeNull();
    expect(callState({ done: 0.5, skip: 0.47, na: 0 }).state).toBeNull();
    expect(callState({ done: 0.6, skip: 0.05, na: 0 })).toMatchObject({ state: "done" });
  });

  it("ignores the printed border, so an empty box reads empty", () => {
    // A 1.5px black border all round, nothing inside.
    const rgba = new Uint8ClampedArray(W * H * 4).fill(255);
    const b = layout.rows[0].done;
    const x0 = Math.round(b.x * W), x1 = Math.round((b.x + b.w) * W), y0 = Math.round(b.y * H), y1 = Math.round((b.y + b.h) * H);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (x - x0 < 2 || x1 - x <= 2 || y - y0 < 2 || y1 - y <= 2) { const i = (y * W + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = 0; }
    }
    expect(readMarks(rgba, W, H, layout)[0].state).toBeNull();
  });

  it("orders the uncertain ones first for the confirm screen", () => {
    const marks = readMarks(paint(layout, W, H, { a: ["done"], b: ["done", "na"] }), W, H, layout);
    expect(byUncertainty(marks)[0].key).toBe("b");
  });
});

describe("the plan, read off the chain", () => {
  const rows = [{ key: "6495c/replace-lamp", title: "Replace lamp", intervalDays: 180 }, { key: "any/leak-check", title: "Leak check", intervalDays: 365 }];
  const ev = (day: string, grade: "attested" | "self_reported" | "third_party", keys: { key: string; state: "done" | "skip"; reason?: string }[]) =>
    ({ occurredAt: new Date(`${day}T12:00:00Z`), whoGrade: grade, procedureKeys: keys });

  it("shows last done from an attested backfill and a self-reported in-house check alike, with the grade", () => {
    const status = planStatus(rows, [
      ev("2025-11-03", "attested", [{ key: "6495c/replace-lamp", state: "done" }]),
      ev("2026-06-01", "self_reported", [{ key: "any/leak-check", state: "done" }]),
    ], "2026-09-03");
    const lamp = status.find((s) => s.key === "6495c/replace-lamp")!, leak = status.find((s) => s.key === "any/leak-check")!;
    expect([lamp.lastDone, lamp.lastGrade, lamp.nextDue]).toEqual(["2025-11-03", "attested", "2026-05-02"]);
    expect([leak.lastDone, leak.lastGrade, leak.nextDue]).toEqual(["2026-06-01", "self_reported", "2027-06-01"]);
  });

  it("calls a skipped step still due, with the reason, until it is done again", () => {
    const status = planStatus(rows, [
      ev("2026-03-01", "third_party", [{ key: "6495c/replace-lamp", state: "done" }]),
      ev("2026-08-30", "third_party", [{ key: "6495c/replace-lamp", state: "skip", reason: "no lamp on the van" }]),
    ], "2026-09-03");
    const lamp = status[0];
    expect(lamp.stillDue).toBe(true);
    expect(lamp.skipReason).toBe("no lamp on the van");
    expect(lamp.lastDone).toBe("2026-03-01");
    const after = planStatus(rows, [ev("2026-09-02", "third_party", [{ key: "6495c/replace-lamp", state: "done" }])], "2026-09-03");
    expect(after[0].stillDue).toBe(false);
  });

  it("orders by when it happened, not when it was typed", () => {
    const status = planStatus(rows, [
      ev("2026-06-01", "self_reported", [{ key: "any/leak-check", state: "done" }]),
      ev("2024-01-01", "attested", [{ key: "any/leak-check", state: "done" }]),
    ], "2026-09-03");
    expect(status[1].lastDone).toBe("2026-06-01");
  });
});

describe("sheet, then screen, through the database", () => {
  it("mints a sheet from the machine's keyed schedules with a frozen layout", async () => {
    const res = await S.mintSheet(INST, sierra);
    expect(res.error).toBeUndefined();
    const sheet = (await S.sheetByToken(res.token!))!;
    expect(sheet.rows.map((r) => r.key).sort()).toEqual(["6495c/replace-lamp", "any/leak-check"]);
    expect(sheet.rows.find((r) => r.key === "any/leak-check")!.reading).toBe(true);
    expect(sheet.rows.find((r) => r.key === "6495c/replace-lamp")!.partNumber).toBe("G1314-60101");
    expect(sheet.layout.rows).toHaveLength(2);
    expect(sheet.status).toBe("printed");
  });

  it("scan -> draft -> confirm files one procedure_run event and closes the sheet", async () => {
    const { token } = await S.mintSheet(INST, sierra);
    const sheet = (await S.sheetByToken(token!))!;
    const lampMark = { key: "6495c/replace-lamp", state: "skip" as const, confidence: 0.9, fill: { done: 0, skip: 0.7, na: 0 } };
    const leakMark = { key: "any/leak-check", state: null, confidence: 0, fill: { done: 0.3, skip: 0.28, na: 0 } };
    const drafted = await S.draftFromScan(token!, [lampMark, leakMark], { fileName: "sheet.jpg", url: "https://blob.test/sheet.jpg", size: 1200 }, sierra);
    expect(drafted.draftId).toBeTruthy();
    expect((await S.sheetByToken(token!))!.status).toBe("uploaded");

    const confirmed = await S.confirmDraft(drafted.draftId!, {
      // The person resolves the box the reader could not, and types the reading.
      steps: { "any/leak-check": { state: "done", reading: "0.4" }, "6495c/replace-lamp": { reason: "no lamp on the van", lot: "L-771" } },
      findings: SAME_INPUTS.findings, privateNotes: SAME_INPUTS.privateNotes, technician: "Dana K",
    }, sierra);
    expect(confirmed.error).toBeUndefined();
    const [e] = await testDb.select().from(systemEvents).where(eq(systemEvents.id, confirmed.eventId!));
    expect([e.kind, e.howGrade, e.sourceKind, e.whoGrade, e.epochId]).toEqual(["pm", "procedure_run", "scan", "third_party", 1]);
    expect((e.private as { surface: string }).surface).toBe("sheet");
    expect((await testDb.select().from(sheetInstances).where(eq(sheetInstances.id, sheet.id)))[0]).toMatchObject({ status: "confirmed", eventId: e.id });
    expect((await testDb.select().from(eventDrafts))[0].confirmedEventId).toBe(e.id);
    // The technician signed it in-app.
    const [sig] = await testDb.select().from(signoffs);
    expect([sig.role, sig.platform, sig.eventId, sig.signerName]).toEqual(["technician", true, e.id, "Dana K"]);
    // And the stored plan followed, for the surfaces that still read it.
    const scheds = await testDb.select().from(pmSchedules).orderBy(pmSchedules.id);
    expect(scheds.find((s) => s.id === 2)!.lastDone).not.toBe("");
    expect(scheds.find((s) => s.id === 1)!.lastDone).toBe(""); // skipped: not done
    // Confirming twice is refused.
    expect((await S.confirmDraft(drafted.draftId!, { steps: {}, findings: "", privateNotes: "", technician: "x" }, sierra)).error).toMatch(/Already filed/);
  });

  it("the run screen files the same provenance, byte for byte", async () => {
    const { token } = await S.mintSheet(INST, sierra);
    const drafted = await S.draftFromScan(token!, [
      { key: "6495c/replace-lamp", state: "skip", confidence: 0.9, fill: { done: 0, skip: 0.7, na: 0 } },
      { key: "any/leak-check", state: "done", confidence: 0.9, fill: { done: 0.7, skip: 0, na: 0 } },
    ], null, sierra);
    const viaSheet = await S.confirmDraft(drafted.draftId!, {
      steps: { "any/leak-check": { reading: "0.4" }, "6495c/replace-lamp": { reason: "no lamp on the van", lot: "L-771" } },
      findings: SAME_INPUTS.findings, privateNotes: SAME_INPUTS.privateNotes, technician: "Dana K",
    }, sierra);
    const viaScreen = await S.submitRun(INST, SAME_INPUTS, sierra);
    expect(viaSheet.error).toBeUndefined(); expect(viaScreen.error).toBeUndefined();
    const [a] = await testDb.select().from(systemEvents).where(eq(systemEvents.id, viaSheet.eventId!));
    const [b] = await testDb.select().from(systemEvents).where(eq(systemEvents.id, viaScreen.eventId!));
    expect(canonical(a.provenance)).toBe(canonical(b.provenance));
    expect(canonical(a.procedureKeys)).toBe(canonical(b.procedureKeys));
    expect([a.sourceKind, b.sourceKind]).toEqual(["scan", "task"]);
    // The run also filed a Done pm task, so the old visit count still sees it.
    const [t] = await testDb.select().from(tasks);
    expect([t.state, t.origin, t.findings]).toEqual(["Done", "pm", SAME_INPUTS.findings]);
  });

  it("asks the lab to acknowledge, and only the lab can sign - and it never gates the event", async () => {
    const run = await S.submitRun(INST, SAME_INPUTS, sierra);
    const asked = await S.requestAck(run.eventId!, sierra);
    expect([asked.error, asked.custodianOrgId]).toEqual([undefined, EMERY]);
    expect((await S.signAck(asked.requestId!, "Dana K", "", sierra)).error).toMatch(/organization holding/);
    expect((await S.signAck(asked.requestId!, "Ray Diaz", "Lab manager", lab)).error).toBeUndefined();
    const sigs = await testDb.select().from(signoffs).orderBy(signoffs.id);
    expect(sigs.map((s) => s.role)).toEqual(["technician", "custodian_ack"]);
    expect(sigs[1].platform).toBe(true);
    expect((await testDb.select().from(custodyAckRequests))[0].status).toBe("signed");
    // The event existed before anybody acknowledged anything.
    expect((await testDb.select().from(systemEvents).where(eq(systemEvents.id, run.eventId!)))).toHaveLength(1);
  });
});
