// Booking a work order onto days, through the real action.
//
// "Client wants to schedule an open work order for 10/19 - how do I block out
// five days?" The answer used to be a calendar note that knew nothing about
// the job. This pins the booking: the shop's to make, on a live job, within
// the bound, audited, and cleared with a blank first day.
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

const SIERRA = 3, UCSF = 7;
const STAFF: Who = {
  email: "bill@sierra.test", name: "Bill Reyes", role: "staff",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: SIERRA,
};
const CLIENT: Who = {
  email: "rita@ucsf.test", name: "Rita", role: "client_editor",
  orgId: UCSF, operatorOrgId: null, rootOperatorOrgId: SIERRA,
};
const SYSTEM = 21, WO = 5;
const SLOW = 30_000;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator, parent_org_id) VALUES
      (${SIERRA}, 'Sierra Spectra', 'provider', true, NULL),
      (${UCSF}, 'UCSF', 'client', false, ${SIERRA});
    SELECT setval('orgs_id_seq', 100);
    INSERT INTO house_members (email, org_id, role, name) VALUES ('bill@sierra.test', ${SIERRA}, 'staff', 'Bill Reyes');
    INSERT INTO client_allowlist (entry, org_id) VALUES ('rita@ucsf.test', ${UCSF});
    INSERT INTO instruments (id, tenant_org_id, external_id, client, model, owner_org_id) VALUES
      (${SYSTEM}, ${SIERRA}, 'Q-ULT', 'UCSF', '', ${UCSF});
    INSERT INTO system_shares (instrument_id, org_id, access) VALUES (${SYSTEM}, ${UCSF}, 'edit');
    SELECT setval('instruments_id_seq', 100);
  `);
});

beforeEach(async () => {
  who = STAFF;
  await client.exec(`
    DELETE FROM audit_log; DELETE FROM work_orders;
    INSERT INTO work_orders (id, tenant_org_id, number, title, instrument_id, org_id, state, opened_on)
      VALUES (${WO}, ${SIERRA}, 'WO-1042', 'Quattro rebuild', ${SYSTEM}, ${UCSF}, 'open', '2026-09-14');
  `);
});

const job = async () => (await testDb.select().from(schema.workOrders))[0];

describe("booking a job", () => {
  it("puts it on the days, audited in the words the calendar will use", async () => {
    const { bookWorkOrder } = await import("@/app/actions");
    const res = await bookWorkOrder(WO, { bookedOn: "2026-10-19", bookedUntil: "2026-10-23" });
    expect(res).toEqual({});
    const w = await job();
    expect([w.bookedOn, w.bookedUntil]).toEqual(["2026-10-19", "2026-10-23"]);
    const [line] = await testDb.select().from(schema.auditLog);
    expect(line.action).toBe("booked WO-1042 for Oct 19 - Oct 23");
  }, SLOW);

  it("keeps a one-day booking as one day, and clears with a blank first day", async () => {
    const { bookWorkOrder } = await import("@/app/actions");
    await bookWorkOrder(WO, { bookedOn: "2026-10-19", bookedUntil: "2026-10-19" });
    expect([(await job()).bookedOn, (await job()).bookedUntil]).toEqual(["2026-10-19", ""]);
    expect(await bookWorkOrder(WO, { bookedOn: "" })).toEqual({});
    expect((await job()).bookedOn).toBe("");
    const lines = await testDb.select().from(schema.auditLog);
    expect(lines.at(-1)?.action).toBe("took WO-1042 off the calendar (was Oct 19)");
  }, SLOW);

  it("carries the rules' own objections, and writes nothing on one", async () => {
    const { bookWorkOrder } = await import("@/app/actions");
    expect((await bookWorkOrder(WO, { bookedOn: "2026-10-23", bookedUntil: "2026-10-19" })).error)
      .toBe("It cannot end before it starts");
    expect((await job()).bookedOn).toBe("");
  }, SLOW);

  it("is the shop's to make - a client asks, it does not book", async () => {
    const { bookWorkOrder } = await import("@/app/actions");
    who = CLIENT;
    expect((await bookWorkOrder(WO, { bookedOn: "2026-10-19" })).error).toBe("That is the service team's to book.");
    expect((await job()).bookedOn).toBe("");
  }, SLOW);

  it("has nothing to book on a job that is finished", async () => {
    const { bookWorkOrder } = await import("@/app/actions");
    await client.exec(`UPDATE work_orders SET state = 'closed' WHERE id = ${WO}`);
    expect((await bookWorkOrder(WO, { bookedOn: "2026-10-19" })).error).toBe("WO-1042 is Closed - reopen it to book it.");
  }, SLOW);
});
