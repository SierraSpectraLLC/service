// A client's calendar, and what must never reach it.
//
// The shop's calendar is every dated fact in the workspace. A client's is the
// slice that is about them, so every assertion worth writing here is a
// negative one: the machine next door's maintenance, another company's
// invoice, the shop's own internal notes. A calendar is a page somebody scans
// rather than reads, which is exactly where a leaked row goes unnoticed.
//
// The other half is the ASK. A client picking a day asks for it; it must file
// planned work carrying that date and must not touch a schedule, because a
// contract's maintenance calendar is not something a client can move by
// asking - see requestPm's own comment, which this pins.
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

const ROOT = 1, SIERRA = 2, LABZEN = 3, TESTEN = 4;
const LZ_SYS = 1, TS_SYS = 2;

const LAB: Who = {
  email: "chem@labzen.test", name: "Rae Ostrowski", role: "client_editor",
  orgId: LABZEN, operatorOrgId: null, rootOperatorOrgId: ROOT,
};
const OTHER: Who = {
  email: "chem@testen.test", name: "Sam Fry", role: "client_editor",
  orgId: TESTEN, operatorOrgId: null, rootOperatorOrgId: ROOT,
};
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
      (${LABZEN}, 'Lab Zen',        'client',   false, ${SIERRA}),
      (${TESTEN}, 'Testen',         'client',   false, ${SIERRA});
    INSERT INTO app_settings (id, operator_org_id, client_access_enabled) VALUES (1, ${ROOT}, true);

    INSERT INTO house_members (email, org_id, role, name) VALUES
      ('tech@sierra.test', ${SIERRA}, 'staff', 'Steve Jones');
    INSERT INTO client_allowlist (entry, org_id, can_edit) VALUES
      ('chem@labzen.test', ${LABZEN}, true),
      ('chem@testen.test', ${TESTEN}, true);

    INSERT INTO instruments (id, tenant_org_id, owner_org_id, external_id, client, model) VALUES
      (${LZ_SYS}, ${SIERRA}, ${LABZEN}, 'LZ-1', 'Lab Zen', 'LC-MS'),
      (${TS_SYS}, ${SIERRA}, ${TESTEN}, 'TS-1', 'Testen',  'GC-MS');
    INSERT INTO system_shares (instrument_id, org_id, access) VALUES
      (${LZ_SYS}, ${LABZEN}, 'edit'),
      (${TS_SYS}, ${TESTEN}, 'edit');

    -- One schedule each: theirs is due, the other company's is booked.
    INSERT INTO pm_schedules (id, tenant_org_id, instrument_id, title, every_days, next_due, booked_on) VALUES
      (1, ${SIERRA}, ${LZ_SYS}, 'Annual PM',    365, '2026-09-10', ''),
      (2, ${SIERRA}, ${TS_SYS}, 'Source clean',  90, '2026-09-11', '2026-09-12');
  `);
});

beforeEach(async () => {
  who = LAB;
  await client.exec(`
    DELETE FROM calendar_notes; DELETE FROM tasks; DELETE FROM work_orders;
    DELETE FROM discussion_posts; DELETE FROM stage_events;
    -- Stages are columns on the instrument, not rows: without this a test that
    -- asked for a PM leaves "Maintenance due" behind for the next one to read
    -- as its own result.
    UPDATE instruments SET stages = '{}';
  `);
});

const SEPT = { from: "2026-08-30", to: "2026-10-03" };

/** The events one reader's calendar would draw for September. */
const monthFor = async (viewer: Who) => {
  who = viewer;
  const { clientCalendarInputs, forClient } = await import("@/lib/clientCalendarData");
  const { assembleEvents } = await import("@/lib/calendar");
  const { visibleSystemIds } = await import("@/lib/tenancy");
  const { currentUser } = await import("@/lib/authz");
  const u = (await currentUser())!;
  const inputs = await clientCalendarInputs({
    orgId: viewer.orgId!, orgName: "", seesMoney: true,
    systemIds: (await visibleSystemIds(u)) ?? [],
  });
  return forClient(assembleEvents(inputs, SEPT.from, SEPT.to, "2026-09-01"));
};

describe("what a client's calendar shows", () => {
  it("their own machine's maintenance, and not the company next door's", async () => {
    const mine = await monthFor(LAB);
    expect(mine.map((e) => e.label).join(" ")).toContain("Annual PM");
    // Testen's booked visit is on the same month and must be nowhere near it.
    expect(mine.map((e) => e.label).join(" ")).not.toContain("Source clean");

    const theirs = await monthFor(OTHER);
    expect(theirs.map((e) => e.label).join(" ")).toContain("Source clean");
    expect(theirs.map((e) => e.label).join(" ")).not.toContain("Annual PM");
  });

  it("points every entry at a room a client actually has", async () => {
    /*
     * lib/calendar writes hrefs for the shop - /money/invoices/12, /work -
     * because that is where those records live for the reader it was written
     * for. A calendar full of links that bounce is worse than one with none.
     */
    const events = await monthFor(LAB);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.href.startsWith("/money/")).toBe(false);
      expect(e.href.startsWith("/maintenance")).toBe(false);
    }
  });
});

describe("notes on a client's calendar", () => {
  const notes = async () => {
    const { calendarNotes } = schema;
    const { asc } = await import("drizzle-orm");
    return testDb.select().from(calendarNotes).orderBy(asc(calendarNotes.id));
  };

  it("lets a client write one, stamped to the shop's workspace", async () => {
    /*
     * The stamp is the whole point of writing it: taken from the note's own
     * organization rather than from the writer, because a client has no
     * workspace and myTenantOrgId would be null - a note the shop could never
     * read, left for the shop.
     */
    const { addCalendarNote } = await import("@/app/actions");
    who = LAB;
    expect((await addCalendarNote({ onDate: "2026-09-14", endsOn: "2026-09-18", title: "Site closed - audit" })).error)
      .toBeUndefined();
    const [row] = await notes();
    expect(row.orgId).toBe(LABZEN);
    expect(row.tenantOrgId).toBe(SIERRA);
    expect(row.createdByName).toBe("Rae Ostrowski");
  });

  it("puts it on the shop's calendar too - which is what it is for", async () => {
    // A shutdown week nobody at the shop knows about is how a van gets sent to
    // a locked door.
    const { addCalendarNote } = await import("@/app/actions");
    who = LAB;
    await addCalendarNote({ onDate: "2026-09-14", title: "Site closed - audit" });
    const [row] = await notes();
    expect(row.tenantOrgId).toBe(SIERRA);
    // ...and the client reads it back on their own.
    const mine = await monthFor(LAB);
    expect(mine.some((e) => e.kind === "note" && e.label.includes("Site closed"))).toBe(true);
  });

  it("never shows one company's note to another", async () => {
    const { addCalendarNote } = await import("@/app/actions");
    who = LAB;
    await addCalendarNote({ onDate: "2026-09-14", title: "Lab Zen shutdown" });
    expect((await monthFor(OTHER)).some((e) => e.label.includes("Lab Zen shutdown"))).toBe(false);
  });

  it("keeps the shop's own notes off every client's calendar", async () => {
    // orgId null is the shop writing about itself - the Christmas close, a
    // training week. None of a client's business.
    const { addCalendarNote } = await import("@/app/actions");
    who = TECH;
    await addCalendarNote({ onDate: "2026-09-14", title: "Shop closed - training" });
    expect((await notes())[0].orgId).toBeNull();
    expect((await monthFor(LAB)).some((e) => e.label.includes("training"))).toBe(false);
  });

  it("refuses a client writing on somebody else's calendar", async () => {
    // The org comes off the wire; a client has exactly one and does not choose.
    const { addCalendarNote } = await import("@/app/actions");
    who = LAB;
    await addCalendarNote({ onDate: "2026-09-14", title: "Nice try", orgId: TESTEN });
    expect((await notes())[0].orgId).toBe(LABZEN);
  });

  it("refuses staff writing onto another workspace's client", async () => {
    const { addCalendarNote } = await import("@/app/actions");
    who = { ...TECH, operatorOrgId: ROOT };
    // ROOT's staff naming Sierra's client: not one of theirs.
    expect((await addCalendarNote({ onDate: "2026-09-14", title: "No", orgId: LABZEN })).error)
      .toBeTruthy();
  });

  it("lets a client clear their own, and nobody else's", async () => {
    const { addCalendarNote, removeCalendarNote } = await import("@/app/actions");
    who = LAB;
    const { id } = await addCalendarNote({ onDate: "2026-09-14", title: "Mine" });
    who = OTHER;
    expect((await removeCalendarNote(id!)).error).toBeTruthy();
    expect(await notes()).toHaveLength(1);
    who = LAB;
    expect((await removeCalendarNote(id!)).error).toBeUndefined();
    expect(await notes()).toEqual([]);
  });

  it("refuses a note on a day that does not exist", async () => {
    // Date.parse rolls 2026-02-31 to March 3rd, so it would save and then be
    // drawn on a date no month grid has a cell for.
    const { addCalendarNote } = await import("@/app/actions");
    who = LAB;
    expect((await addCalendarNote({ onDate: "2026-02-31", title: "Ghost" })).error).toBeTruthy();
    expect(await notes()).toEqual([]);
  });
});

describe("asking for a visit on a day", () => {
  const scheds = async () => {
    const { pmSchedules } = schema;
    const { asc } = await import("drizzle-orm");
    return testDb.select().from(pmSchedules).orderBy(asc(pmSchedules.id));
  };
  const openTasks = async () => {
    const { tasks } = schema;
    return testDb.select().from(tasks);
  };

  it("dates the work to the day they picked", async () => {
    const { requestPm } = await import("@/app/actions");
    who = LAB;
    const res = await requestPm(LZ_SYS, { window: "month", note: "Bay free that week", preferredOn: "2026-09-23" });
    expect(res.error).toBeUndefined();
    const [task] = await openTasks();
    expect(task.dueDate).toBe("2026-09-23");
    expect(task.origin).toBe("pm_request");
  });

  it("does not move the maintenance calendar - which is the whole rule", async () => {
    /*
     * requestPm's own comment: a client should not be able to move a
     * contract's maintenance calendar by asking. Letting them pick a DATE
     * makes that rule easier to break by accident, so it is pinned here.
     */
    const before = await scheds();
    const { requestPm } = await import("@/app/actions");
    who = LAB;
    await requestPm(LZ_SYS, { window: "now", note: "Please", preferredOn: "2026-09-02" });
    expect(await scheds()).toEqual(before);
  });

  it("ignores a day already behind us rather than filing work born late", async () => {
    const { requestPm } = await import("@/app/actions");
    who = LAB;
    await requestPm(LZ_SYS, { window: "month", note: "Whenever", preferredOn: "2020-01-01" });
    // Falls back to the horizon: a month from 2026-09-01.
    expect((await openTasks())[0].dueDate).toBe("2026-10-01");
  });

  it("tells maintenance from service work on the record", async () => {
    const { requestPm } = await import("@/app/actions");
    who = LAB;
    await requestPm(LZ_SYS, { window: "month", note: "Move the bracket", kind: "service" });
    expect((await openTasks())[0].title).toContain("Service requested");
  });

  it("marks the system as owing upkeep for a PM, and not for service work", async () => {
    /*
     * Asking for a bracket to be moved must not put "Maintenance due" on the
     * board - a false reading only an engineer could clear.
     */
    const { instruments } = schema;
    const { eq } = await import("drizzle-orm");
    const stages = async () =>
      (await testDb.select().from(instruments).where(eq(instruments.id, LZ_SYS)))[0].stages;
    const { requestPm } = await import("@/app/actions");
    who = LAB;
    await requestPm(LZ_SYS, { window: "month", note: "Move the bracket", kind: "service" });
    expect(await stages()).not.toContain("Maintenance due");

    // One open request per system, so the first has to be cleared before the
    // second can be filed rather than landing on it as a follow-up.
    await client.exec(`DELETE FROM tasks; DELETE FROM work_orders;`);
    await requestPm(LZ_SYS, { window: "month", note: "Annual is due", kind: "pm" });
    expect(await stages()).toContain("Maintenance due");
  });

  it("refuses a system that is not theirs", async () => {
    // Asking is not editing, but it is still scoped: canSeeSystemSafe.
    const { requestPm } = await import("@/app/actions");
    who = LAB;
    expect((await requestPm(TS_SYS, { window: "month", note: "Nice try" })).error).toBeTruthy();
    expect(await openTasks()).toEqual([]);
  });
});
