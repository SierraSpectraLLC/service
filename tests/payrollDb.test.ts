// Payroll through the real actions, against a real database.
//
// tests/payroll.ts proves the rule; this proves the rule is what the actions
// actually consult. The failure it exists to catch is the one that would matter
// most and would look completely normal in review: an operator's staff reading
// a client's payroll because the query scoped by workspace, the way every
// other query in this app correctly does.
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
vi.mock("@/lib/notify", () => ({ notifyInvite: async () => {}, notifyTaskAssigned: async () => {} }));

const SHOP_OWNER: Who = {
  email: "joe@sierra.test", name: "Joe", role: "owner",
  orgId: null, operatorOrgId: 3, rootOperatorOrgId: 3,
};
const SHOP_STAFF: Who = {
  email: "bill@sierra.test", name: "Bill", role: "staff",
  orgId: null, operatorOrgId: 3, rootOperatorOrgId: 3,
};
const RIVAL_OWNER: Who = {
  email: "sam@rival.test", name: "Sam", role: "owner",
  orgId: null, operatorOrgId: 4, rootOperatorOrgId: 3,
};
const LZ_MANAGER: Who = {
  email: "rita@labzen.test", name: "Rita", role: "client_editor",
  orgId: 1, orgName: "Lab Zen", orgKind: "client", operatorOrgId: null, rootOperatorOrgId: 3,
};
const LZ_TECH: Who = {
  email: "tech@labzen.test", name: "Tech", role: "client_editor",
  orgId: 1, orgName: "Lab Zen", orgKind: "client", operatorOrgId: null, rootOperatorOrgId: 3,
};

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO app_settings (id, client_access_enabled) VALUES (1, true);
    INSERT INTO orgs (name, kind) VALUES
      ('Lab Zen', 'client'), ('Coastal Analytical', 'client'),
      ('Sierra Spectra', 'provider'), ('Rival Instruments', 'provider');
    UPDATE orgs SET is_operator = true WHERE id IN (3, 4);
    UPDATE orgs SET parent_org_id = 3 WHERE id IN (1, 2);
    UPDATE app_settings SET operator_org_id = 3 WHERE id = 1;
    -- Rita keeps Lab Zen's payroll; the tech at the next bench does not.
    INSERT INTO client_allowlist (entry, org_id, can_edit, can_see_payroll) VALUES
      ('rita@labzen.test', 1, true, true),
      ('tech@labzen.test', 1, true, false);
  `);
});

beforeEach(() => { who = SHOP_OWNER; });

const actions = await import("@/app/actions");
const pay = (over: Record<string, unknown> = {}) => ({
  name: "Bill Harner", personEmail: "bill@sierra.test", title: "Field engineer",
  kind: "salary", amount: "96,000", hoursPerWeek: 40, ftePct: 100, burdenPct: 25,
  effectiveOn: "2026-01-01", note: "", ...over,
});

describe("the shop's own payroll", () => {
  it("is kept by the owner", async () => {
    const res = await actions.addPayrollEntry(3, pay());
    expect(res.error).toBeUndefined();
    const rows = await testDb.select().from(schema.payroll);
    expect(rows).toHaveLength(1);
    expect(rows[0].orgId).toBe(3);
    expect(rows[0].amountCents).toBe(9_600_000);
    expect(rows[0].burdenPct).toBe(25);
  });

  it("is not the register for their own staff - their own line at most", async () => {
    who = SHOP_STAFF;
    const res = await actions.readPayroll(3);
    expect(res.whole).toBe(false);
    // Bill has a row of his own, so he sees that and nothing else. What he
    // must never see is the register - what the bench next to him earns.
    expect(res.rows!.every((r) => r.personEmail === "bill@sierra.test")).toBe(true);
    expect(res.mayEdit).toBe(false);
    // And he cannot write to it, his own line included.
    expect((await actions.addPayrollEntry(3, pay({ name: "A raise for me" }))).error).toBe("Not found");
  });

  it("does show a person their own row, and only theirs", async () => {
    await actions.addPayrollEntry(3, pay({ name: "Sam Ortiz", personEmail: "sam@sierra.test", amount: "80,000" }));
    who = SHOP_STAFF;   // bill@sierra.test, who has a row
    const res = await actions.readPayroll(3);
    expect(res.rows).toHaveLength(1);
    expect(res.rows![0].name).toBe("Bill Harner");
    expect(res.mayEdit).toBe(false);
  });

  it("does not leak to another operator on the same instance", async () => {
    who = RIVAL_OWNER;
    expect((await actions.readPayroll(3)).error).toBe("Not found");
    expect((await actions.addPayrollEntry(3, pay())).error).toBe("Not found");
  });
});

describe("a client's payroll, on the shop's own instance", () => {
  it("is kept by their own manager", async () => {
    who = LZ_MANAGER;
    const res = await actions.addPayrollEntry(1, pay({
      name: "Maria Chen", personEmail: "maria@labzen.test", amount: "72,000",
    }));
    expect(res.error).toBeUndefined();
    const read = await actions.readPayroll(1);
    expect(read.whole).toBe(true);
    expect(read.rows!.some((r) => r.name === "Maria Chen")).toBe(true);
  });

  it("is INVISIBLE to the operator hosting them - the whole bargain", async () => {
    who = SHOP_OWNER;
    const res = await actions.readPayroll(1);
    // Not "empty": not found. The shop is told nothing, including whether
    // there is anything to be told about.
    expect(res.error).toBe("Not found");
    expect(res.rows).toBeUndefined();
  });

  it("cannot be written by the operator either", async () => {
    who = SHOP_OWNER;
    expect((await actions.addPayrollEntry(1, pay({ name: "Sneaky" }))).error).toBe("Not found");
    const [row] = (await testDb.select().from(schema.payroll)).filter((r) => r.name === "Maria Chen");
    expect((await actions.endPayrollEntry(row.id, "2026-08-31")).error).toBe("Not found");
    expect((await actions.deletePayrollEntry(row.id, "because I can")).error).toBe("Not found");
  });

  it("is closed to somebody at the org whose flag was never turned on", async () => {
    who = LZ_TECH;
    const res = await actions.readPayroll(1);
    // No flag and no row of their own: nothing at all.
    expect(res.error).toBe("Not found");
    expect((await actions.addPayrollEntry(1, pay({ name: "Me, richer" }))).error).toBe("Not found");
  });

  it("does not let a client reach into the shop's, or another client's", async () => {
    who = LZ_MANAGER;
    expect((await actions.readPayroll(3)).error).toBe("Not found");
    expect((await actions.readPayroll(2)).error).toBe("Not found");
    expect((await actions.addPayrollEntry(3, pay({ name: "Nope" }))).error).toBe("Not found");
  });
});

describe("a raise", () => {
  it("closes the old line rather than rewriting it", async () => {
    who = SHOP_OWNER;
    const before = (await testDb.select().from(schema.payroll)).filter((r) => r.name === "Bill Harner");
    expect(before).toHaveLength(1);

    const res = await actions.addPayrollEntry(3, pay({ amount: "108,000", effectiveOn: "2026-07-01" }));
    expect(res.error).toBeUndefined();
    expect(res.superseded).toBe("2026-06-30");

    const after = (await testDb.select().from(schema.payroll)).filter((r) => r.name === "Bill Harner");
    expect(after).toHaveLength(2);
    const old = after.find((r) => r.amountCents === 9_600_000)!;
    const now = after.find((r) => r.amountCents === 10_800_000)!;
    expect(old.endsOn).toBe("2026-06-30");
    expect(now.endsOn).toBe("");

    // June still costs what June cost, and July is not double-counted.
    const { payrollForMonth } = await import("@/lib/payroll");
    const rows = after.map((r) => ({ ...r })) as never[];
    const june = payrollForMonth(rows, "2026-06");
    const july = payrollForMonth(rows, "2026-07");
    expect(june.people).toHaveLength(1);
    expect(july.people).toHaveLength(1);
    expect(july.totalCents).toBeGreaterThan(june.totalCents);
  });

  it("never writes the figure into the audit trail", async () => {
    // The audit log is read by more people than the register is.
    const lines = (await testDb.select().from(schema.auditLog))
      .filter((a) => a.entityType === "payroll").map((a) => a.action);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/96,000|108,000|9600000|\$/);
    }
  });
});

describe("who may turn the flag on", () => {
  it("is the shop, and it gains them nothing", async () => {
    who = SHOP_OWNER;
    const [row] = (await testDb.select().from(schema.clientAllowlist))
      .filter((r) => r.entry === "tech@labzen.test");
    expect((await actions.setClientSeesPayroll(row.id, true)).error).toBeUndefined();
    const [after] = (await testDb.select().from(schema.clientAllowlist)).filter((r) => r.id === row.id);
    expect(after.canSeePayroll).toBe(true);
    // Granting it did not grant the shop anything.
    expect((await actions.readPayroll(1)).error).toBe("Not found");
    // The person it was granted to can now read their org's register.
    who = LZ_TECH;
    expect((await actions.readPayroll(1)).whole).toBe(true);
  });

  it("is not another operator", async () => {
    who = RIVAL_OWNER;
    const [row] = (await testDb.select().from(schema.clientAllowlist))
      .filter((r) => r.entry === "tech@labzen.test");
    expect((await actions.setClientSeesPayroll(row.id, false)).error).toBe("Not found");
  });
});
