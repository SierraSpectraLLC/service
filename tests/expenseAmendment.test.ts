// The receipt that turns up after the claim was paid.
//
// Reported: "I had to manually open one as a new report." A submitted or paid
// claim refuses new rows, correctly - it has been approved, and once paid the
// money has moved - but the refusal was the end of the road. What people did
// was open a fresh report by hand and retype the trip's name, its job and its
// purpose, which leaves two claims for one trip with nothing tying them
// together and the second reading as a separate expense nobody can reconcile.
//
// An amendment is an ordinary report in every respect but one: amends_id, the
// thread back. What is pinned here is that asking twice does not open two
// claims, that it carries the facts that made retyping a chore and NOT the
// rows (which would be asking to be paid twice), and that filing a receipt
// against a settled report goes there by itself rather than dead-ending.
//
// Real Postgres, in-process, from the same DDL every deploy applies.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

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

const ROOT = 1, SIERRA = 2, CASCADE = 3;

const STEVE: Who = {
  email: "steve@sierra.test", name: "Steve Jones", role: "staff",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: ROOT,
};
const RITA: Who = {
  email: "rita@cascade.test", name: "Rita Okafor", role: "owner",
  orgId: null, operatorOrgId: CASCADE, rootOperatorOrgId: ROOT,
};

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator, parent_org_id) VALUES
      (${ROOT},    'Ridgeline',       'provider', true, NULL),
      (${SIERRA},  'Sierra Spectra',  'provider', true, NULL),
      (${CASCADE}, 'Cascade Service', 'provider', true, NULL);
    INSERT INTO app_settings (id, operator_org_id) VALUES (1, ${ROOT});
    INSERT INTO house_members (email, org_id, role, name) VALUES
      ('steve@sierra.test', ${SIERRA},  'staff', 'Steve Jones'),
      ('rita@cascade.test', ${CASCADE}, 'owner', 'Rita Okafor');
  `);
});

/** One settled claim of Steve's, in whatever status the case needs. */
const settled = async (status = "paid") => {
  const [r] = await testDb.insert(schema.expenseReports).values({
    tenantOrgId: SIERRA, person: "Steve Jones", status,
    title: "Reno install, week of the 12th", purpose: "Source rebuild on the 8060",
    openedBy: "steve@sierra.test", paidOn: status === "paid" ? "2026-08-20" : "",
  }).returning();
  await testDb.insert(schema.expenses).values({
    tenantOrgId: SIERRA, kind: "Fuel", description: "Reno round trip",
    amountCents: 6140, incurredOn: "2026-08-10", person: "Steve Jones",
    loggedBy: "steve@sierra.test", reportId: r!.id,
  });
  return r!;
};

beforeEach(async () => {
  who = STEVE;
  await client.exec(`DELETE FROM expenses; DELETE FROM expense_reports; DELETE FROM audit_log;`);
  vi.resetModules();
});

const reports = async () => testDb.select().from(schema.expenseReports)
  .orderBy(schema.expenseReports.id);

describe("opening one", () => {
  it("carries the trip, the job and the purpose - and not the rows", async () => {
    /*
     * Those three are exactly what made doing it by hand a chore and a chance
     * to get one wrong. The ROWS are the one thing it must not carry: an
     * amendment claims what the first claim missed, and copying them would ask
     * to be paid twice for the same receipts.
     */
    const first = await settled();
    const { amendExpenseReport } = await import("@/app/actions");
    const res = await amendExpenseReport(first.id);
    expect(res.error).toBeUndefined();

    const all = await reports();
    const amendment = all.find((r) => r.id === res.id)!;
    expect(amendment.person).toBe("Steve Jones");
    expect(amendment.purpose).toBe("Source rebuild on the 8060");
    expect(amendment.amendsId).toBe(first.id);
    expect(amendment.status).toBe("draft");
    expect(amendment.title).toBe("Reno install, week of the 12th - amendment");

    const carried = await testDb.select().from(schema.expenses)
      .where(eq(schema.expenses.reportId, amendment.id));
    expect(carried).toEqual([]);
  });

  it("leaves the original exactly as it was paid", async () => {
    const first = await settled();
    const { amendExpenseReport } = await import("@/app/actions");
    await amendExpenseReport(first.id);
    const [after] = await testDb.select().from(schema.expenseReports)
      .where(eq(schema.expenseReports.id, first.id));
    expect(after!.status).toBe("paid");
    expect(after!.paidOn).toBe("2026-08-20");
    expect((await testDb.select().from(schema.expenses)
      .where(eq(schema.expenses.reportId, first.id))).length).toBe(1);
  });

  it("hands back the same one rather than opening a second", async () => {
    // What makes it safe to offer from a button, from filing a receipt, and
    // from a double-click, all at once.
    const first = await settled();
    const { amendExpenseReport } = await import("@/app/actions");
    const a = await amendExpenseReport(first.id);
    const b = await amendExpenseReport(first.id);
    expect(b.id).toBe(a.id);
    expect(b.existing).toBe(true);
    expect((await reports()).filter((r) => r.amendsId === first.id)).toHaveLength(1);
  });

  it("opens the next one once the first amendment has gone in", async () => {
    // A second late receipt is a second correction and its own money - the
    // idempotence is about one claim still being FILLED, not about ever.
    const first = await settled();
    const { amendExpenseReport } = await import("@/app/actions");
    const a = await amendExpenseReport(first.id);
    await testDb.update(schema.expenseReports).set({ status: "submitted" })
      .where(eq(schema.expenseReports.id, a.id!));
    const b = await amendExpenseReport(first.id);
    expect(b.id).not.toBe(a.id);
    expect((await reports()).filter((r) => r.amendsId === first.id)).toHaveLength(2);
  });

  it("refuses a report that can simply take the receipt", async () => {
    // A draft is still open to the row. A second claim beside one that can
    // carry it splits a trip across two payouts for no reason.
    const first = await settled("draft");
    const { amendExpenseReport } = await import("@/app/actions");
    expect((await amendExpenseReport(first.id)).error).toMatch(/add the receipt to it directly/);
  });

  it("is not somebody else's report to amend", async () => {
    // expense_reports.person is free text and two shops can both employ a
    // Steve Jones, so the tenant is checked before the name.
    const first = await settled();
    who = RITA;
    vi.resetModules();
    const { amendExpenseReport } = await import("@/app/actions");
    expect((await amendExpenseReport(first.id)).error).toBe("Not your report");
    expect(await reports()).toHaveLength(1);
  });
});

describe("a receipt filed against a settled report", () => {
  it("goes to the amendment instead of dead-ending", async () => {
    // The reported gesture: the late receipt, aimed at the claim it belongs
    // to. It used to come back "That report is paid - it cannot take new rows"
    // and leave somebody to open a report by hand.
    const first = await settled();
    const { logMyExpense } = await import("@/app/actions");
    const res = await logMyExpense({
      kind: "Meals", description: "Airport dinner", amount: "38.40",
      incurredOn: "2026-08-12", workOrderId: null, reportId: first.id,
    });
    expect(res.error).toBeUndefined();
    expect(res.amendedTo).toBeTruthy();

    const amendment = (await reports()).find((r) => r.id === res.amendedTo)!;
    expect(amendment.amendsId).toBe(first.id);
    const rows = await testDb.select().from(schema.expenses)
      .where(eq(schema.expenses.reportId, amendment.id));
    expect(rows.map((r) => r.description)).toEqual(["Airport dinner"]);
    // And the paid claim is untouched.
    expect((await testDb.select().from(schema.expenses)
      .where(eq(schema.expenses.reportId, first.id))).length).toBe(1);
  });

  it("puts a second late receipt on the same amendment", async () => {
    const first = await settled();
    const { logMyExpense } = await import("@/app/actions");
    const a = await logMyExpense({
      kind: "Meals", description: "Airport dinner", amount: "38.40",
      incurredOn: "2026-08-12", workOrderId: null, reportId: first.id,
    });
    const b = await logMyExpense({
      kind: "Fuel", description: "Return leg", amount: "22.10",
      incurredOn: "2026-08-13", workOrderId: null, reportId: first.id,
    });
    expect(b.amendedTo).toBe(a.amendedTo);
    expect((await reports()).filter((r) => r.amendsId === first.id)).toHaveLength(1);
  });

  it("says nothing about an amendment on an ordinary draft", async () => {
    // The common path must not grow a hop. A draft takes the row itself.
    const draft = await settled("draft");
    const { logMyExpense } = await import("@/app/actions");
    const res = await logMyExpense({
      kind: "Meals", description: "Lunch", amount: "12.00",
      incurredOn: "2026-08-12", workOrderId: null, reportId: draft.id,
    });
    expect(res.amendedTo).toBeUndefined();
    expect(await reports()).toHaveLength(1);
  });

  it("sweeps pool rows onto the amendment too", async () => {
    const first = await settled();
    const [loose] = await testDb.insert(schema.expenses).values({
      tenantOrgId: SIERRA, kind: "Parking", description: "Airport garage",
      amountCents: 4800, incurredOn: "2026-08-11", person: "Steve Jones",
      loggedBy: "steve@sierra.test",
    }).returning();
    const { attachPoolExpenses } = await import("@/app/actions");
    const res = await attachPoolExpenses(first.id, [loose!.id]);
    expect(res.error).toBeUndefined();
    expect(res.amendedTo).toBeTruthy();
    const [moved] = await testDb.select().from(schema.expenses)
      .where(eq(schema.expenses.id, loose!.id));
    expect(moved!.reportId).toBe(res.amendedTo);
  });

  it("records that the row did not land where it was aimed", async () => {
    const first = await settled();
    const { logMyExpense } = await import("@/app/actions");
    await logMyExpense({
      kind: "Meals", description: "Airport dinner", amount: "38.40",
      incurredOn: "2026-08-12", workOrderId: null, reportId: first.id,
    });
    const log = await testDb.select().from(schema.auditLog);
    expect(log.some((r) => /onto an amendment/.test(r.action))).toBe(true);
    expect(log.some((r) => /the original stays as it was paid/.test(r.action))).toBe(true);
  });
});

describe("the tenant boundary", () => {
  it("will not let another shop's claim be amended by filing a receipt at it", async () => {
    const first = await settled();
    who = RITA;
    vi.resetModules();
    const { logMyExpense } = await import("@/app/actions");
    const res = await logMyExpense({
      kind: "Meals", description: "Not theirs", amount: "10.00",
      incurredOn: "2026-08-12", workOrderId: null, reportId: first.id,
    });
    expect(res.error).toBe("Not your report");
    expect(await reports()).toHaveLength(1);
    void and;
  });
});
