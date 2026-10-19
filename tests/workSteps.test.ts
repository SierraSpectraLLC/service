// A job made of steps: the move's pre-move validation, the move, and the
// post-move OQ, each its own work order with its own signed report.
//
// What is tested is what makes that safe to rely on: a step inherits whose job
// it is and what it is on, numbers itself off its parent without moving the
// workspace's counter, files its reports in the parent's job thread, follows
// the parent onto a system, and holds the parent open until it is done.
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

const rowOf = async (id: number) =>
  (await testDb.select().from(schema.workOrders)).find((r) => r.id === id)!;

describe("steps of a move", () => {
  it("opens the three move steps under the job, numbered off it, and leaves the counter alone", async () => {
    const parent = await actions.openWorkOrder(
      { instrumentId: null, assetId: null, orgId: 1 },
      { title: "System Move from Parnassus Lab", body: "Moving to Mission Bay", severity: "Planned" },
    );
    expect(parent.error).toBeUndefined();
    const res = await actions.openWorkSteps(parent.id!, [
      { title: "Pre-move validation", kind: "validation" },
      { title: "Move", kind: "move", assignee: "Joe" },
      { title: "Post-move OQ / validation", kind: "oq" },
    ]);
    expect(res.error).toBeUndefined();
    const steps = await Promise.all(res.ids!.map(rowOf));
    expect(steps.map((s) => s.number)).toEqual([`${parent.number}-1`, `${parent.number}-2`, `${parent.number}-3`]);
    for (const s of steps) {
      expect(s.parentId).toBe(parent.id);
      expect(s.orgId).toBe(1);
      expect(s.tenantOrgId).toBe(3);
      expect(s.instrumentId).toBeNull();
    }
    expect(steps.map((s) => s.stepKind)).toEqual(["validation", "move", "oq"]);
    expect(steps[1].assignee).toBe("Joe");

    // The next ordinary job takes the next number, not one after the steps.
    const next = await actions.openWorkOrder(
      { instrumentId: null, assetId: null, orgId: 1 },
      { title: "Something else", body: "", severity: "Planned" },
    );
    const n = (s: string) => parseInt(s.replace(/\D+/g, ""), 10);
    expect(n(next.number!)).toBe(n(parent.number!) + 1);

    // A step of a step is refused.
    const deeper = await actions.openWorkSteps(res.ids![0], [{ title: "Sub-sub", kind: "other" }]);
    expect(deeper.error).toMatch(/already a step/);
  });

  it("holds the parent open, and refuses to delete it, while steps are live", async () => {
    const parent = await actions.openWorkOrder(
      { instrumentId: null, assetId: null, orgId: 1 },
      { title: "Another move", body: "", severity: "Planned" },
    );
    const { ids } = await actions.openWorkSteps(parent.id!, [{ title: "Move", kind: "move" }]);
    const resolved = await actions.resolveWorkOrder(parent.id!, "Moved and qualified");
    expect(resolved.error).toMatch(/still open/);
    const gone = await actions.deleteWorkOrder(parent.id!, "opened by mistake");
    expect(gone.error).toMatch(/has 1 step/);

    expect((await actions.resolveWorkOrder(ids![0], "Moved it")).error).toBeUndefined();
    expect((await actions.resolveWorkOrder(parent.id!, "Moved and qualified")).error).toBeUndefined();
  });

  it("follows the parent onto the system once it is known", async () => {
    const parent = await actions.openWorkOrder(
      { instrumentId: null, assetId: null, orgId: 1 },
      { title: "Move the 6495C", body: "", severity: "Planned" },
    );
    const { ids } = await actions.openWorkSteps(parent.id!, MOVE);
    const res = await actions.attachWorkOrderSystem(parent.id!, 1);
    expect(res.error).toBeUndefined();
    for (const id of ids!) expect((await rowOf(id)).instrumentId).toBe(1);
  });

  it("prints the step's own service type and the parent's ask on its report", async () => {
    const parent = await actions.openWorkOrder(
      { instrumentId: 1, assetId: null },
      { title: "Relocate the 6495C", body: "Moving to the third floor", severity: "Planned" },
    );
    const { ids } = await actions.openWorkSteps(parent.id!, [{ title: "Post-move OQ", kind: "oq" }]);
    const { serviceReportDraft } = await import("@/lib/serviceReportData");
    const draft = await serviceReportDraft(ids![0], { visitNotes: "OQ passed" });
    expect(draft!.report.serviceType).toBe("OQ");
    expect(draft!.report.request.text).toContain("Moving to the third floor");
    expect(draft!.report.request.text).toContain(parent.number!);
  });

  it("is the service team's to plan", async () => {
    const parent = await actions.openWorkOrder(
      { instrumentId: null, assetId: null, orgId: 1 },
      { title: "Client's move", body: "", severity: "Planned" },
    );
    who = CLIENT;
    const res = await actions.openWorkSteps(parent.id!, [{ title: "Move", kind: "move" }]);
    expect(res.error).toBeTruthy();
  });
});

describe("a job-numbered shop", () => {
  it("files every step's report in the parent's job thread", async () => {
    await client.exec(`UPDATE orgs SET doc_scheme = '{"templates":{"work_order":"{job:6}","service_report":"{job:6}_SR{seq}"},"jobStart":30190}' WHERE id = 3`);
    const parent = await actions.openWorkOrder(
      { instrumentId: 1, assetId: null },
      { title: "System Move from Parnassus Lab", body: "", severity: "Planned" },
    );
    expect(parent.number).toMatch(/^\d{6}$/);
    const { ids } = await actions.openWorkSteps(parent.id!, MOVE);
    expect((await rowOf(ids![0])).number).toBe(`${parent.number}-1`);
    const a = await actions.issueServiceReport(ids![0], "Pre-move checks all pass");
    const b = await actions.issueServiceReport(ids![2], "OQ all pass");
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    const reps = await testDb.select().from(schema.serviceReports);
    const nums = reps.filter((r) => r.id === a.id || r.id === b.id).map((r) => r.number).sort();
    expect(nums).toEqual([`${parent.number}_SR1`, `${parent.number}_SR2`]);
  });
});

const MOVE = [
  { title: "Pre-move validation", kind: "validation" },
  { title: "Move", kind: "move" },
  { title: "Post-move OQ / validation", kind: "oq" },
];
