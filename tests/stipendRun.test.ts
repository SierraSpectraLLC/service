// The stipend pass, against a real database.
//
// This is the only thing in the application that moves money towards a person
// without a human pressing anything that day, so the bar is different. The
// schedule arithmetic is proved next door in tests/stipends; what is proved
// here is the part a pure test cannot reach:
//
//   * running it twice pays once. Not "usually" - the second run must write
//     nothing, and the assertion is on the row count, not on a return value.
//   * three stipends due the same day make ONE claim with three rows, because
//     the alternative is an owner marking three reports paid every month for
//     the same person.
//   * it stays inside its own workspace. stipends is one instance-wide table
//     and `person` is free text, so two companies can both employ a Steve
//     Jones - the same collision lib/hr's tests are built around.
//   * a paused arrangement pays nothing, and restarting it does not back-pay
//     the gap.
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
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const SIERRA = 2, CASCADE = 3;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (name, kind, is_operator) VALUES
      ('Ridgeline', 'provider', true),
      ('Sierra Spectra', 'provider', true),
      ('Cascade Instrument', 'provider', true);
    INSERT INTO house_members (email, org_id, role, name) VALUES
      ('owen@sierra.test',  ${SIERRA},  'staff', 'Owen Brandt'),
      ('tess@sierra.test',  ${SIERRA},  'staff', 'Tess Nakamura'),
      ('owen@cascade.test', ${CASCADE}, 'staff', 'Owen Brandt');
  `);
});

beforeEach(async () => {
  await client.exec(`DELETE FROM expenses; DELETE FROM expense_reports; DELETE FROM stipends;`);
});

/** A live $35/month internet stipend, running from June. */
const stipend = async (over: Record<string, string | number | boolean> = {}) => {
  const v = {
    tenant: SIERRA, person: "Owen Brandt", label: "Internet stipend",
    amount: 3500, kind: "Phone & internet", every: 1, day: 1,
    starts: "2026-06-01", ends: "", active: true, last: "", ...over,
  };
  await client.exec(`
    INSERT INTO stipends (tenant_org_id, person, label, amount_cents, kind, every_months,
      day_of_month, starts_on, ends_on, active, last_on)
    VALUES (${v.tenant}, '${v.person}', '${v.label}', ${v.amount}, '${v.kind}', ${v.every},
      ${v.day}, '${v.starts}', '${v.ends}', ${v.active}, '${v.last}');
  `);
};

const run = async (on: string) => {
  const { runStipends } = await import("@/lib/stipendRun");
  return runStipends(new Date(`${on}T18:00:00Z`));
};

const rows = async () => {
  const { asc } = await import("drizzle-orm");
  return testDb.select().from(schema.expenses).orderBy(asc(schema.expenses.id));
};
const reports = async () => {
  const { asc } = await import("drizzle-orm");
  return testDb.select().from(schema.expenseReports).orderBy(asc(schema.expenseReports.id));
};

describe("what one run produces", () => {
  it("puts the stipend on a submitted perks claim for that month", async () => {
    await stipend({ starts: "2026-08-01" });
    const res = await run("2026-08-01");
    expect(res.raised).toHaveLength(1);

    const [r] = await reports();
    expect(r.title).toBe("General perks - August 2026");
    expect(r.person).toBe("Owen Brandt");
    expect(r.source).toBe("stipend");
    // Overhead, and the null is the real answer: no job caused an internet bill.
    expect(r.workOrderId).toBeNull();
    /* SUBMITTED, unlike the retainer pass which only drafts. The judgement was
       made when the owner set the arrangement up; leaving it as a draft would
       mean somebody submitting the same claim every month, which is the work
       this exists to remove. The money still waits on Mark paid. */
    expect(r.status).toBe("submitted");

    const [e] = await rows();
    expect(e.amountCents).toBe(3500);
    expect(e.description).toBe("Internet stipend - August 2026");
    expect(e.person).toBe("Owen Brandt");
    expect(e.incurredOn).toBe("2026-08-01");
    // Nobody's client pays for our engineer's broadband.
    expect(e.billable).toBe(false);
    expect(e.workOrderId).toBeNull();
  });

  it("does not touch payroll", async () => {
    // The owner's sentence: "but not through a payroll check". The whole
    // reason this table exists rather than a wage line.
    await stipend({ starts: "2026-08-01" });
    await run("2026-08-01");
    expect(await testDb.select().from(schema.payroll)).toEqual([]);
  });

  it("moves the cursor in the same breath as the row", async () => {
    await stipend({ starts: "2026-08-01" });
    await run("2026-08-01");
    const [s] = await testDb.select().from(schema.stipends);
    expect(s.lastOn).toBe("2026-08-01");
  });
});

describe("running it twice", () => {
  it("pays once", async () => {
    /*
     * The assertion this whole file exists for, and it is on the row count
     * rather than on what the second run reported: a pass that says it raised
     * nothing while having written a row is exactly the failure that would
     * reach somebody's bank account.
     */
    await stipend({ starts: "2026-08-01" });
    await run("2026-08-01");
    const second = await run("2026-08-01");
    expect(second.raised).toEqual([]);
    expect(await rows()).toHaveLength(1);
    expect(await reports()).toHaveLength(1);
  });

  it("pays once even when the second run is days later in the same month", async () => {
    await stipend({ starts: "2026-08-01" });
    await run("2026-08-01");
    await run("2026-08-14");
    await run("2026-08-31");
    expect(await rows()).toHaveLength(1);
  });

  it("pays again the following month, on a new claim", async () => {
    await stipend({ starts: "2026-08-01" });
    await run("2026-08-01");
    await run("2026-09-01");
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.incurredOn)).toEqual(["2026-08-01", "2026-09-01"]);
    // August's claim was submitted, so September's cannot be added to it.
    const rs = await reports();
    expect(rs.map((r) => r.title))
      .toEqual(["General perks - August 2026", "General perks - September 2026"]);
  });
});

describe("several stipends for one person", () => {
  it("puts them all on one claim, submitted once", async () => {
    /*
     * Otherwise an owner marks three reports paid every month for the same
     * person, which is worse than the filing the feature removed.
     */
    await stipend({ label: "Internet stipend", amount: 3500, starts: "2026-08-01" });
    await stipend({ label: "Phone allowance", amount: 2000, starts: "2026-08-01" });
    await stipend({ label: "Tool allowance", amount: 1500, starts: "2026-08-01" });
    const res = await run("2026-08-01");

    expect(res.raised).toHaveLength(3);
    const rs = await reports();
    expect(rs).toHaveLength(1);
    expect(rs[0].status).toBe("submitted");
    expect(res.submitted).toEqual([rs[0].id]);

    const all = await rows();
    expect(all).toHaveLength(3);
    expect(all.reduce((n, e) => n + e.amountCents, 0)).toBe(7000);
  });

  it("gives two different people two different claims", async () => {
    await stipend({ person: "Owen Brandt", starts: "2026-08-01" });
    await stipend({ person: "Tess Nakamura", starts: "2026-08-01" });
    await run("2026-08-01");
    const rs = await reports();
    expect(rs).toHaveLength(2);
    expect(rs.map((r) => r.person).sort()).toEqual(["Owen Brandt", "Tess Nakamura"]);
  });
});

describe("catching up after a stalled pass", () => {
  it("raises the months it missed, each on its own month's claim", async () => {
    // An engineer should not be out of pocket because a cron had a bad week.
    await stipend({ starts: "2026-06-01" });
    const res = await run("2026-08-10");
    expect(res.raised.map((r) => r.on)).toEqual(["2026-06-01", "2026-07-01", "2026-08-01"]);
    const rs = await reports();
    expect(rs.map((r) => r.title)).toEqual([
      "General perks - June 2026", "General perks - July 2026", "General perks - August 2026",
    ]);
    // Every one of them sent for payout, not just the last.
    expect(rs.every((r) => r.status === "submitted")).toBe(true);
  });

  it("is capped, so a start date typed as 2014 cannot raise a hundred rows", async () => {
    await stipend({ starts: "2014-01-01" });
    const res = await run("2026-08-10");
    expect(res.raised).toHaveLength(6);
    // And the next run continues rather than starting over.
    const next = await run("2026-08-11");
    expect(next.raised.map((r) => r.on)).toEqual([
      "2014-07-01", "2014-08-01", "2014-09-01", "2014-10-01", "2014-11-01", "2014-12-01",
    ]);
  });
});

describe("stopping and starting", () => {
  it("pays nothing while paused", async () => {
    await stipend({ starts: "2026-06-01", active: false });
    const res = await run("2026-08-10");
    expect(res.raised).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("does not back-pay the gap when it restarts", async () => {
    /*
     * "We stopped paying this for a while" means the months it was off are not
     * owed. The cursor did not move while it was paused, so this is the one
     * place where catching up would be wrong - and it is handled by the owner
     * setting last_on, which pausing leaves alone.
     */
    await stipend({ starts: "2026-06-01", active: false, last: "2026-07-01" });
    await client.exec(`UPDATE stipends SET active = true;`);
    const res = await run("2026-09-10");
    expect(res.raised.map((r) => r.on)).toEqual(["2026-08-01", "2026-09-01"]);
  });

  it("stops at the end date", async () => {
    await stipend({ starts: "2026-06-01", ends: "2026-07-01" });
    const res = await run("2026-12-01");
    expect(res.raised.map((r) => r.on)).toEqual(["2026-06-01", "2026-07-01"]);
  });

  it("counts a live arrangement with nothing due as quiet, not as a failure", async () => {
    // A run that raises nothing is the normal outcome and is a success.
    await stipend({ starts: "2026-08-01", last: "2026-08-01" });
    const res = await run("2026-08-14");
    expect(res).toMatchObject({ raised: [], failed: [], quiet: 1 });
  });
});

describe("two companies, one name", () => {
  it("keeps each shop's claim inside its own workspace", async () => {
    /*
     * Both companies employ an Owen Brandt. stipends and expense_reports are
     * single instance-wide tables and `person` is free text, so without the
     * tenant test in perksReportFor, Cascade's stipend would land on Sierra's
     * Owen's claim - and Sierra would be asked to pay it.
     */
    await stipend({ tenant: SIERRA, person: "Owen Brandt", amount: 3500, starts: "2026-08-01" });
    await stipend({ tenant: CASCADE, person: "Owen Brandt", amount: 9900, starts: "2026-08-01" });
    await run("2026-08-01");

    const rs = await reports();
    expect(rs).toHaveLength(2);
    expect(rs.map((r) => r.tenantOrgId).sort()).toEqual([SIERRA, CASCADE].sort());

    const sierra = rs.find((r) => r.tenantOrgId === SIERRA)!;
    const onSierra = (await rows()).filter((e) => e.reportId === sierra.id);
    expect(onSierra).toHaveLength(1);
    expect(onSierra[0].amountCents).toBe(3500);
    expect(onSierra[0].tenantOrgId).toBe(SIERRA);
  });
});

describe("the trail back to the arrangement", () => {
  it("stamps every row with the stipend that raised it", async () => {
    // Provenance, and the second belt on never-pay-twice: which arrangement
    // and which month a payment came from can be asked of the data.
    await stipend({ starts: "2026-08-01" });
    await run("2026-08-01");
    const [s] = await testDb.select().from(schema.stipends);
    const [e] = await rows();
    expect(e.stipendId).toBe(s.id);
  });
});
