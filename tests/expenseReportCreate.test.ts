// Opening an expense report, as the desk now insists it be opened.
//
// The shape the shop asked for is three answers and then the receipts: whose
// claim this is, what to call it, and which job it was for - open or closed,
// or an explicit "no job". Before this there were two doors into the table and
// neither asked for the third: the dialog took a name and a purpose, and the
// pool's "submit these" minted a nameless, jobless report already awaiting
// payout. Half the reports on the owner's desk read "Steve Jones, Jul 12 -
// Aug 3", and none of them said what job the money was spent on.
//
// So the interesting assertions here are the REFUSALS - a report with no name,
// a report whose job field was never answered - and the one that has bitten
// this codebase repeatedly: a work order id off the wire that belongs to
// somebody else's company.
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

/*
 * A root operator and two service companies under it. The root matters: a
 * viewer whose operator IS the root is platform staff, readTenant returns null
 * for them and every forTenant predicate drops out - which is the support
 * path, and exactly the wrong shape to test a tenant wall with. Sierra's
 * people are staff of Sierra, under a platform they are not.
 */
const ROOT = 1, SIERRA = 2, CASCADE = 3;

const OWNER: Who = {
  email: "owner@sierra.test", name: "Dana Reyes", role: "owner",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: ROOT,
};
const HR: Who = {
  email: "hr@sierra.test", name: "Pat Okafor", role: "staff",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: ROOT,
};
const TECH: Who = {
  email: "tech@sierra.test", name: "Steve Jones", role: "staff",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: ROOT,
};

