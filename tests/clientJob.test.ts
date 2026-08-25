// A job that belongs to a CLIENT rather than to a box on the bench.
//
// The move, the site survey, the phone call that arrives before anybody knows
// which instrument it is about. Before this, a work order had to name a system
// or an asset, so those jobs were opened against whatever system was nearest -
// which puts one client's hours on another client's history - or not opened at
// all, which is worse.
//
// The rules that make a record-less job safe are all negative ones, so they
// are the ones tested here: another workspace cannot see it, another client
// cannot load it, and a system belonging to somebody else cannot be attached
// to it. The last test is the one that pays for the feature: when the system
// IS identified, the job and every hour already filed on it move onto that
// system's history rather than staying in a place nobody thinks to look.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));

// Who is signed in for the call under test. The real authz stack runs on top
// of this - roles, tenancy and all - so what the tests exercise is the app's
// own gate, not a stand-in for it.
type Who = {
  email: string; name: string; role: string;
  orgId: number | null; orgName?: string; orgKind?: string;
  operatorOrgId: number | null; rootOperatorOrgId: number | null;
};
let who: Who;
vi.mock("@/auth", () => ({ auth: async () => ({ user: who }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
// The notifier reaches for mail and the network; the jobs under test are not
// about who got an email.
vi.mock("@/lib/notify", () => ({
  notifyTaskAssigned: async () => {},
  notifyMentions: async () => {},
  notifyWorkOrder: async () => {},
}));

const HOUSE: Who = {
  email: "joe@sierra.test", name: "Joe", role: "owner",
  orgId: null, operatorOrgId: 3, rootOperatorOrgId: 3,
};
// Staff of a DIFFERENT service company on the same instance.
const RIVAL: Who = {
  email: "sam@rival.test", name: "Sam", role: "owner",
  orgId: null, operatorOrgId: 4, rootOperatorOrgId: 3,
};
const CLIENT: Who = {
  email: "maria@labzen.test", name: "Maria", role: "client_editor",
  orgId: 1, orgName: "Lab Zen", orgKind: "client",
  operatorOrgId: null, rootOperatorOrgId: 3,
};

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO app_settings (id) VALUES (1);
    INSERT INTO orgs (name, kind) VALUES
      ('Lab Zen', 'client'), ('Coastal Analytical', 'client'),
      ('Sierra Spectra', 'provider'), ('Rival Instruments', 'provider');
    UPDATE orgs SET is_operator = true WHERE id IN (3, 4);
    UPDATE orgs SET parent_org_id = 3 WHERE id IN (1, 2);
    UPDATE app_settings SET operator_org_id = 3 WHERE id = 1;
    INSERT INTO instruments (external_id, client, model, owner_org_id, tenant_org_id, stages) VALUES
      ('LZ-001', 'Lab Zen', 'Agilent 6495C', 1, 3, '{"Checkout"}'),
      ('CA-001', 'Coastal', 'Optima 8300',   2, 3, '{"Intake"}'),
      ('SS-001', 'Sierra',  'Bench spare',   NULL, 3, '{"Refurbishment"}');
  `);
});

beforeEach(() => { who = HOUSE; });

const actions = await import("@/app/actions");

describe("opening a job on a client, with no system", () => {
  it("files it against the client and nothing else", async () => {
    const res = await actions.openWorkOrder(
      { instrumentId: null, assetId: null, orgId: 1 },
      { title: "Move the 6495C to the new lab", body: "Third floor, week of the 8th", severity: "Planned" },
    );
    expect(res.error).toBeUndefined();
    const rows = await testDb.select().from(schema.workOrders);
    const made = rows.find((r) => r.id === res.id)!;
    expect(made.instrumentId).toBeNull();
    expect(made.assetId).toBeNull();
    expect(made.orgId).toBe(1);
    expect(made.tenantOrgId).toBe(3);
    expect(made.number).toMatch(/^WO-/);
  });

  it("lets the shop open one on nobody - its own work", async () => {
    const res = await actions.openWorkOrder(
      { instrumentId: null, assetId: null, orgId: null },
      { title: "Rebuild the loaner turbo", body: "", severity: "Planned" },
    );
    expect(res.error).toBeUndefined();
    const rows = await testDb.select().from(schema.workOrders);
    expect(rows.find((r) => r.id === res.id)!.orgId).toBeNull();
  });

  it("refuses a client this workspace does not run", async () => {
    who = RIVAL;
    const res = await actions.openWorkOrder(
      { instrumentId: null, assetId: null, orgId: 1 },
      { title: "Poke at somebody else's client", body: "", severity: "Planned" },
    );
    expect(res.error).toBe("Not found");
  });

  it("makes a client name themselves, and nobody else", async () => {
    who = CLIENT;
    const mine = await actions.openWorkOrder(
      { instrumentId: null, assetId: null, orgId: 1 },
      { title: "We are moving the lab", body: "", severity: "Planned" },
    );
    expect(mine.error).toBeUndefined();
    const theirs = await actions.openWorkOrder(
      { instrumentId: null, assetId: null, orgId: 2 },
      { title: "A job on the neighbours", body: "", severity: "Planned" },
    );
    expect(theirs.error).toBe("Not found");
    const nobody = await actions.openWorkOrder(
      { instrumentId: null, assetId: null, orgId: null },
      { title: "A job on nobody", body: "", severity: "Planned" },
    );
    expect(nobody.error).toBe("Pick the client this job is for");
  });
});

describe("a client and a system together", () => {
  it("takes the system's owner as the client, whatever was picked", async () => {
    const res = await actions.openWorkOrder(
      { instrumentId: 1, assetId: null, orgId: 1 },
      { title: "Lamp won't ignite", body: "", severity: "Down" },
    );
    expect(res.error).toBeUndefined();
    const rows = await testDb.select().from(schema.workOrders);
    const made = rows.find((r) => r.id === res.id)!;
    expect(made.instrumentId).toBe(1);
    expect(made.orgId).toBe(1);
  });

  it("refuses a system that belongs to a different client", async () => {
    const res = await actions.openWorkOrder(
      { instrumentId: 2, assetId: null, orgId: 1 },
      { title: "Filed on the wrong client", body: "", severity: "Down" },
    );
    expect(res.error).toContain("belongs to Coastal Analytical");
  });

  it("lets a named client stand on the shop's own bench", async () => {
    // A refurb on our floor, done FOR somebody - the system has no owner to
    // disagree, so the client on the job is the one who asked for it.
    const res = await actions.openWorkOrder(
      { instrumentId: 3, assetId: null, orgId: 2 },
      { title: "Refurb for Coastal", body: "", severity: "Planned" },
    );
    expect(res.error).toBeUndefined();
    const rows = await testDb.select().from(schema.workOrders);
    const made = rows.find((r) => r.id === res.id)!;
    expect(made.instrumentId).toBe(3);
    expect(made.orgId).toBe(2);
  });
});

describe("the system it turned out to be about", () => {
  it("moves the job and the work already filed on it", async () => {
    const job = await actions.openWorkOrder(
      { instrumentId: null, assetId: null, orgId: 1 },
      { title: "Something in the back room", body: "", severity: "Degraded" },
    );
    const woId = job.id!;
    // An hour and a task, filed on the job before anybody knew the system.
    const task = await actions.createTask(
      { instrumentId: null, assetId: null, workOrderId: woId },
      { title: "Look at it", body: "", assignee: "" },
    );
    expect(task).not.toHaveProperty("error");
    const hour = await actions.logTime(
      { instrumentId: null, assetId: null, workOrderId: woId },
      { hours: "1.5", person: "Joe", date: "2026-08-24", note: "On site", billable: true },
    );
    expect(hour.error).toBeUndefined();

    const moved = await actions.attachWorkOrderSystem(woId, 1);
    expect(moved.error).toBeUndefined();
    expect(moved.externalId).toBe("LZ-001");

    const [after] = (await testDb.select().from(schema.workOrders)).filter((r) => r.id === woId);
    expect(after.instrumentId).toBe(1);
    const tasks = (await testDb.select().from(schema.tasks)).filter((t) => t.workOrderId === woId);
    const hours = (await testDb.select().from(schema.timeEntries)).filter((t) => t.workOrderId === woId);
    expect(tasks.every((t) => t.instrumentId === 1)).toBe(true);
    expect(hours.every((h) => h.instrumentId === 1)).toBe(true);
  });

  it("refuses a system belonging to another client", async () => {
    const job = await actions.openWorkOrder(
      { instrumentId: null, assetId: null, orgId: 1 },
      { title: "Lab Zen's move", body: "", severity: "Planned" },
    );
    const res = await actions.attachWorkOrderSystem(job.id!, 2);
    expect(res.error).toContain("belongs to Coastal Analytical");
  });

  it("refuses to move a job that already has a record", async () => {
    const job = await actions.openWorkOrder(
      { instrumentId: 1, assetId: null, orgId: null },
      { title: "Already on LZ-001", body: "", severity: "Planned" },
    );
    const res = await actions.attachWorkOrderSystem(job.id!, 3);
    expect(res.error).toContain("already on a record");
  });
});

describe("who can reach a record-less job", () => {
  let woId = 0;
  beforeEach(async () => {
    if (woId) return;
    const job = await actions.openWorkOrder(
      { instrumentId: null, assetId: null, orgId: 1 },
      { title: "Lab Zen site survey", body: "", severity: "Planned" },
    );
    woId = job.id!;
  });

  it("keeps another operator's staff out", async () => {
    who = RIVAL;
    const res = await actions.updateWorkOrder(woId, {
      title: "Mine now", body: "", severity: "Planned", assignee: "",
    });
    expect(res.error).toBe("Not found");
  });

  it("keeps another client out", async () => {
    who = { ...CLIENT, email: "a@coastal.test", orgId: 2, orgName: "Coastal Analytical" };
    const res = await actions.setWorkOrderState(woId, "cancelled");
    expect(res.error).toBe("Not found");
  });

  it("lets the client it belongs to withdraw their own ask", async () => {
    who = CLIENT;
    const res = await actions.setWorkOrderState(woId, "cancelled");
    expect(res.error).toBeUndefined();
  });
});

// The digest is where a week's work gets read, and a job with no system had no
// line in it: the per-system narrative is keyed by instrument, so a move that
// closed on Tuesday simply did not happen as far as the client's morning email
// was concerned.
describe("a client job in the daily digest", () => {
  it("reads under the client it was for, once it is finished", async () => {
    const job = await actions.openWorkOrder(
      { instrumentId: null, assetId: null, orgId: 1 },
      { title: "Bench move, third floor", body: "", severity: "Planned" },
    );
    const done = await actions.resolveWorkOrder(job.id!, "Both GCs moved and levelled; power verified.");
    expect(done.error).toBeUndefined();

    const { collectDigest } = await import("@/lib/digest");
    const { sections } = await collectDigest(3, 1);
    const labZen = sections.find((x) => x.orgId === 1)!;
    expect(labZen).toBeTruthy();
    const line = labZen.offSystem.map((l) => l.text).join(" | ");
    expect(line).toContain("resolved: Both GCs moved and levelled");
    expect(labZen.offSystem.every((l) => !l.internal)).toBe(true);
  });

  it("gives a client with nothing on the bench a section of their own", async () => {
    // Coastal has a system here, so the case is made with a fresh org that has
    // none - the client whose only work this window was a job with no system.
    await testDb.insert(schema.orgs).values({ name: "Harbor Biotech", kind: "client", parentOrgId: 3 });
    const [harbor] = (await testDb.select().from(schema.orgs)).filter((o) => o.name === "Harbor Biotech");
    const job = await actions.openWorkOrder(
      { instrumentId: null, assetId: null, orgId: harbor.id },
      { title: "Site survey for the new lab", body: "", severity: "Planned" },
    );
    await actions.resolveWorkOrder(job.id!, "Walked the space, measured the benches.");

    const { collectDigest } = await import("@/lib/digest");
    const { sections } = await collectDigest(3, 1);
    const theirs = sections.find((x) => x.orgId === harbor.id);
    expect(theirs).toBeTruthy();
    expect(theirs!.board).toEqual([]);
    expect(theirs!.offSystem.map((l) => l.text).join(" ")).toContain("Walked the space");
  });
});
