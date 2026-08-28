// A per diem going onto a claim, end to end - and the gate it puts on the money.
//
// lib/expensePolicy holds the rule and tests/perDiem holds the rule's edges.
// This is about the wiring, where the interesting failures are not arithmetic:
//
//   * the verdict is the SERVER's. A browser that posts a clean state on a
//     claim inside the radius must still end up flagged, or the whole feature
//     is a colour on a screen.
//   * the distance is measured from the CLAIMANT's doorstep, not the filer's.
//     When HR fills a claim for an engineer who lives the other side of town,
//     measuring from HR's home prices the wrong trip.
//   * a flagged row stops the payout until a person signs for it, and that
//     person cannot be the claimant.
//   * moving the claim onto a different job re-judges it - otherwise the flag
//     is escapable by re-pointing the report afterwards.
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
 * The router, pinned. A test that reached OSRM would be slow, flaky and
 * measuring somebody else's uptime - and the distances are the input under
 * test, so they belong in the fixture. Straight-line from each home to each
 * lab, in miles, by coordinate.
 */
const MILES_FROM_HOME: Record<string, number> = {
  "45": 96, // Steve Jones, an hour and a half out - beyond the 80 mi radius
  "47": 22, // Pat Okafor, in town - inside it
  "46": 3,  // Dana Reyes, the owner, round the corner from the lab
};
vi.mock("@/lib/geo", async (orig) => ({
  ...(await orig<typeof import("@/lib/geo")>()),
  drivingMiles: async (from: { lat: number }) => ({
    miles: MILES_FROM_HOME[String(from.lat)] ?? 50,
    estimated: false,
  }),
}));

const ROOT = 1, SIERRA = 2, LABZEN = 3;
const WO = 1, WO_NO_SYS = 2, WO_NOSITE = 3;

