// HR: who administers the people, and what that does and does not buy.
//
// The request this was built for is one sentence - "I need to be able to
// create expense reports on behalf of other employees" - and it has two edges
// that a test is the only honest way to hold.
//
// The first is the one this app keeps having to relearn: A NAME IS NOT A
// SCOPE. expense_reports.person is free text, a directory name, not a foreign
// key. Two service companies can genuinely both employ a Steve Jones, and
// house_members is a single instance-wide table. So every question below is
// asked twice, once per operator, and the interesting answer is always the
// second one.
//
// The second is what HR is NOT. It was tempting to make it a third role, and
// tempting once it was a flag to hang the whole financial section off it. It
// reads the payroll register - somebody has to run the payout - and it does
// not read the books. lib/books stays owner-only, and the invariant that
// survives is one-directional: anybody who may read the books may read the
// payroll, never the reverse.
//
// Real Postgres, in-process, from the same DDL every deploy applies, for the
// half of this that lives in a WHERE clause.
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { mayWorkReport, reimbursementPool } from "@/lib/expenseReports";
import { maySeeBooks } from "@/lib/books";
import { maySeePayroll, mayEditPayroll } from "@/lib/payroll";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });

vi.mock("@/db", () => ({ db: testDb }));

const SIERRA = 1, CASCADE = 2, LABZEN = 3;

/*
 * Two service companies, and a Steve Jones at each. That collision is not
 * decoration: it is the shape of the bug this feature could most easily have
 * shipped, since a report is filed against a name and the roster it is checked
 * against is one table for the whole instance.
 */
beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (name, kind, is_operator, parent_org_id) VALUES
      ('Sierra Spectra', 'provider', true, NULL),
      ('Cascade Instrument', 'provider', true, NULL),
      ('Lab Zen', 'client', false, 1);

    INSERT INTO house_members (email, org_id, role, name, can_admin_people) VALUES
      ('owner@sierra.test',   1, 'owner', 'Dana Reyes',  false),
      ('hr@sierra.test',      1, 'staff', 'Pat Okafor',  true),
      ('tech@sierra.test',    1, 'staff', 'Steve Jones', false),
      ('owner@cascade.test',  2, 'owner', 'Rae Lindqvist', false),
      ('tech@cascade.test',   2, 'staff', 'Steve Jones', false);

    INSERT INTO client_allowlist (entry, org_id, can_see_payroll, can_see_money) VALUES
      ('manager@labzen.test', 3, true, true),
      ('bench@labzen.test',   3, false, true);

    -- Sierra's Steve is out of pocket for two things; Cascade's Steve for one.
    -- The overhead row names him; the job row names nobody and is claimed by
    -- whoever logged it, which is the fallback reimbursementPool needs an
    -- address for.
    INSERT INTO expenses (tenant_org_id, kind, description, amount_cents, incurred_on, person, logged_by) VALUES
      (1, 'meals',  'Diner, Tuesday',   4300, '2026-08-04', 'Steve Jones', 'tech@sierra.test'),
      (1, 'fuel',   'Fuel, the run',    9100, '2026-08-05', '',            'tech@sierra.test'),
      (2, 'meals',  'Cascade lunch',    2200, '2026-08-06', 'Steve Jones', 'tech@cascade.test');

    INSERT INTO expense_reports (id, tenant_org_id, person, status, submitted_by) VALUES
      (1, 1, 'Steve Jones', 'draft', 'hr@sierra.test'),
      (2, 2, 'Steve Jones', 'draft', 'owner@cascade.test');
  `);
});

/** The rows an action would have in hand: one workspace's, fetched under its stamp. */
const inTenant = async (t: number) => {
  const { expenses } = schema;
  const { eq } = await import("drizzle-orm");
  return testDb.select().from(expenses).where(eq(expenses.tenantOrgId, t));
};

const house = (over: Record<string, unknown> = {}) => ({
  email: "tech@sierra.test", role: "staff", orgId: null,
  operatorOrgId: SIERRA, rootOperatorOrgId: SIERRA, ...over,
});

describe("the flag is read from the asker's own roster row", () => {
  it("is on for the person the owner made HR, and off for everybody else", async () => {
    const { isHouseHr } = await import("@/lib/hr");
    expect(await isHouseHr(house({ email: "hr@sierra.test" }))).toBe(true);
    expect(await isHouseHr(house({ email: "tech@sierra.test" }))).toBe(false);
    expect(await isHouseHr(house({ email: "owner@sierra.test", role: "owner" }))).toBe(false);
  });

  it("is off for an address with no row at all", async () => {
    // How a STAFF_EMAILS break-glass session arrives: a way in, not a
    // promotion. It must not read as HR just because nothing contradicts it.
    const { isHouseHr } = await import("@/lib/hr");
    expect(await isHouseHr(house({ email: "nobody@sierra.test" }))).toBe(false);
  });

  it("is off for a client, whatever their allowlist says", async () => {
    // manager@labzen has can_see_payroll. That is a privilege over their OWN
    // organization's register; it is not a claim on the operator's roster, and
    // their organization has no house to administer.
    const { isHouseHr, mayAdminPeople } = await import("@/lib/hr");
    const client = house({ email: "manager@labzen.test", role: "client_editor", orgId: LABZEN });
    expect(await isHouseHr(client)).toBe(false);
    expect(await mayAdminPeople(client)).toBe(false);
  });

  it("lets the owner administer people without a flag", async () => {
    const { mayAdminPeople } = await import("@/lib/hr");
    expect(await mayAdminPeople(house({ email: "owner@sierra.test", role: "owner" }))).toBe(true);
    expect(await mayAdminPeople(house({ email: "hr@sierra.test" }))).toBe(true);
    expect(await mayAdminPeople(house({ email: "tech@sierra.test" }))).toBe(false);
  });
});

describe("HR reads the payroll register and not the books", () => {
  it("opens their own workspace's register", async () => {
    const { payrollViewerFor } = await import("@/lib/hr");
    const v = await payrollViewerFor(house({ email: "hr@sierra.test" }));
    expect(maySeePayroll(v, SIERRA)).toBe(true);
  });

  it("does not open the workspace next door's", async () => {
    const { payrollViewerFor } = await import("@/lib/hr");
    const v = await payrollViewerFor(house({ email: "hr@sierra.test" }));
    expect(maySeePayroll(v, CASCADE)).toBe(false);
    expect(maySeePayroll(v, LABZEN)).toBe(false);
  });

  it("leaves an ordinary engineer with nothing but their own row", async () => {
    const { payrollViewerFor, seesPayrollFor } = await import("@/lib/hr");
    const v = await payrollViewerFor(house({ email: "tech@sierra.test" }));
    expect(maySeePayroll(v, SIERRA)).toBe(false);
    expect(await seesPayrollFor(house({ email: "tech@sierra.test" }))).toBe(false);
  });

  it("lets HR keep the register, not just read it", async () => {
    /*
     * This pinned the opposite for one release: reading was HR's, deciding
     * was the owner's. The person file made that stance untenable - the owner
     * decides the raise and the office manager RECORDS it, with the start
     * date and the stipend, because recording is what HR is for. The flag is
     * still handed out by the owner alone, so the decision still traces to
     * them; what changed is who may type it in. Their own workspace only.
     */
    const { payrollViewerFor } = await import("@/lib/hr");
    const v = await payrollViewerFor(house({ email: "hr@sierra.test" }));
    expect(mayEditPayroll(v, SIERRA)).toBe(true);
    expect(mayEditPayroll(v, SIERRA + 1)).toBe(false);
  });

  it("gives HR no part of the books", async () => {
    const books = {
      email: "hr@sierra.test", role: "staff", orgId: null,
      operatorOrgId: SIERRA, canSeeMoney: true,
    };
    expect(maySeeBooks(books, SIERRA)).toBe(false);
  });
});

describe("books imply payroll, and never the other way round", () => {
  /*
   * The invariant that replaced "payroll requires the books". It used to be
   * enforced by financeRail collapsing the pair; it is now a property of the
   * two rules, so it is asserted directly over every reader shape the app can
   * produce. Reversing it would mean an engineer who cannot read a register
   * reading what the shop invoiced, which is the leak lib/books exists for.
   */
  const ORGS = [SIERRA, CASCADE, LABZEN];
  const ROLES = ["owner", "staff", "client_editor", "client_viewer"];

  it("holds for every combination of role, workspace and flag", () => {
    for (const role of ROLES) {
      for (const orgId of [null, LABZEN]) {
        for (const operatorOrgId of [null, SIERRA, CASCADE]) {
          for (const flag of [true, false]) {
            for (const target of ORGS) {
              const shared = { email: "x@y.test", role, orgId, operatorOrgId };
              const books = maySeeBooks({ ...shared, canSeeMoney: flag }, target);
              const pay = maySeePayroll({ ...shared, canSeePayroll: flag }, target);
              // Same flag on both sides: this is the shape a real reader has,
              // since canSeeMoney and canSeePayroll are set together for a
              // client and both come off the one house row for the shop.
              expect(`${role}/${orgId}/${operatorOrgId}/${flag}/${target}: ${books && !pay}`)
                .toBe(`${role}/${orgId}/${operatorOrgId}/${flag}/${target}: false`);
            }
          }
        }
      }
    }
  });
});

describe("whose claim it is", () => {
  const HR = { name: "Pat Okafor", adminsPeople: true };
  const TECH = { name: "Steve Jones", adminsPeople: false };

  it("is always your own", () => {
    expect(mayWorkReport(TECH, { person: "Steve Jones" })).toBe(true);
    // A stray capital or a trailing space must not lock somebody out of their
    // own money.
    expect(mayWorkReport(TECH, { person: " steve jones " })).toBe(true);
  });

  it("is nobody else's without the flag", () => {
    expect(mayWorkReport(TECH, { person: "Pat Okafor" })).toBe(false);
  });

  it("is anybody's with it", () => {
    expect(mayWorkReport(HR, { person: "Steve Jones" })).toBe(true);
  });

  it("is not everybody's for a nameless account", () => {
    // An engineer with no name set would match every report whose person is
    // blank if the empty string were allowed to match. It is not.
    expect(mayWorkReport({ name: "", adminsPeople: false }, { person: "" })).toBe(false);
  });

  it("says nothing about the tenant - which is why the caller must", () => {
    // Both Steves. This function cannot tell them apart and does not pretend
    // to; the report's own stamp is checked first, by workableReport in
    // app/actions and by the page above it.
    expect(mayWorkReport(TECH, { person: "Steve Jones" })).toBe(true);
  });
});

describe("the claimant a report is filed for", () => {
  it("resolves to the person on that report's own roster", async () => {
    const { reportSubjectFor } = await import("@/lib/hr");
    expect(await reportSubjectFor({ person: "Steve Jones", tenantOrgId: SIERRA }))
      .toEqual({ name: "Steve Jones", email: "tech@sierra.test" });
    expect(await reportSubjectFor({ person: "Steve Jones", tenantOrgId: CASCADE }))
      .toEqual({ name: "Steve Jones", email: "tech@cascade.test" });
  });

  it("returns no address rather than a wrong one", async () => {
    // Plenty of names on a report belong to somebody who has never signed in.
    // An empty string matches no expense row, where a fallback to the FILER's
    // address would have pulled the filer's own receipts into the claim.
    const { reportSubjectFor } = await import("@/lib/hr");
    expect(await reportSubjectFor({ person: "Nobody At All", tenantOrgId: SIERRA }))
      .toEqual({ name: "Nobody At All", email: "" });
  });

  it("fills a colleague's claim from the colleague's pocket", async () => {
    /*
     * The whole feature, end to end at the level that matters: HR opens a
     * claim for Steve, and the rows offered are the ones STEVE is out of
     * pocket for - including the fuel he logged against a job without naming
     * himself, which is only reachable through his address.
     *
     * `inTenant` is the action's own first move, restated: the rows are
     * fetched under forTenant(expenses.tenantOrgId, readTenant(u)) before a
     * name is looked at. The test below says what happens without it.
     */
    const { reportSubjectFor } = await import("@/lib/hr");
    const rows = await inTenant(SIERRA);
    const steve = await reportSubjectFor({ person: "Steve Jones", tenantOrgId: SIERRA });
    const pool = reimbursementPool(rows, steve);
    expect(pool.map((r) => r.description).sort()).toEqual(["Diner, Tuesday", "Fuel, the run"]);

    // And not from HR's own. Computing the pool from the CALLER - which is
    // what every one of these actions did before - would have handed Pat an
    // empty list and offered Pat's receipts on Steve's claim.
    expect(reimbursementPool(rows, { name: "Pat Okafor", email: "hr@sierra.test" })).toEqual([]);
  });

  it("resolves the other company's Steve to the other company's address", async () => {
    const { reportSubjectFor } = await import("@/lib/hr");
    const cascade = await reportSubjectFor({ person: "Steve Jones", tenantOrgId: CASCADE });
    expect(cascade.email).toBe("tech@cascade.test");
    expect(reimbursementPool(await inTenant(CASCADE), cascade).map((r) => r.description))
      .toEqual(["Cascade lunch"]);
  });

  it("collides across companies the moment the tenant filter is dropped", async () => {
    /*
     * Not a bug in reimbursementPool - it is a pure rule over rows it is
     * handed, and it says so. It is the reason every caller fetches under
     * forTenant FIRST, and the reason mayWorkReport's own comment refuses to
     * pretend it knows a tenant.
     *
     * Handed the whole instance, one name matches two companies' engineers,
     * and Sierra's diner receipt lands in Cascade's claim. This test exists so
     * that a future caller who reaches for the rows without the predicate has
     * something that fails rather than something that quietly pays the wrong
     * person.
     */
    const { reportSubjectFor } = await import("@/lib/hr");
    const { expenses } = schema;
    const everything = await testDb.select().from(expenses);
    const cascade = await reportSubjectFor({ person: "Steve Jones", tenantOrgId: CASCADE });
    expect(reimbursementPool(everything, cascade).map((r) => r.description).sort())
      .toEqual(["Cascade lunch", "Diner, Tuesday"]);
  });
});

describe("one place assembles the payroll viewer, and the HR room stays out of the books", () => {
  /*
   * Static, over the source, because both of these are absences and an absence
   * has nothing to assert at runtime.
   *
   * Comments are stripped before either check. Every one of these files
   * EXPLAINS the rule it obeys, naming the very identifiers being searched for,
   * and a check over raw text flags that explanation as the violation it is
   * warning about. This project has now made that mistake five times; the strip
   * is not optional.
   */
  const strip = (path: string) =>
    readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

  it("builds a PayrollViewer nowhere but lib/hr", () => {
    /*
     * The type is five facts, four of which are free off the session and one
     * of which - the flag - now has two possible rosters behind it. Every file
     * that assembled the object itself got that fifth field from whichever
     * roster it happened to know about: the layout knew about owners, the rail
     * knew about clients, financeFigures hardcoded it false. lib/financeData's
     * own comment already warned that a page computing seesPayroll differently
     * from the rail beside it "is exactly the leak this section had to be built
     * around". This is what keeps it to one.
     */
    const ALLOWED = ["src/lib/hr.ts", "src/lib/payroll.ts"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${e.name}`;
        if (e.isDirectory()) { walk(path); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        if (ALLOWED.includes(path)) continue;
        const src = strip(path);
        /*
         * A VIEWER literal, not any mention of the field. The column is
         * defined, selected, written and rendered in half a dozen honest
         * places - schema, the allowlist admin form, the action that toggles
         * it - and none of those is somebody deciding who may read a register.
         * What distinguishes the object is that it carries operatorOrgId
         * beside the flag: that pair IS the viewer, and it is the pair that
         * used to be assembled five ways.
         */
        for (const m of src.matchAll(/canSeePayroll/g)) {
          const near = src.slice(Math.max(0, m.index - 240), m.index + 240);
          if (/operatorOrgId/.test(near)) { offenders.push(path); break; }
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });

  it("keeps the books out of the HR room", () => {
    /*
     * /people is gated on mayAdminPeople, which is NOT the books gate. Every
     * figure on it is a payroll or a reimbursement figure. These readers return
     * the shop's position and have the same shape and return type as things
     * that are fine to render there, so nothing in the type system tells them
     * apart - which file calls which is the whole separation, and this is who
     * checks.
     */
    const src = strip("src/app/people/page.tsx");
    for (const reader of [
      "allInvoices", "allQuotes", "collectionsBoard", "costingBoard", "pmCostingBoard",
      "unbilledJobs",
      "booksContext", "financeFigures", "railContext",
    ]) {
      const named = new RegExp(`\\b${reader}\\b`).test(src);
      expect(`people: ${named ? reader : "clean"}`).toBe("people: clean");
    }
  });

  it("gates the HR room on the flag rather than on a role", () => {
    const src = strip("src/app/people/page.tsx");
    expect(src).toContain("mayAdminPeople");
  });
});
