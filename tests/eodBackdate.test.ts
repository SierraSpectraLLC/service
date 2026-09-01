// Writing up a day after the fact.
//
// Reported: "we accidentally lost the way to write EOD updates for previous
// days." A shop that did the work on Friday and sat down to write it on Monday
// had nowhere to put it - saveEodUpdate stamped shopToday() and nothing else,
// so a NEW line could only ever be about the day it was typed. (Editing an
// existing row already reached any date through target.eodId; only creating
// one was stuck.)
//
// What is pinned here is the boundary of the new date, because that is where a
// backdated write goes wrong quietly: the wrong day, or a day that has not
// happened. Real Postgres, in-process, from the same DDL every deploy applies.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

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

/** The shop's clock, so "today" is a fact these tests control. */
const TODAY = "2026-09-01";
vi.mock("@/lib/shopday", async () => {
  const real = await vi.importActual<Record<string, unknown>>("@/lib/shopday");
  return { ...real, shopToday: () => "2026-09-01", shopTodayMDY: () => "9/1/2026" };
});

const SIERRA = 1, PUGET = 2;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator, parent_org_id) VALUES
      (${SIERRA}, 'Sierra Spectra',    'provider', true,  NULL),
      (${PUGET},  'Puget Diagnostics', 'client',   false, ${SIERRA});
    INSERT INTO app_settings (id, operator_org_id) VALUES (1, ${SIERRA});
    INSERT INTO house_members (email, org_id, role, name) VALUES
      ('steve@sierra.test', ${SIERRA}, 'staff', 'Steve Jones');
    INSERT INTO instruments (id, tenant_org_id, external_id, client, model, owner_org_id) VALUES
      (1, ${SIERRA}, 'SS-001', 'Puget', 'LCMS-8050', ${PUGET});
  `);
});

beforeEach(async () => {
  who = {
    email: "steve@sierra.test", name: "Steve Jones", role: "staff",
    orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: SIERRA,
  };
  await client.exec(`DELETE FROM eod_updates; DELETE FROM audit_log;`);
  vi.resetModules();
});

const rows = async () => testDb.select().from(schema.eodUpdates);
const target = { instrumentId: 1, assetId: null, eodId: null };

describe("saving a line for a day that is not today", () => {
  it("files it under the day it is about", async () => {
    // The whole ask: Friday's work, written on Tuesday.
    const { saveEodUpdate } = await import("@/app/actions");
    const res = await saveEodUpdate(target, { systemUpdate: "Rebuilt the source", actionItem: "" }, "2026-08-28");
    expect(res?.error).toBeUndefined();
    const [row] = await rows();
    expect(row!.date).toBe("2026-08-28");
    expect(row!.systemUpdate).toBe("Rebuilt the source");
  });

  it("still means today when nothing is passed", async () => {
    // Every existing caller omits it, and every one of them meant today.
    const { saveEodUpdate } = await import("@/app/actions");
    await saveEodUpdate(target, { systemUpdate: "Today's work", actionItem: "" });
    expect((await rows())[0]!.date).toBe(TODAY);
  });

  it("refuses a day that has not happened", async () => {
    /*
     * Refused rather than clamped to today. An EOD update dated tomorrow is a
     * claim about work nobody has done, and silently filing it under today
     * would hide the mistake instead of naming it - and would put words on a
     * client's report that the writer did not think they were writing there.
     */
    const { saveEodUpdate } = await import("@/app/actions");
    const res = await saveEodUpdate(target, { systemUpdate: "Tomorrow", actionItem: "" }, "2026-09-02");
    expect(res?.error).toMatch(/hasn't happened yet/);
    expect(await rows()).toEqual([]);
  });

  it("refuses something that is not a calendar day", async () => {
    const { saveEodUpdate } = await import("@/app/actions");
    for (const bad of ["last friday", "2026-13-01", "08-28-2026", "2026-8-28"]) {
      const res = await saveEodUpdate(target, { systemUpdate: "x", actionItem: "" }, bad);
      expect(`${bad}: ${res?.error ? "refused" : "ACCEPTED"}`).toBe(`${bad}: refused`);
    }
    expect(await rows()).toEqual([]);
  });

  it("keeps two days apart rather than overwriting one", async () => {
    // The unique key is (instrument, date), so a second day is a second row.
    // If the date were ignored the Friday write would land on today's line and
    // one of the two days would silently lose its update.
    const { saveEodUpdate } = await import("@/app/actions");
    await saveEodUpdate(target, { systemUpdate: "Friday", actionItem: "" }, "2026-08-28");
    await saveEodUpdate(target, { systemUpdate: "Today", actionItem: "" });
    const all = (await rows()).sort((a, b) => a.date.localeCompare(b.date));
    expect(all.map((r) => `${r.date}=${r.systemUpdate}`)).toEqual([
      "2026-08-28=Friday", "2026-09-01=Today",
    ]);
  });

  it("edits the past day again instead of opening a second row", async () => {
    const { saveEodUpdate } = await import("@/app/actions");
    await saveEodUpdate(target, { systemUpdate: "First pass", actionItem: "" }, "2026-08-28");
    await saveEodUpdate(target, { systemUpdate: "Corrected", actionItem: "Chase the seal" }, "2026-08-28");
    const all = await rows();
    expect(all).toHaveLength(1);
    expect([all[0]!.systemUpdate, all[0]!.actionItem]).toEqual(["Corrected", "Chase the seal"]);
  });

  it("stamps the owner, so a later handoff cannot move the day", async () => {
    // The stamp is what keeps history honest; a backdated write has to carry
    // it exactly as a same-day one does.
    const { saveEodUpdate } = await import("@/app/actions");
    await saveEodUpdate(target, { systemUpdate: "Friday", actionItem: "" }, "2026-08-28");
    expect((await rows())[0]!.ownerOrgId).toBe(PUGET);
  });
});

describe("off-system work follows the same day", () => {
  it("lands on the day being written, not the day it is typed", async () => {
    // "+ Log work" is offered on a past day now, so this rule cannot live in
    // only one of the two writers.
    const { logOffSystemWork } = await import("@/app/actions");
    const res = await logOffSystemWork(PUGET, {
      title: "Phone support - tune report", person: "Steve Jones",
      minutes: 30, systemUpdate: "Talked them through it", actionItem: "",
    }, "2026-08-28");
    expect(res.error).toBeUndefined();
    const [row] = await rows();
    expect(row!.date).toBe("2026-08-28");
    expect(row!.title).toBe("Phone support - tune report");
  });

  it("refuses the future here too", async () => {
    const { logOffSystemWork } = await import("@/app/actions");
    const res = await logOffSystemWork(PUGET, {
      title: "Not yet", person: "Steve Jones", minutes: 10, systemUpdate: "", actionItem: "",
    }, "2026-09-02");
    expect(res.error).toMatch(/hasn't happened yet/);
    expect(await rows()).toEqual([]);
  });

  it("says in the audit that it was written for another day", async () => {
    const { logOffSystemWork } = await import("@/app/actions");
    await logOffSystemWork(PUGET, {
      title: "Phone support", person: "Steve Jones", minutes: 30, systemUpdate: "x", actionItem: "",
    }, "2026-08-28");
    const log = await testDb.select().from(schema.auditLog)
      .where(eq(schema.auditLog.entityType, "eod"));
    expect(log.some((r) => /for 2026-08-28/.test(r.action))).toBe(true);
  });
});
