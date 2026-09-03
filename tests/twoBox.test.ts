// The split, made at the keystroke, checked at the door.
//
// Phase 4's promise is narrow and has to be absolute: no new event lands on a
// machine's chain with a customer's site, contact or price on the half that
// travels. Two things hold it up. The forms put each sentence where its author
// said, and appendEvent refuses anything that gets past them anyway - because
// a leak that reaches a stranger's screen in 2031 is not a bug report, it is a
// customer's address in somebody else's hands.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });

type Who = {
  email: string; name: string; role: string;
  orgId: number | null; operatorOrgId: number | null; rootOperatorOrgId: number | null;
} | null;
let who: Who = null;

vi.mock("@/db", () => ({ db: testDb }));
vi.mock("@/auth", () => ({ auth: async () => (who ? { user: who } : null) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));

const { eq } = await import("drizzle-orm");
const { systemEvents, orgs, tasks, workOrders } = schema;
const { checkEvent, appendEvent } = await import("@/lib/custody/append");
const { PROVENANCE_DENYLIST, provenanceLeaks } = await import("@/lib/custody/policy");
const capabilities = (await import("../scripts/backfill-org-capabilities")).main;

const SIERRA = 3, EMERY = 7, INST = 1;
const JOE: Who = {
  email: "joe@sierra.test", name: "Joe", role: "owner",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: SIERRA,
};

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

beforeEach(async () => {
  who = JOE;
  await client.exec(`
    DELETE FROM task_results; DELETE FROM checklist_items; DELETE FROM tasks;
    DELETE FROM work_orders; DELETE FROM pm_schedules; DELETE FROM discussion_posts;
    DELETE FROM system_shares; DELETE FROM instruments; DELETE FROM house_members; DELETE FROM orgs;
    INSERT INTO orgs (id, name, kind, is_operator) VALUES (${SIERRA}, 'Sierra Spectra', 'provider', true);
    INSERT INTO orgs (id, name, kind, parent_org_id) VALUES (${EMERY}, 'Emery Pharma', 'client', ${SIERRA});
    INSERT INTO house_members (email, org_id, role, name) VALUES ('joe@sierra.test', ${SIERRA}, 'owner', 'Joe');
    INSERT INTO instruments (id, external_id, client, model, category, owner_org_id, tenant_org_id)
      VALUES (${INST}, 'EP-001', 'Emery Pharma', '6495C', 'LC-MS', ${EMERY}, ${SIERRA});
    INSERT INTO pm_schedules (id, tenant_org_id, instrument_id, title, every_days, next_due)
      VALUES (1, ${SIERRA}, ${INST}, 'Quarterly PM', 90, '2026-09-01');
  `);
});

const events = () => testDb.select().from(systemEvents).where(eq(systemEvents.instrumentId, INST));
const LEAKY = "Room 2 at the Hayward site, call Ray on 555-0100, cost 480.00";

/** The whole point, as one assertion. */
const expectSplit = (row: typeof systemEvents.$inferSelect, travels: string, stays: string) => {
  const prov = row.provenance as Record<string, unknown>;
  const priv = row.private as Record<string, unknown>;
  expect(row.kind).not.toBe("");
  expect(provenanceLeaks(prov)).toEqual([]);
  expect(JSON.stringify(prov)).toContain(travels);
  expect(JSON.stringify(prov)).not.toContain("555-0100");
  expect(JSON.stringify(prov)).not.toContain("Hayward");
  expect(JSON.stringify(priv)).toContain(stays);
};

describe("a past job, logged with two boxes", () => {
  it("files one event with the findings travelling and the aside staying", async () => {
    const { logPastWorkOrder } = await import("@/app/actions");
    const res = await logPastWorkOrder({ instrumentId: INST, assetId: null }, {
      title: "Lamp change", summary: "Replaced the D2 lamp; baseline back in spec.",
      date: "2026-03-04", privateNotes: LEAKY,
    });
    expect(res.error).toBeUndefined();
    const rows = await events();
    expect(rows).toHaveLength(1);
    expectSplit(rows[0], "Replaced the D2 lamp", "555-0100");
    expect((rows[0].private as { notes: string }).notes).toBe(LEAKY);
    expect((rows[0].provenance as { findings: string }).findings).toBe("Replaced the D2 lamp; baseline back in spec.");
  });

  it("leaves the old single-field form exactly as it was when nothing private is sent", async () => {
    const { logPastWorkOrder } = await import("@/app/actions");
    await logPastWorkOrder({ instrumentId: INST, assetId: null }, {
      title: "Lamp change", summary: "Replaced the D2 lamp.", date: "2026-03-04",
    });
    const [wo] = await testDb.select().from(workOrders);
    expect(wo.privateNotes).toBe("");
    const [row] = await events();
    expect((row.private as { notes: string }).notes).toBe("");
  });
});

describe("a live job, resolved then closed", () => {
  it("keeps the private aside off the chain's travelling half", async () => {
    await client.exec(`
      INSERT INTO work_orders (id, tenant_org_id, number, instrument_id, org_id, title, severity, state, opened_on)
      VALUES (5, ${SIERRA}, 'WO-1005', ${INST}, ${EMERY}, 'HED fault', 'Down', 'active', '2026-05-01');
    `);
    const { resolveWorkOrder, setWorkOrderState } = await import("@/app/actions");
    const r1 = await resolveWorkOrder(5, "Replaced the HED supply and verified the tune.", LEAKY);
    expect(r1.error).toBeUndefined();
    // Nothing on the chain yet: resolved is finished work with the record still
    // open for correction. closedAt is the day it happened.
    expect(await events()).toHaveLength(0);
    const r2 = await setWorkOrderState(5, "closed");
    expect(r2.error).toBeUndefined();
    const [row] = await events();
    expectSplit(row, "Replaced the HED supply", "555-0100");
    expect(row.kind).toBe("repair");
    expect((row.private as { notes: string }).notes).toBe(LEAKY);
  });
});

describe("a PM, completed and backfilled", () => {
  it("carries findings on the travelling half and the note on the other", async () => {
    const { completePmNow } = await import("@/app/actions");
    const res = await completePmNow(1, LEAKY, "Source cleaned; sensitivity within spec.");
    expect(res.error).toBeUndefined();
    const [row] = await events();
    expect(row.kind).toBe("pm");
    expectSplit(row, "Source cleaned", "555-0100");
    const [t] = await testDb.select().from(tasks);
    expect(t.findings).toBe("Source cleaned; sensitivity within spec.");
    expect(t.body).toContain(LEAKY);
  });

  it("does the same for a past PM logged after the fact", async () => {
    const { logPastPm } = await import("@/app/actions");
    const res = await logPastPm(1, {
      date: "2026-02-10", note: LEAKY, advanceSchedule: false, findings: "Seals replaced.",
    });
    expect(res.error).toBeUndefined();
    const [row] = await events();
    expectSplit(row, "Seals replaced", "555-0100");
  });

  it("omits findings rather than filing an empty string when nobody wrote any", async () => {
    const { completePmNow } = await import("@/app/actions");
    await completePmNow(1);
    const [row] = await events();
    expect("findings" in (row.provenance as object)).toBe(false);
  });
});

describe("the door", () => {
  it("names every denylisted key it finds, wherever it is nested", () => {
    expect(provenanceLeaks({ findings: "ok", parts: [{ partNumber: "X", cost: "9" }], meta: { site: "H" } }))
      .toEqual(["parts[0].cost", "meta.site"]);
    expect(provenanceLeaks({ findings: "ok", planned: true })).toEqual([]);
  });

  it("refuses an event whose travelling half leaks, whatever built it", () => {
    for (const key of PROVENANCE_DENYLIST) {
      expect(() => checkEvent({ kind: "pm", provenance: { [key]: "x" } }))
        .toThrow(new RegExp(`must not travel: ${key}`));
    }
  });

  it("refuses an event with no kind", () => {
    expect(() => checkEvent({ kind: "" as never, provenance: {} })).toThrow(/needs a kind/);
  });

  it("refuses a skipped step with no reason, and lets the reason travel", () => {
    expect(() => checkEvent({ kind: "pm", provenance: {}, procedureKeys: [{ key: "leak-check", state: "skip" }] }))
      .toThrow(/needs a reason, and the reason travels/);
    expect(() => checkEvent({ kind: "pm", provenance: {}, procedureKeys: [{ key: "leak-check", state: "skip", reason: "no helium on site" }] }))
      .not.toThrow();
  });

  it("holds at the database boundary too, not only in the form", async () => {
    await expect(appendEvent({
      instrumentId: INST, kind: "note", occurredAt: new Date(), authorOrgId: SIERRA, custodianOrgId: EMERY,
      whoGrade: "self_reported", howGrade: "typed", sourceKind: "manual",
      provenance: { findings: "fine", contact: "Ray" },
    })).rejects.toThrow(/must not travel: contact/);
    expect(await events()).toHaveLength(0);
  });
});

describe("a provider's name", () => {
  it("is withheld by default and theirs to release", async () => {
    const { setOrgShowNameDownstream } = await import("@/app/actions");
    const [before] = await testDb.select().from(orgs).where(eq(orgs.id, SIERRA));
    expect(before.showNameDownstream).toBe(false);
    expect((await setOrgShowNameDownstream(SIERRA, true)).error).toBeUndefined();
    const [after] = await testDb.select().from(orgs).where(eq(orgs.id, SIERRA));
    expect(after.showNameDownstream).toBe(true);
  });

  it("cannot be released by somebody who does not admin the org", async () => {
    const { setOrgShowNameDownstream } = await import("@/app/actions");
    await client.exec(`INSERT INTO orgs (id, name, kind, is_operator) VALUES (9, 'LabZen', 'provider', true);`);
    who = { ...JOE!, operatorOrgId: 9, rootOperatorOrgId: SIERRA, role: "staff" };
    await client.exec(`INSERT INTO house_members (email, org_id, role, name) VALUES ('joe@sierra.test', 9, 'staff', 'Joe') ON CONFLICT DO NOTHING;`);
    // LabZen staff, on Sierra's instance, reaching for Sierra's switch.
    const res = await setOrgShowNameDownstream(SIERRA, true);
    expect(res.error).toBeTruthy();
    const [row] = await testDb.select().from(orgs).where(eq(orgs.id, SIERRA));
    expect(row.showNameDownstream).toBe(false);
  });
});

describe("capabilities from what an org already is", () => {
  it("derives them once and never overrules a later choice", async () => {
    await client.exec(`
      INSERT INTO orgs (id, name, kind, is_operator, resale_enabled) VALUES (10, 'GMI Surplus', 'client', false, true);
      INSERT INTO orgs (id, name, kind, is_operator, can_service) VALUES (11, 'Opted out', 'provider', true, false);
      UPDATE orgs SET can_custody = true WHERE id = 11; -- somebody already decided
    `);
    const saved = process.argv; process.argv = ["node", "script", "--apply"];
    try { await capabilities(); } finally { process.argv = saved; }
    const by = new Map((await testDb.select().from(orgs)).map((o) => [o.id, o]));
    expect([by.get(SIERRA)!.canService, by.get(SIERRA)!.canCustody, by.get(SIERRA)!.canBroker]).toEqual([true, false, false]);
    expect([by.get(EMERY)!.canService, by.get(EMERY)!.canCustody, by.get(EMERY)!.canBroker]).toEqual([false, true, false]);
    expect([by.get(10)!.canService, by.get(10)!.canCustody, by.get(10)!.canBroker]).toEqual([false, true, true]);
    // Left alone: a flag somebody set is not a flag a script re-derives.
    expect([by.get(11)!.canService, by.get(11)!.canCustody]).toEqual([false, true]);
    // showNameDownstream is policy, not derivation.
    expect([...by.values()].every((o) => o.showNameDownstream === false)).toBe(true);
  });
});
