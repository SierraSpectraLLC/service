// Putting a job on the right machine, after the fact.
//
// A call comes in as "the Edwards pump is whining" and lands on whichever
// stack the person on the phone picked - or on nothing at all. What it was
// really about is known later, and by then the job carries hours, parts and a
// service report that all name the wrong thing. Edit re-files it.
//
// What is pinned here: the job moves, its own work moves with it, another
// client's instrument is not somewhere a job can be moved to, and a module
// belongs to the system it is fitted to.
//
// Real Postgres, in-process, from the same DDL every deploy applies.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");
const { eq } = await import("drizzle-orm");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));

type Who = {
  email: string; name: string; role: string;
  orgId: number | null; operatorOrgId: number | null; rootOperatorOrgId: number | null;
};
let who: Who;
vi.mock("@/auth", () => ({ auth: async () => ({ user: who }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const SIERRA = 1, UCSF = 2, OTHER = 3;
const ULTIMA = 1, QTOF = 2, THEIRS = 3;          // systems
const PUMP = 1, AUTOSAMPLER = 2, THEIR_PUMP = 3; // units
const SLOW = 30_000;

const OWNER: Who = {
  email: "joe@sierra.test", name: "Joe Harris", role: "owner",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: SIERRA,
};

/** The edit form always posts the whole job; only the equipment differs here. */
const EDIT = {
  title: "E2M18 High-Pitched Sound",
  body: "One of our Edwards pumps is making a high-pitched sound.",
  severity: "Down", assignee: "Bill Harner",
};

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator, parent_org_id) VALUES
      (${SIERRA}, 'Sierra Spectra', 'provider', true,  NULL),
      (${UCSF},   'UCSF',           'client',   false, ${SIERRA}),
      (${OTHER},  'Emery Pharma',   'client',   false, ${SIERRA});
    INSERT INTO app_settings (id, operator_org_id) VALUES (1, ${SIERRA});
    INSERT INTO house_members (email, org_id, role, name) VALUES
      ('joe@sierra.test', ${SIERRA}, 'owner', 'Joe Harris');

    INSERT INTO instruments (id, tenant_org_id, external_id, client, manufacturer, name, model, owner_org_id) VALUES
      (${ULTIMA}, ${SIERRA}, 'Q-ULT',  'UCSF', 'Edwards', 'Ultima', 'Ultima', ${UCSF}),
      (${QTOF},   ${SIERRA}, 'Q-TOF1', 'UCSF', 'Waters',  'Q-TOF',  'Xevo',   ${UCSF}),
      (${THEIRS}, ${SIERRA}, 'EM-1',   'Emery Pharma', 'Thermo', 'UPLC', 'Vanquish', ${OTHER});

    INSERT INTO assets (id, tenant_org_id, instrument_id, kind, model, serial, owner_org_id) VALUES
      (${PUMP},        ${SIERRA}, ${ULTIMA}, 'Rotary Vane Pump', 'E2M18', 'RV-77', ${UCSF}),
      (${AUTOSAMPLER}, ${SIERRA}, ${QTOF},   'Autosampler',      'G4226A', 'DE-11', ${UCSF}),
      (${THEIR_PUMP},  ${SIERRA}, ${THEIRS}, 'Pump',             'VF-P10', '8339399', ${OTHER});
  `);
});

/** The job as the phone took it: on the wrong stack, with work already on it. */
beforeEach(async () => {
  who = OWNER;
  await client.exec(`
    DELETE FROM audit_log; DELETE FROM parts; DELETE FROM time_entries; DELETE FROM work_orders;
    INSERT INTO work_orders (id, tenant_org_id, number, instrument_id, org_id, requested_by, title, body,
                             severity, state, assignee, opened_on) VALUES
      (1, ${SIERRA}, '030305_W1', ${QTOF}, ${UCSF}, 'Joe Harris', '${EDIT.title}',
       '${EDIT.body}', 'Down', 'resolved', 'Bill Harner', '2026-09-14');

    INSERT INTO time_entries (tenant_org_id, instrument_id, work_order_id, person, date, minutes, category, billable) VALUES
      (${SIERRA}, ${QTOF}, 1, 'Bill Harner', '2026-09-17', 60, 'onsite', false);

    INSERT INTO parts (id, instrument_id, work_order_id, name, part_number, qty, status, owner_org_id) VALUES
      (1, ${QTOF}, 1, 'Pump oil', 'OIL-1', '1', 'Installed', ${UCSF});
  `);
});

describe("re-filing a job", () => {
  it("moves it onto the right system, and its hours and parts with it", async () => {
    const { updateWorkOrder } = await import("@/app/actions");
    const res = await updateWorkOrder(1, { ...EDIT, instrumentId: ULTIMA });
    expect(res.error).toBeUndefined();

    const [wo] = await testDb.select().from(schema.workOrders);
    expect(wo.instrumentId).toBe(ULTIMA);
    // The visit belongs to the machine it happened on, or the Q-TOF keeps a
    // service history it never had.
    const [t] = await testDb.select().from(schema.timeEntries);
    const [part] = await testDb.select().from(schema.parts);
    expect(t.instrumentId).toBe(ULTIMA);
    expect(part.instrumentId).toBe(ULTIMA);

    const log = await testDb.select().from(schema.auditLog);
    expect(log.some((l) => l.field === "equipment" && l.action.includes("Q-ULT"))).toBe(true);
  }, SLOW);

  it("names the module the work was on, and the report prints its serial", async () => {
    const { updateWorkOrder } = await import("@/app/actions");
    const { serviceReportDraft } = await import("@/lib/serviceReportData");
    await updateWorkOrder(1, { ...EDIT, instrumentId: ULTIMA, assetId: PUMP });

    const [wo] = await testDb.select().from(schema.workOrders);
    expect(wo.assetId).toBe(PUMP);

    const draft = await serviceReportDraft(1);
    expect(draft?.report.instrument).toMatchObject({
      type: "Edwards Ultima",              // the system, as its nameplate reads
      module: "Rotary Vane Pump E2M18",    // the unit the visit was about
      serial: "RV-77",                     // and the unit's own serial
    });
  }, SLOW);

  it("takes the module off when the system moves out from under it", async () => {
    const { updateWorkOrder } = await import("@/app/actions");
    await updateWorkOrder(1, { ...EDIT, instrumentId: ULTIMA, assetId: PUMP });
    // The pump is fitted to the Ultima. Moving the job to the Q-TOF and
    // keeping the pump would put this visit on two machines at once.
    const res = await updateWorkOrder(1, { ...EDIT, instrumentId: QTOF, assetId: PUMP });
    expect(res.error).toMatch(/fitted to another system/);
    const [wo] = await testDb.select().from(schema.workOrders);
    expect(wo.instrumentId).toBe(ULTIMA);
  }, SLOW);

  it("will not move a job onto another client's instrument", async () => {
    const { updateWorkOrder } = await import("@/app/actions");
    const res = await updateWorkOrder(1, { ...EDIT, instrumentId: THEIRS });
    expect(res.error).toMatch(/belongs to Emery Pharma/);
    const [wo] = await testDb.select().from(schema.workOrders);
    expect(wo.instrumentId).toBe(QTOF);
  }, SLOW);

  it("leaves the equipment alone when the form does not send any", async () => {
    const { updateWorkOrder } = await import("@/app/actions");
    await updateWorkOrder(1, { ...EDIT, title: "A better title" });
    const [wo] = await testDb.select().from(schema.workOrders);
    expect(wo.title).toBe("A better title");
    expect(wo.instrumentId).toBe(QTOF);
    expect(await testDb.select().from(schema.auditLog).where(eq(schema.auditLog.field, "equipment"))).toHaveLength(0);
  }, SLOW);

  it("takes a job off a record entirely, when it turns out to be about nothing on file", async () => {
    const { updateWorkOrder } = await import("@/app/actions");
    const res = await updateWorkOrder(1, { ...EDIT, instrumentId: null, assetId: null });
    expect(res.error).toBeUndefined();
    const [wo] = await testDb.select().from(schema.workOrders);
    expect(wo.instrumentId).toBeNull();
  }, SLOW);
});

/*
 * The day a job is wanted by.
 *
 * "It says waiting - late but we already planned with the client to install
 * the new pump on 10/20." Lateness was severity plus the day it was raised:
 * a Down job was red from its second day for ever, whatever anybody had since
 * agreed. The date beats the assumption.
 */
describe("moving the day it is wanted by", () => {
  it("saves the agreed date and stops calling the job late", async () => {
    const { updateWorkOrder } = await import("@/app/actions");
    const { woLate, woLine } = await import("@/lib/workOrders");
    await client.exec(`UPDATE work_orders SET state = 'waiting' WHERE id = 1;`);

    const before = (await testDb.select().from(schema.workOrders))[0];
    expect(woLate(before, "2026-09-19")).toBe(true);
    expect(woLine(before, "2026-09-19")).toContain("late");

    expect((await updateWorkOrder(1, { ...EDIT, dueOn: "2026-10-20" })).error).toBeUndefined();
    const [after] = await testDb.select().from(schema.workOrders);
    expect(after.dueOn).toBe("2026-10-20");
    expect(woLate(after, "2026-09-19")).toBe(false);
    expect(woLine(after, "2026-09-19")).not.toContain("late");
    // And it is late again once the day somebody promised has passed.
    expect(woLate(after, "2026-10-21")).toBe(true);
  }, SLOW);

  it("says so in the log, in words rather than a field name", async () => {
    const { updateWorkOrder } = await import("@/app/actions");
    await updateWorkOrder(1, { ...EDIT, dueOn: "2026-10-20" });
    const moved = await testDb.select().from(schema.auditLog).where(eq(schema.auditLog.field, "dueOn"));
    expect(moved[0].action).toContain("is wanted by 2026-10-20");

    await updateWorkOrder(1, { ...EDIT, dueOn: "2026-10-27" });
    const again = await testDb.select().from(schema.auditLog).where(eq(schema.auditLog.field, "dueOn"));
    expect(again[again.length - 1].action).toContain("was 2026-10-20");
  }, SLOW);

  it("clears back to whatever the severity implies", async () => {
    const { updateWorkOrder } = await import("@/app/actions");
    const { dueDay } = await import("@/lib/workOrders");
    await updateWorkOrder(1, { ...EDIT, dueOn: "2026-10-20" });
    expect((await updateWorkOrder(1, { ...EDIT, dueOn: "" })).error).toBeUndefined();

    const [wo] = await testDb.select().from(schema.workOrders);
    expect(wo.dueOn).toBe("");
    expect(dueDay(wo)).toBe("2026-09-14");      // Down, opened that day
    const cleared = await testDb.select().from(schema.auditLog).where(eq(schema.auditLog.field, "dueOn"));
    expect(cleared[cleared.length - 1].action).toContain("goes back to the date its severity implies");
  }, SLOW);

  it("refuses something that is not a date, and changes nothing", async () => {
    const { updateWorkOrder } = await import("@/app/actions");
    const res = await updateWorkOrder(1, { ...EDIT, title: "Renamed too", dueOn: "next Tuesday" });
    expect(res.error).toMatch(/YYYY-MM-DD/);
    const [wo] = await testDb.select().from(schema.workOrders);
    expect(wo.dueOn).toBe("");
    expect(wo.title).not.toBe("Renamed too");   // the whole edit is refused, not half of it
  }, SLOW);

  it("leaves the date alone when the form does not send one", async () => {
    const { updateWorkOrder } = await import("@/app/actions");
    await updateWorkOrder(1, { ...EDIT, dueOn: "2026-10-20" });
    await updateWorkOrder(1, { ...EDIT, title: "A better title" });
    const [wo] = await testDb.select().from(schema.workOrders);
    expect(wo.dueOn).toBe("2026-10-20");
  }, SLOW);
});
