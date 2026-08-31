// One tap: this maintenance was done, now - and taking the tap back.
//
// The PM run is built from completePmNow, so what is pinned here is what one
// tap is allowed to mean. It must leave exactly what completing the job the
// long way leaves - a Done task as the record, the schedule advanced FROM
// TODAY, the appointment cleared - and it must refuse the two things a tap
// must never do: close a measurement without its number, and duplicate a job
// that already has an open task.
//
// Undo is the other edge. A tap is easy to slip on a phone, so it can be taken
// back - but only while the record is untouched and today's, because "undo"
// against work somebody actually did is deletion wearing a friendly name.
//
// Real Postgres, in-process, from the same DDL every deploy applies.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

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
vi.mock("@/lib/shopday", async (orig) => ({
  ...(await orig<typeof import("@/lib/shopday")>()),
  shopToday: () => "2026-09-01",
}));

const ROOT = 1, SIERRA = 2, LABZEN = 3;
const SYS = 1, PUMP = 1;

const TECH: Who = {
  email: "tech@sierra.test", name: "Steve Jones", role: "staff",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: ROOT,
};

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator, parent_org_id) VALUES
      (${ROOT},   'Ridgeline',      'provider', true,  NULL),
      (${SIERRA}, 'Sierra Spectra', 'provider', true,  NULL),
      (${LABZEN}, 'Lab Zen',        'client',   false, ${SIERRA});
    INSERT INTO app_settings (id, operator_org_id) VALUES (1, ${ROOT});
    INSERT INTO house_members (email, org_id, role, name) VALUES
      ('tech@sierra.test', ${SIERRA}, 'staff', 'Steve Jones');

    INSERT INTO instruments (id, tenant_org_id, owner_org_id, external_id, client, model) VALUES
      (${SYS}, ${SIERRA}, ${LABZEN}, 'LZ-1', 'Lab Zen', 'LC-MS');
    INSERT INTO assets (id, tenant_org_id, instrument_id, kind, model) VALUES
      (${PUMP}, ${SIERRA}, ${SYS}, 'Pump', 'G7120A');

    -- A measured procedure, for the result gate: a leak test wants a number.
    INSERT INTO procedures (id, asset_type, name, kind, result_type, target, interval_days)
      VALUES (9001, 'Pump', 'Pump leak rate test', 'test', 'numeric', '30', 365);
  `);
});

let schedId = 0;
beforeEach(async () => {
  who = TECH;
  await client.exec(`DELETE FROM task_results; DELETE FROM checklist_items; DELETE FROM tasks; DELETE FROM pm_schedules;`);
  const r = await client.query<{ id: number }>(`
    INSERT INTO pm_schedules (tenant_org_id, instrument_id, title, every_days, next_due, last_done, booked_on, booked_note)
    VALUES (${SIERRA}, ${SYS}, 'Drain & replace oil', 365, '2026-09-10', '2025-09-10', '2026-09-03', 'window 9-12')
    RETURNING id;`);
  schedId = r.rows[0].id;
});

const sched = async () => {
  const { pmSchedules } = schema;
  const { eq } = await import("drizzle-orm");
  return (await testDb.select().from(pmSchedules).where(eq(pmSchedules.id, schedId)))[0];
};
const allTasks = async () => testDb.select().from(schema.tasks);

describe("one tap completes a cycle", () => {
  it("files the record, advances from today, clears the booking", async () => {
    const { completePmNow } = await import("@/app/actions");
    const res = await completePmNow(schedId);
    expect(res.error).toBeUndefined();

    const s = await sched();
    // Advanced from the day the work was DONE, the same rule the task path
    // applies - doing it nine days early must not owe the next one early.
    expect(s.lastDone).toBe("2026-09-01");
    expect(s.nextDue).toBe("2027-09-01");
    // The appointment is spent: the visit happened.
    expect(s.bookedOn).toBe("");
    expect(s.bookedNote).toBe("");

    const [t] = await allTasks();
    expect(t.state).toBe("Done");
    expect(t.pmScheduleId).toBe(schedId);
    expect(t.origin).toBe("pm");
    // The record says what was OWED; completedAt says when it was met.
    expect(t.dueDate).toBe("2026-09-10");
    expect(t.assignee).toBe("Steve Jones");
    expect(t.instrumentId).toBe(SYS);
  });

  it("completes the open task instead of filing a second record", async () => {
    // One job, one record - a schedule already in flight goes through its
    // task, so the advance and the audit run once.
    const { completePmNow, runPmNow } = await import("@/app/actions");
    const started = await runPmNow(schedId);
    expect(started.taskId).toBeTruthy();

    const res = await completePmNow(schedId);
    expect(res.error).toBeUndefined();
    expect(res.viaOpenTask).toBe(true);
    expect(res.taskId).toBe(started.taskId);

    const rows = await allTasks();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("Done");
    expect((await sched()).nextDue).toBe("2027-09-01");
  });

  it("refuses to close a measurement without its number", async () => {
    /*
     * The result gate, unchanged by the shortcut. A leak-rate test completed
     * by tap with no reading is a checkbox claiming to be a measurement -
     * the same rule setTaskState enforces, refused before anything writes.
     */
    const { completePmNow } = await import("@/app/actions");
    await client.exec(`UPDATE pm_schedules SET procedure_id = 9001, title = 'Pump leak rate test' WHERE id = ${schedId};`);
    const res = await completePmNow(schedId);
    expect(res.error).toContain("records a result");
    expect(await allTasks()).toEqual([]);
    expect((await sched()).nextDue).toBe("2026-09-10");
  });

  it("refuses a paused schedule", async () => {
    const { completePmNow } = await import("@/app/actions");
    await client.exec(`UPDATE pm_schedules SET paused = true WHERE id = ${schedId};`);
    expect((await completePmNow(schedId)).error).toContain("paused");
  });

  it("carries the note onto the record", async () => {
    const { completePmNow } = await import("@/app/actions");
    await completePmNow(schedId, "Oil was dark - flushed twice");
    expect((await allTasks())[0].body).toContain("Oil was dark");
  });
});

describe("taking the tap back", () => {
  const PRIOR = { nextDue: "2026-09-10", lastDone: "2025-09-10", bookedOn: "2026-09-03", bookedNote: "window 9-12" };

  it("removes the record and puts the calendar back, booking included", async () => {
    const { completePmNow, undoPmComplete } = await import("@/app/actions");
    const { taskId } = await completePmNow(schedId);
    const res = await undoPmComplete(schedId, taskId!, PRIOR);
    expect(res.error).toBeUndefined();
    expect(await allTasks()).toEqual([]);
    const s = await sched();
    expect(s.nextDue).toBe("2026-09-10");
    expect(s.lastDone).toBe("2025-09-10");
    expect(s.bookedOn).toBe("2026-09-03");
    expect(s.bookedNote).toBe("window 9-12");
  });

  it("refuses once a result has been recorded against the task", async () => {
    // Work somebody did is not a slip.
    const { completePmNow, undoPmComplete } = await import("@/app/actions");
    const { taskId } = await completePmNow(schedId);
    await client.exec(`
      INSERT INTO task_results (task_id, result_type, value, passed, recorded_by)
      VALUES (${taskId}, 'numeric', '28', true, 'Steve Jones');`);
    expect((await undoPmComplete(schedId, taskId!, PRIOR)).error).toContain("result");
    expect(await allTasks()).toHaveLength(1);
  });

  it("never deletes a worked task - a checklist means it went the long way", async () => {
    /*
     * The path check. A tap-filed record has no checklist rows; a generated
     * task carries the procedure's boxes. Undo of THAT completion belongs in
     * Tasks (reopen), because deleting a task somebody ticked boxes on is not
     * an undo.
     */
    const { completePmNow, undoPmComplete } = await import("@/app/actions");
    const { taskId } = await completePmNow(schedId);
    await client.exec(`INSERT INTO checklist_items (task_id, text, done) VALUES (${taskId}, 'Drain', true);`);
    expect((await undoPmComplete(schedId, taskId!, PRIOR)).error).toContain("worked task");
    expect(await allTasks()).toHaveLength(1);
  });

  it("refuses when today holds no completion", async () => {
    const { undoPmComplete } = await import("@/app/actions");
    expect((await undoPmComplete(schedId, 999, PRIOR)).error).toContain("Nothing completed today");
  });

  it("refuses a prior that disagrees with what the record says was owed", async () => {
    // The one server-recoverable fact, used as a floor on the client's word.
    const { completePmNow, undoPmComplete } = await import("@/app/actions");
    const { taskId } = await completePmNow(schedId);
    const res = await undoPmComplete(schedId, taskId!, { ...PRIOR, nextDue: "2030-01-01" });
    expect(res.error).toBeTruthy();
    expect(await allTasks()).toHaveLength(1);
  });
});