const TECH: Who = {
  email: "tech@sierra.test", name: "Steve Jones", role: "staff",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: ROOT,
};
const HR: Who = {
  email: "hr@sierra.test", name: "Pat Okafor", role: "staff",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: ROOT,
};
const OWNER: Who = {
  email: "owner@sierra.test", name: "Dana Reyes", role: "owner",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: ROOT,
};

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (name, kind, is_operator, parent_org_id) VALUES
      ('Ridgeline', 'provider', true, NULL),
      ('Sierra Spectra', 'provider', true, NULL),
      ('Lab Zen', 'client', false, 2);

    -- The owner's rulebook: 80 mi radius, $30 lunch, $65 a night.
    INSERT INTO app_settings (id, operator_org_id, expense_policy) VALUES (1, ${ROOT},
      '{"radiusMiles":80,"dayPerDiemCents":3000,"overnightPerDiemCents":6500,
        "extendedAfterNights":3,"overnightExtendedCents":8500,"hotelNightCapCents":18000}');

    -- Steve lives an hour and a half out; Pat lives in town. The lab is at 46.
    INSERT INTO house_members (email, org_id, role, name, can_admin_people, home_lat, home_lng) VALUES
      ('owner@sierra.test', ${SIERRA}, 'owner', 'Dana Reyes',  false, 46.0, -122.0),
      ('hr@sierra.test',    ${SIERRA}, 'staff', 'Pat Okafor',  true,  47.0, -122.0),
      ('tech@sierra.test',  ${SIERRA}, 'staff', 'Steve Jones', false, 45.0, -122.0);

    -- The workspace's own category vocabulary. Without it logMyExpense's
    -- cleanKind collapses an unknown name to "other", and a per diem filed
    -- against a category this shop does not have is not a per diem.
    INSERT INTO expense_categories (tenant_org_id, name, sort_order) VALUES
      (${SIERRA}, 'Per diem', 1),
      (${SIERRA}, 'Parking',  2),
      (${SIERRA}, 'Lodging',  3);

    INSERT INTO org_sites (id, tenant_org_id, org_id, name, address, lat, lng) VALUES
      (1, ${SIERRA}, ${LABZEN}, 'Pier Road', '1 Pier Rd', 46.0, -122.0);

    INSERT INTO instruments (id, tenant_org_id, owner_org_id, external_id, client, model, site_id) VALUES
      (1, ${SIERRA}, ${LABZEN}, 'LCMS-8060-1', 'Lab Zen', 'LC-MS 8060', 1);

    -- WO_NOSITE is the shop's own job - no client, so no lab, so no distance.
    -- That is the honest "cannot measure" case; a job at a client that HAS a
    -- lab always resolves to one, even with no system named (see below).
    INSERT INTO work_orders (id, tenant_org_id, org_id, instrument_id, number, title, state) VALUES
      (${WO},         ${SIERRA}, ${LABZEN}, 1,    'WO-1001', 'Pier Road commissioning', 'active'),
      (${WO_NO_SYS},  ${SIERRA}, ${LABZEN}, NULL, 'WO-1002', 'Site survey, no system',  'active'),
      (${WO_NOSITE},  ${SIERRA}, NULL,      NULL, 'WO-1003', 'Van service, ours',       'active');
  `);
});

beforeEach(async () => {
  who = TECH;
  await client.exec(`DELETE FROM expenses; DELETE FROM expense_reports;`);
});

const rows = async () => {
  const { expenses } = schema;
  const { asc } = await import("drizzle-orm");
  return testDb.select().from(expenses).orderBy(asc(schema.expenses.id));
};

/** A named, job-bearing claim - what the create form now always produces. */
const openReport = async (over: { onBehalfOf?: string; workOrderId?: number | null } = {}) => {
  const { createExpenseReport } = await import("@/app/actions");
  const res = await createExpenseReport({
    title: "Pier Road, week of the 8th",
    workOrderId: over.workOrderId === undefined ? WO : over.workOrderId,
    onBehalfOf: over.onBehalfOf,
  });
  if (res.error) throw new Error(res.error);
  return res.id!;
};

const logPerDiem = async (reportId: number, over: {
  amount?: string; nights?: number; kind?: string; siteId?: number | null;
} = {}) => {
  const { logMyExpense } = await import("@/app/actions");
  return logMyExpense({
    kind: over.kind ?? "Per diem", description: "Lunch", amount: over.amount ?? "30.00",
    incurredOn: "2026-08-04", workOrderId: WO, reportId,
    nights: over.nights ?? 0, siteId: over.siteId === undefined ? 1 : over.siteId,
  });
};

describe("the verdict is the server's", () => {
  it("waves through a lunch beyond the radius", async () => {
    // Steve is 96 mi out. Nothing to approve, and the record still says why.
    const id = await openReport();
    expect((await logPerDiem(id)).error).toBeUndefined();
    const [row] = await rows();
    expect(row.allowanceState).toBe("");
    expect(row.allowanceNote).toContain("$30 allowed");
  });

  it("flags the same lunch when the claimant lives round the corner", async () => {
    /*
     * Pat is 22 mi from the lab, inside the 80 mi radius - the car stipend
     * already covers meals on a trip that short. The claim is still allowed to
     * exist, at the shop's own rate, and it waits for a signature.
     */
    who = HR;
    const id = await openReport();
    expect((await logPerDiem(id)).error).toBeUndefined();
    const [row] = await rows();
    expect(row.allowanceState).toBe("flagged");
    expect(row.allowanceNote).toContain("inside the 80 mi radius");
    expect(row.amountCents).toBe(3000);
  });

  it("flags an amount over the allowance and keeps the amount", async () => {
    // A $52 airport lunch on a $30 day. Not refused - the row carries what was
    // actually spent, and a reviewer decides.
    const id = await openReport();
    await logPerDiem(id, { amount: "52.00" });
    const [row] = await rows();
    expect(row.allowanceState).toBe("flagged");
    expect(row.amountCents).toBe(5200);
    expect(row.allowanceNote).toContain("$52");
  });

  it("measures from the CLAIMANT's home, not the filer's", async () => {
    /*
     * The office manager files for the engineer. Pat is 22 mi out and Steve is
     * 96; measuring from the person typing would flag an honest claim and,
     * with the homes swapped, would wave through one that should be queried.
     */
    who = HR;
    const id = await openReport({ onBehalfOf: "Steve Jones" });
    await logPerDiem(id);
    const [row] = await rows();
    expect(row.person).toBe("Steve Jones");
    expect(row.allowanceState).toBe("");
    expect(row.allowanceNote).toContain("$30 allowed");
  });

  it("prices a stay by its nights, however close the lab is", async () => {
    // Nobody books a room within commuting range of their own bed by choice.
    who = HR;
    const id = await openReport();
    await logPerDiem(id, { amount: "65.00", nights: 1 });
    const [row] = await rows();
    expect(row.allowanceState).toBe("");
    expect(row.allowanceNights).toBe(1);
  });

  it("says nothing about a receipt that is not a per diem", async () => {
    const id = await openReport();
    await logPerDiem(id, { kind: "Parking", amount: "400.00" });
    const [row] = await rows();
    expect(row.allowanceState).toBe("");
    expect(row.allowanceNote).toBe("");
  });

  it("flags a claim it cannot measure rather than guessing", async () => {
    // The shop's own van service: no client, so no lab, so no distance. The
    // honest answer is that a person has to look - not a guessed zero, which
    // would read as "next door" and flag it for the wrong reason.
    const id = await openReport({ workOrderId: WO_NOSITE });
    await logPerDiem(id, { siteId: null });
    const [row] = await rows();
    expect(row.allowanceState).toBe("flagged");
    expect(row.allowanceNote).toContain("distance from home could not be worked out");
  });

  it("finds the client's only lab even when the job names no system", async () => {
    /*
     * A site survey has no instrument to inherit a building from. Falling back
     * to the client's sites is what keeps the common case working - one
     * client, one lab, and nobody should be asked to pick from a list of one.
     */
    const id = await openReport({ workOrderId: WO_NO_SYS });
    await logPerDiem(id, { siteId: null });
    const [row] = await rows();
    expect(row.allowanceState).toBe("");
    expect(row.allowanceNote).toContain("$30 allowed");
    expect(row.siteId).toBe(1);
  });
});

describe("the gate on the money", () => {
  const submit = async (id: number) => {
    const { submitDraftReport } = await import("@/app/actions");
    const res = await submitDraftReport(id);
    if (res.error) throw new Error(res.error);
  };
  const pay = async (id: number) => {
    const { payExpenseReport } = await import("@/app/actions");
    return payExpenseReport(id, { paidOn: "2026-08-10", reference: "check 1044" });
  };

  it("refuses to pay a report with an unapproved row", async () => {
    who = HR;
    const id = await openReport();
    await logPerDiem(id);
    await submit(id);
    who = OWNER;
    expect((await pay(id)).error).toContain("not been approved");
  });

  it("pays it once a reviewer has signed", async () => {
    const { approveExpenseAllowance } = await import("@/app/actions");
    who = HR;
    const id = await openReport();
    await logPerDiem(id);
    await submit(id);
    who = OWNER;
    expect((await approveExpenseAllowance((await rows())[0].id)).error).toBeUndefined();
    expect((await pay(id)).error).toBeUndefined();
    const [row] = await rows();
    expect(row.allowanceState).toBe("approved");
    expect(row.allowanceBy).toBe("owner@sierra.test");
  });

  it("pays a clean report without anybody signing anything", async () => {
    // The ordinary case stays ordinary: a lunch beyond the radius is not an
    // event, and adding a reviewer to it would make the feature a tax.
    const id = await openReport();
    await logPerDiem(id);
    await submit(id);
    who = OWNER;
    expect((await pay(id)).error).toBeUndefined();
  });
});

describe("who may sign", () => {
  it("not the engineer whose claim it is", async () => {
    // An approval you can grant yourself is not an approval.
    const { approveExpenseAllowance } = await import("@/app/actions");
    who = HR;
    const id = await openReport({ onBehalfOf: "Steve Jones" });
    // Steve is 96 mi out, so force the flag another way: over the allowance.
    await logPerDiem(id, { amount: "52.00" });
    who = TECH;
    expect((await approveExpenseAllowance((await rows())[0].id)).error).toBeTruthy();
  });

  it("not an ordinary engineer on anybody's claim", async () => {
    const { approveExpenseAllowance } = await import("@/app/actions");
    who = HR;
    const id = await openReport();
    await logPerDiem(id);
    who = TECH;
    expect((await approveExpenseAllowance((await rows())[0].id)).error)
      .toContain("Only HR or the owner");
  });

  it("HR, on somebody else's", async () => {
    const { approveExpenseAllowance } = await import("@/app/actions");
    who = TECH;
    const id = await openReport();
    await logPerDiem(id, { amount: "52.00" });
    who = HR;
    expect((await approveExpenseAllowance((await rows())[0].id)).error).toBeUndefined();
  });

  it("HR may not sign their own, but the owner may sign theirs", async () => {
    /*
     * The deliberate asymmetry. There is somebody above HR; there is nobody
     * above the owner, and refusing would leave their own flagged row
     * permanently unpayable. The audit line records that they cleared it.
     */
    const { approveExpenseAllowance } = await import("@/app/actions");
    who = HR;
    const hrReport = await openReport();
    await logPerDiem(hrReport);
    expect((await approveExpenseAllowance((await rows())[0].id)).error).toContain("ask the owner");

    who = OWNER;
    const ownReport = await openReport();
    await logPerDiem(ownReport, { amount: "52.00" });
    const own = (await rows()).find((r) => r.person === "Dana Reyes")!;
    expect((await approveExpenseAllowance(own.id)).error).toBeUndefined();
  });
});

describe("the facts under a verdict can move", () => {
  it("re-judges every per diem when the claim moves onto another job", async () => {
    /*
     * Otherwise the flag is escapable: log the lunch against the close job,
     * then re-point the report at a distant one and the query disappears with
     * nobody looking. Both directions are checked here.
     */
    const { setReportWorkOrder } = await import("@/app/actions");
    who = HR;
    const id = await openReport();
    await logPerDiem(id);
    expect((await rows())[0].allowanceState).toBe("flagged");

    // Onto the shop's own job, which has no lab: still a flag, for a different
    // reason, and the note now says the new one.
    expect((await setReportWorkOrder(id, WO_NOSITE)).error).toBeUndefined();
    expect((await rows())[0].allowanceNote).toContain("distance from home could not be worked out");
  });

  it("spends an approval when the trip it was given for changes", async () => {
    // Somebody signed for a specific trip. The trip changed, so the signature
    // is spent and a reviewer looks again.
    const { approveExpenseAllowance, setReportWorkOrder } = await import("@/app/actions");
    who = HR;
    const id = await openReport();
    await logPerDiem(id);
    who = OWNER;
    await approveExpenseAllowance((await rows())[0].id);
    expect((await rows())[0].allowanceState).toBe("approved");

    await setReportWorkOrder(id, WO_NOSITE);
    const [row] = await rows();
    expect(row.allowanceState).toBe("flagged");
    expect(row.allowanceBy).toBe("");
  });

  it("judges a per diem pulled in from the pool - the pool is not a way round", async () => {
    /*
     * A receipt logged loose has no job to be judged against. Landing on a
     * claim that names one is the first moment the rulebook can speak, and
     * skipping it there would make "log it to the pool, then attach it" the
     * documented bypass.
     */
    const { attachPoolExpenses, logMyExpense } = await import("@/app/actions");
    who = HR;
    await logMyExpense({
      kind: "Per diem", description: "Lunch", amount: "30.00",
      incurredOn: "2026-08-04", workOrderId: null,
    });
    const loose = (await rows())[0];
    expect(loose.allowanceState).toBe("");

    const id = await openReport();
    expect((await attachPoolExpenses(id, [loose.id])).error).toBeUndefined();
    expect((await rows())[0].allowanceState).toBe("flagged");
  });

  it("drops the verdict when a row goes back to the pool", async () => {
    // The verdict was about this row on THIS claim against THIS job. A loose
    // receipt has none of those, and a stale flag would follow it onto the
    // next claim asking somebody to approve a trip nobody has described.
    const { removeReportExpense } = await import("@/app/actions");
    who = HR;
    const id = await openReport();
    await logPerDiem(id);
    expect((await removeReportExpense((await rows())[0].id)).error).toBeUndefined();
    const [row] = await rows();
    expect(row.allowanceState).toBe("");
    expect(row.allowanceNote).toBe("");
  });
});