/** Sierra's jobs, and the one next door that must never be attachable here. */
const SIERRA_WO = 1, SIERRA_CLOSED_WO = 2, CASCADE_WO = 3;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (name, kind, is_operator) VALUES
      ('Ridgeline', 'provider', true),
      ('Sierra Spectra', 'provider', true),
      ('Cascade Instrument', 'provider', true);
    INSERT INTO app_settings (id, operator_org_id) VALUES (1, ${ROOT});

    -- A Steve Jones at each company: the collision that makes every
    -- name-based question in this area worth asking twice.
    INSERT INTO house_members (email, org_id, role, name, can_admin_people) VALUES
      ('owner@sierra.test', ${SIERRA}, 'owner', 'Dana Reyes',  false),
      ('hr@sierra.test',    ${SIERRA}, 'staff', 'Pat Okafor',  true),
      ('tech@sierra.test',  ${SIERRA}, 'staff', 'Steve Jones', false),
      ('tech@cascade.test', ${CASCADE}, 'staff', 'Steve Jones', false);

    INSERT INTO work_orders (id, tenant_org_id, number, title, state) VALUES
      (${SIERRA_WO},        ${SIERRA},  'WO-1001', 'Reno install',     'active'),
      (${SIERRA_CLOSED_WO}, ${SIERRA},  'WO-0904', 'Spring PM, Emery', 'closed'),
      (${CASCADE_WO},       ${CASCADE}, 'WO-2001', 'Cascade rebuild',  'active');
  `);
});

beforeEach(async () => {
  who = TECH;
  await client.exec(`DELETE FROM expenses; DELETE FROM expense_reports;`);
});

const reports = async () => {
  const { expenseReports } = schema;
  return testDb.select().from(expenseReports);
};

const NAMED = { title: "Reno install, week of the 12th", workOrderId: SIERRA_WO };

describe("the three answers a new report is opened with", () => {
  it("takes the name and the job, and lands as a draft", async () => {
    const { createExpenseReport } = await import("@/app/actions");
    const res = await createExpenseReport({ ...NAMED, purpose: "Commissioning the LC-MS" });
    expect(res.error).toBeUndefined();
    const [r] = await reports();
    expect(r.title).toBe("Reno install, week of the 12th");
    expect(r.workOrderId).toBe(SIERRA_WO);
    expect(r.person).toBe("Steve Jones");
    // A DRAFT. Nothing is claimed until it is submitted, which is the half of
    // the flow the pool's old "submit these" gesture skipped entirely.
    expect(r.status).toBe("draft");
  });

  it("refuses a nameless report", async () => {
    const { createExpenseReport } = await import("@/app/actions");
    expect((await createExpenseReport({ title: "   ", workOrderId: SIERRA_WO })).error).toBeTruthy();
    expect(await reports()).toEqual([]);
  });

  it("refuses a report whose job field was never answered", async () => {
    /*
     * The distinction this whole thing turns on: `undefined` is a field
     * nobody filled in, `null` is somebody saying "no job - overhead". If a
     * skipped field quietly became overhead, a trip's receipts would be costed
     * against nothing and nobody would ever find out.
     */
    const { createExpenseReport } = await import("@/app/actions");
    expect((await createExpenseReport({ title: "Reno install" })).error).toBeTruthy();
    expect(await reports()).toEqual([]);
  });

  it("takes null as the real answer that it is overhead", async () => {
    const { createExpenseReport } = await import("@/app/actions");
    expect((await createExpenseReport({ title: "Q3 software seats", workOrderId: null })).error)
      .toBeUndefined();
    expect((await reports())[0].workOrderId).toBeNull();
  });

  it("attaches a CLOSED job as readily as an open one", async () => {
    // The receipts turn up after the job does. Refusing a closed order would
    // send somebody to reopen a finished record to file a hotel bill.
    const { createExpenseReport } = await import("@/app/actions");
    const res = await createExpenseReport({ title: "Emery PM, the drive", workOrderId: SIERRA_CLOSED_WO });
    expect(res.error).toBeUndefined();
    expect((await reports())[0].workOrderId).toBe(SIERRA_CLOSED_WO);
  });

  it("refuses the company next door's job", async () => {
    /*
     * The id came off the wire. requireStaff is true for every operator's
     * people, so without the tenant predicate in reportWorkOrder the picker is
     * the only thing standing between a claim and another company's job
     * number - and a picker is not a rule.
     */
    const { createExpenseReport } = await import("@/app/actions");
    const res = await createExpenseReport({ title: "Nice try", workOrderId: CASCADE_WO });
    expect(res.error).toBeTruthy();
    expect(await reports()).toEqual([]);
  });
});

describe("who is opening it", () => {
  it("lets HR open a claim in a colleague's name, and records who filed it", async () => {
    const { createExpenseReport } = await import("@/app/actions");
    who = HR;
    const res = await createExpenseReport({ ...NAMED, onBehalfOf: "Steve Jones" });
    expect(res.error).toBeUndefined();
    const [r] = await reports();
    // The money is owed to Steve; the filing was Pat's. Both facts survive,
    // which they did not when one column carried them.
    expect(r.person).toBe("Steve Jones");
    expect(r.openedBy).toBe("hr@sierra.test");
    // And submittedBy stays empty until somebody actually sends it - it used
    // to be stamped at creation and never touched again.
    expect(r.submittedBy).toBe("");
  });

  it("refuses an ordinary engineer opening one in somebody else's name", async () => {
    const { createExpenseReport } = await import("@/app/actions");
    who = TECH;
    expect((await createExpenseReport({ ...NAMED, onBehalfOf: "Pat Okafor" })).error).toBeTruthy();
    expect(await reports()).toEqual([]);
  });

  it("refuses a name that is not on this workspace's roster", async () => {
    const { createExpenseReport } = await import("@/app/actions");
    who = HR;
    expect((await createExpenseReport({ ...NAMED, onBehalfOf: "Rae Lindqvist" })).error).toBeTruthy();
  });

  it("stamps the submitter at the submit, not at the open", async () => {
    const { createExpenseReport, logMyExpense, submitDraftReport } = await import("@/app/actions");
    who = HR;
    const { id } = await createExpenseReport({ ...NAMED, onBehalfOf: "Steve Jones" });
    await logMyExpense({
      kind: "Meals", description: "Diner, Tuesday", amount: "43.00",
      incurredOn: "2026-08-04", workOrderId: SIERRA_WO, reportId: id!,
    });
    expect((await submitDraftReport(id!)).error).toBeUndefined();
    const [r] = await reports();
    expect(r.status).toBe("submitted");
    expect(r.submittedBy).toBe("hr@sierra.test");
    expect(r.openedBy).toBe("hr@sierra.test");
  });
});

describe("seeding a report from the unclaimed pool", () => {
  const poolRow = (person: string, loggedBy: string, tenant: number = SIERRA) => client.exec(`
    INSERT INTO expenses (tenant_org_id, kind, description, amount_cents, incurred_on, person, logged_by)
    VALUES (${tenant}, 'Meals', 'Diner, Tuesday', 4300, '2026-08-04', '${person}', '${loggedBy}');
  `);

  const expenseIds = async () => {
    const { expenses } = schema;
    return (await testDb.select().from(expenses)).map((e) => e.id);
  };

  it("pulls the ticked rows onto the new draft", async () => {
    // The pool's gesture, which used to be its own door into the table. It
    // comes through the named-and-jobbed form now and still leaves a DRAFT.
    const { createExpenseReport } = await import("@/app/actions");
    await poolRow("Steve Jones", "tech@sierra.test");
    const ids = await expenseIds();
    const res = await createExpenseReport({ ...NAMED, expenseIds: ids });
    expect(res.error).toBeUndefined();
    const { expenses } = schema;
    expect((await testDb.select().from(expenses))[0].reportId).toBe(res.id);
    expect((await reports())[0].status).toBe("draft");
  });

  it("refuses somebody else's receipt, and opens no report when it does", async () => {
    /*
     * Checked BEFORE the row is inserted, so a bad pick refuses rather than
     * leaving an empty draft behind for somebody to wonder about.
     */
    const { createExpenseReport } = await import("@/app/actions");
    await poolRow("Pat Okafor", "hr@sierra.test");
    const res = await createExpenseReport({ ...NAMED, expenseIds: await expenseIds() });
    expect(res.error).toBeTruthy();
    expect(await reports()).toEqual([]);
  });

  it("fills a colleague's claim from the colleague's pocket, not the filer's", async () => {
    // HR opening for Steve offers STEVE's receipts. Computing the pool from
    // the caller would put Pat's lunch on Steve's claim.
    const { createExpenseReport } = await import("@/app/actions");
    await poolRow("Steve Jones", "tech@sierra.test");
    await poolRow("Pat Okafor", "hr@sierra.test");
    const [steves, pats] = await expenseIds();
    who = HR;
    expect((await createExpenseReport({ ...NAMED, onBehalfOf: "Steve Jones", expenseIds: [pats] })).error)
      .toBeTruthy();
    expect((await createExpenseReport({ ...NAMED, onBehalfOf: "Steve Jones", expenseIds: [steves] })).error)
      .toBeUndefined();
  });
});

describe("moving a claim onto a different job", () => {
  /* Creation-time-only would mean deleting the report and starting again the
     first time a trip turns out to have been for the other site. */
  it("moves it, and takes it off onto overhead", async () => {
    const { createExpenseReport, setReportWorkOrder } = await import("@/app/actions");
    const { id } = await createExpenseReport(NAMED);
    expect((await setReportWorkOrder(id!, SIERRA_CLOSED_WO)).error).toBeUndefined();
    expect((await reports())[0].workOrderId).toBe(SIERRA_CLOSED_WO);
    expect((await setReportWorkOrder(id!, null)).error).toBeUndefined();
    expect((await reports())[0].workOrderId).toBeNull();
  });

  it("will not move it onto another company's job", async () => {
    const { createExpenseReport, setReportWorkOrder } = await import("@/app/actions");
    const { id } = await createExpenseReport(NAMED);
    expect((await setReportWorkOrder(id!, CASCADE_WO)).error).toBeTruthy();
    expect((await reports())[0].workOrderId).toBe(SIERRA_WO);
  });

  it("will not touch a claim that has been paid", async () => {
    const { createExpenseReport, setReportWorkOrder } = await import("@/app/actions");
    const { id } = await createExpenseReport(NAMED);
    const { expenseReports } = schema;
    const { eq } = await import("drizzle-orm");
    await testDb.update(expenseReports).set({ status: "paid" }).where(eq(expenseReports.id, id!));
    expect((await setReportWorkOrder(id!, SIERRA_CLOSED_WO)).error).toBeTruthy();
  });

  it("will not let an engineer re-file a colleague's claim", async () => {
    const { createExpenseReport, setReportWorkOrder } = await import("@/app/actions");
    who = HR;
    const { id } = await createExpenseReport({ ...NAMED, onBehalfOf: "Pat Okafor" });
    who = TECH;
    expect((await setReportWorkOrder(id!, SIERRA_CLOSED_WO)).error).toBeTruthy();
  });

  it("lets the owner re-file anybody's, which is what administering people means", async () => {
    const { createExpenseReport, setReportWorkOrder } = await import("@/app/actions");
    who = TECH;
    const { id } = await createExpenseReport(NAMED);
    who = OWNER;
    expect((await setReportWorkOrder(id!, SIERRA_CLOSED_WO)).error).toBeUndefined();
  });
});
