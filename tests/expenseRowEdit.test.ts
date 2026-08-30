// Fixing a row that is already on a report.
//
// The desk could add a row and it could take one off, and between those two
// there was nothing - so a receipt photographed after the fact had nowhere to
// go, and an amount typed from memory in a car park could only be removed and
// retyped. editReportExpense is the missing middle, and everything interesting
// about it is what it must NOT let through:
//
//   * the same refusals a new row gets. A row cannot be edited into a shape it
//     could never have been created in - a zero, a future date, a nameless
//     claim, another company's job number off the wire.
//   * the same gate removeReportExpense puts on it: my report, still open. A
//     submitted claim's rows are fixed because somebody downstream is reading
//     them, and a paid one is history.
//   * the rulebook, asked AGAIN. Every fact its verdict rests on is editable
//     here, so a verdict carried over would be about a trip that no longer
//     exists - and an approval is spent by exactly the changes the rulebook
//     notices, and survives the ones it does not.
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

/* The router, pinned - same fixture as tests/perDiemClaim. Straight-line miles
   from each home to the lab, by latitude, so the distances under test live
   here rather than on somebody else's uptime. */
const MILES_FROM_HOME: Record<string, number> = {
  "45": 96, // Steve Jones, beyond the 80 mi radius
  "47": 22, // Pat Okafor, in town - inside it
  "46": 3,  // Dana Reyes, the owner, round the corner
};
vi.mock("@/lib/geo", async (orig) => ({
  ...(await orig<typeof import("@/lib/geo")>()),
  drivingMiles: async (from: { lat: number }) => ({
    miles: MILES_FROM_HOME[String(from.lat)] ?? 50,
    estimated: false,
  }),
}));

const ROOT = 1, SIERRA = 2, LABZEN = 3, CASCADE = 4;
const WO = 1, CASCADE_WO = 2;

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
      ('Lab Zen', 'client', false, 2),
      ('Cascade Instrument', 'provider', true, NULL);

    -- 80 mi radius, $30 lunch, $65 a night.
    INSERT INTO app_settings (id, operator_org_id, expense_policy) VALUES (1, ${ROOT},
      '{"radiusMiles":80,"dayPerDiemCents":3000,"overnightPerDiemCents":6500,
        "extendedAfterNights":3,"overnightExtendedCents":8500,"hotelNightCapCents":18000}');

    INSERT INTO house_members (email, org_id, role, name, can_admin_people, home_lat, home_lng) VALUES
      ('owner@sierra.test', ${SIERRA},  'owner', 'Dana Reyes',  false, 46.0, -122.0),
      ('hr@sierra.test',    ${SIERRA},  'staff', 'Pat Okafor',  true,  47.0, -122.0),
      ('tech@sierra.test',  ${SIERRA},  'staff', 'Steve Jones', false, 45.0, -122.0),
      ('tech@cascade.test', ${CASCADE}, 'staff', 'Ray Ng',      false, 45.0, -122.0);

    INSERT INTO expense_categories (tenant_org_id, name, sort_order) VALUES
      (${SIERRA}, 'Per diem', 1),
      (${SIERRA}, 'Parking',  2),
      (${SIERRA}, 'Lodging',  3);

    INSERT INTO org_sites (id, tenant_org_id, org_id, name, address, lat, lng) VALUES
      (1, ${SIERRA}, ${LABZEN}, 'Pier Road', '1 Pier Rd', 46.0, -122.0);

    INSERT INTO instruments (id, tenant_org_id, owner_org_id, external_id, client, model, site_id) VALUES
      (1, ${SIERRA}, ${LABZEN}, 'LCMS-8060-1', 'Lab Zen', 'LC-MS 8060', 1);

    INSERT INTO work_orders (id, tenant_org_id, org_id, instrument_id, number, title, state) VALUES
      (${WO},         ${SIERRA},  ${LABZEN}, 1,    'WO-1001', 'Pier Road commissioning', 'active'),
      (${CASCADE_WO}, ${CASCADE}, NULL,      NULL, 'WO-2001', 'Cascade rebuild',         'active');
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
const only = async () => (await rows())[0];

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

/** One ordinary receipt on an open claim: a parking stub, no rulebook in it. */
const logParking = async (reportId: number, over: Record<string, unknown> = {}) => {
  const { logMyExpense } = await import("@/app/actions");
  const res = await logMyExpense({
    kind: "Parking", description: "Parking, Pier Road", amount: "12.00",
    incurredOn: "2026-08-04", workOrderId: WO, reportId, siteId: 1, ...over,
  });
  if (res.error) throw new Error(res.error);
  return only();
};

/** The whole form, as the dialog sends it - overridden field by field. */
const FIELDS = {
  kind: "Parking", description: "Parking, Pier Road", amount: "12.00",
  incurredOn: "2026-08-04", workOrderId: WO as number | null,
};
const edit = async (id: number, over: Record<string, unknown> = {}) => {
  const { editReportExpense } = await import("@/app/actions");
  return editReportExpense(id, { ...FIELDS, ...over });
};

describe("fixing a row in place", () => {
  it("keeps the row and changes what was wrong with it", async () => {
    /*
     * The whole point: the SAME row, so the receipt already on it, the claim
     * it sits on and its place in the audit trail all survive. Remove-and-
     * retype threw all three away to fix a digit.
     */
    const id = await openReport();
    const before = await logParking(id, { receiptUrl: "https://blob/stub.jpg", receiptName: "stub.jpg" });
    expect((await edit(before.id, { amount: "88.67", description: "Various tools" })).error)
      .toBeUndefined();
    const after = await only();
    expect(after.id).toBe(before.id);
    expect(after.amountCents).toBe(8867);
    expect(after.description).toBe("Various tools");
    expect(after.reportId).toBe(id);
    // Untouched, because nothing said to touch it.
    expect(after.receiptUrl).toBe("https://blob/stub.jpg");
  });

  it("attaches the receipt that turned up later", async () => {
    // The gesture the whole change exists for: the claim went in without paper
    // because the paper was in a jacket.
    const id = await openReport();
    const row = await logParking(id);
    expect(row.receiptUrl).toBe("");
    await edit(row.id, { receiptUrl: "https://blob/late.jpg", receiptName: "late.jpg" });
    const after = await only();
    expect(after.receiptUrl).toBe("https://blob/late.jpg");
    expect(after.receiptName).toBe("late.jpg");
  });

  it("tells an unsaid receipt from one somebody removed", async () => {
    /*
     * Three answers, not two. An omitted field is "I did not touch the
     * receipt"; an empty string is somebody saying the paper does not belong
     * on this row - the wrong till slip, attached to the wrong claim.
     */
    const id = await openReport();
    const row = await logParking(id, { receiptUrl: "https://blob/stub.jpg", receiptName: "stub.jpg" });
    await edit(row.id, { description: "Still parking" });
    expect((await only()).receiptUrl).toBe("https://blob/stub.jpg");
    await edit(row.id, { receiptUrl: "", receiptName: "" });
    expect((await only()).receiptUrl).toBe("");
    expect((await only()).receiptName).toBe("");
  });

  it("moves a row off the job onto overhead, and stops rebilling it", async () => {
    // A toll on the drive home is not the client's. Nothing to rebill without
    // a job, which is the same rule a row is created under.
    const id = await openReport();
    const row = await logParking(id);
    expect(row.billable).toBe(true);
    await edit(row.id, { workOrderId: null });
    expect((await only()).workOrderId).toBeNull();
    expect((await only()).billable).toBe(false);
    await edit(row.id, { workOrderId: WO });
    expect((await only()).billable).toBe(true);
  });

  it("leaves the lab alone when the edit says nothing about it", async () => {
    // The site is which building the money was spent at, which a parking stub
    // has as much as a per diem does. Only the per diem form sends one.
    const id = await openReport();
    const row = await logParking(id);
    expect(row.siteId).toBe(1);
    await edit(row.id, { amount: "14.00" });
    expect((await only()).siteId).toBe(1);
  });
});

describe("what it refuses", () => {
  it("refuses everything a new row is refused, and changes nothing", async () => {
    const id = await openReport();
    const row = await logParking(id);
    expect((await edit(row.id, { amount: "0" })).error).toBeTruthy();
    expect((await edit(row.id, { amount: "not money" })).error).toBeTruthy();
    expect((await edit(row.id, { description: "   " })).error).toBeTruthy();
    expect((await edit(row.id, { incurredOn: "2099-01-01" })).error).toBeTruthy();
    expect((await edit(row.id, { incurredOn: "" })).error).toBeTruthy();
    const after = await only();
    expect(after.amountCents).toBe(1200);
    expect(after.description).toBe("Parking, Pier Road");
    expect(after.incurredOn).toBe("2026-08-04");
  });

  it("refuses the company next door's job, however the id got here", async () => {
    /*
     * The id came off the wire and requireStaff is true for every operator's
     * people. Without the tenant predicate the picker is the only thing
     * between this claim and another company's job number, and a picker is
     * not a rule.
     */
    const id = await openReport();
    const row = await logParking(id);
    expect((await edit(row.id, { workOrderId: CASCADE_WO })).error).toBeTruthy();
    expect((await only()).workOrderId).toBe(WO);
  });

  it("refuses a row on a submitted claim - somebody is already reading it", async () => {
    const { submitDraftReport } = await import("@/app/actions");
    const id = await openReport();
    const row = await logParking(id);
    await submitDraftReport(id);
    expect((await edit(row.id, { amount: "88.67" })).error).toContain("submitted");
    expect((await only()).amountCents).toBe(1200);
  });

  it("refuses a row on a paid claim", async () => {
    const { payExpenseReport, submitDraftReport } = await import("@/app/actions");
    const id = await openReport();
    const row = await logParking(id);
    await submitDraftReport(id);
    who = OWNER;
    await payExpenseReport(id, { paidOn: "2026-08-10", reference: "check 1044" });
    expect((await edit(row.id, { amount: "88.67" })).error).toContain("paid");
  });

  it("refuses a colleague's claim to an ordinary engineer", async () => {
    who = HR;
    const id = await openReport({ onBehalfOf: "Pat Okafor" });
    const row = await logParking(id);
    who = TECH;
    expect((await edit(row.id, { amount: "88.67" })).error).toBeTruthy();
    expect((await only()).amountCents).toBe(1200);
  });

  it("lets HR fix a colleague's, which is what filling their claim means", async () => {
    who = TECH;
    const id = await openReport();
    const row = await logParking(id);
    who = HR;
    expect((await edit(row.id, { amount: "88.67" })).error).toBeUndefined();
    expect((await only()).amountCents).toBe(8867);
  });

  it("refuses a receipt that is not on a report at all", async () => {
    // A loose row in the pool is edited where it lives, not through the claim
    // that does not have it.
    const { logMyExpense } = await import("@/app/actions");
    await logMyExpense({
      kind: "Parking", description: "Loose stub", amount: "12.00",
      incurredOn: "2026-08-04", workOrderId: null,
    });
    expect((await edit((await only()).id)).error).toBeTruthy();
  });
});

describe("the rulebook is asked again", () => {
  const logPerDiem = async (reportId: number, over: Record<string, unknown> = {}) => {
    const { logMyExpense } = await import("@/app/actions");
    const res = await logMyExpense({
      kind: "Per diem", description: "Lunch", amount: "30.00",
      incurredOn: "2026-08-04", workOrderId: WO, reportId, nights: 0, siteId: 1, ...over,
    });
    if (res.error) throw new Error(res.error);
    return only();
  };
  const PER_DIEM = {
    kind: "Per diem", description: "Lunch", amount: "30.00",
    incurredOn: "2026-08-04", workOrderId: WO, nights: 0, siteId: 1,
  };
  const editPerDiem = async (id: number, over: Record<string, unknown> = {}) => {
    const { editReportExpense } = await import("@/app/actions");
    return editReportExpense(id, { ...PER_DIEM, ...over });
  };

  it("flags a clean row that is edited up over the allowance", async () => {
    // Steve is 96 mi out, so $30 sails through - and a $52 airport lunch typed
    // in afterwards must not inherit that silence.
    const id = await openReport();
    const row = await logPerDiem(id);
    expect(row.allowanceState).toBe("");
    await editPerDiem(row.id, { amount: "52.00" });
    const after = await only();
    expect(after.allowanceState).toBe("flagged");
    expect(after.allowanceNote).toContain("$52");
  });

  it("clears a flag when the row is corrected back down to the allowance", async () => {
    // The flag is a verdict on the current row, not a mark on its history.
    const id = await openReport();
    const row = await logPerDiem(id, { amount: "52.00" });
    expect(row.allowanceState).toBe("flagged");
    await editPerDiem(row.id, { amount: "30.00" });
    expect((await only()).allowanceState).toBe("");
  });

  it("re-prices the trip when the nights change", async () => {
    who = HR;
    const id = await openReport();
    // Pat is 22 mi out: a day trip is inside the radius, so the lunch waits
    // for a signature. A night away is priced by the night instead.
    const row = await logPerDiem(id);
    expect(row.allowanceState).toBe("flagged");
    await editPerDiem(row.id, { amount: "65.00", nights: 1 });
    const after = await only();
    expect(after.allowanceState).toBe("");
    expect(after.allowanceNights).toBe(1);
  });

  it("keeps an approval through a fix the rulebook does not notice", async () => {
    /*
     * The asymmetry that makes the approval worth anything. A typo in the
     * description is not a different claim, and spending a reviewer's
     * signature on one would train everybody to stop fixing typos.
     */
    const { approveExpenseAllowance } = await import("@/app/actions");
    who = HR;
    const id = await openReport();
    const row = await logPerDiem(id);
    who = OWNER;
    await approveExpenseAllowance(row.id);
    expect((await only()).allowanceState).toBe("approved");

    who = HR;
    expect((await editPerDiem(row.id, { description: "Lunch, Pier Road" })).error).toBeUndefined();
    const after = await only();
    expect(after.description).toBe("Lunch, Pier Road");
    expect(after.allowanceState).toBe("approved");
    expect(after.allowanceBy).toBe("owner@sierra.test");
  });

  it("spends an approval the moment the price changes", async () => {
    // Somebody signed for a $30 lunch. This is a $52 one.
    const { approveExpenseAllowance } = await import("@/app/actions");
    who = HR;
    const id = await openReport();
    const row = await logPerDiem(id);
    who = OWNER;
    await approveExpenseAllowance(row.id);

    who = HR;
    await editPerDiem(row.id, { amount: "52.00" });
    const after = await only();
    expect(after.allowanceState).toBe("flagged");
    expect(after.allowanceBy).toBe("");
    expect(after.allowanceAt).toBeNull();
  });

  it("keeps the payout gate shut behind an edit that re-flags a row", async () => {
    /*
     * The end-to-end version of the same fear: if the re-ruling only changed a
     * colour, "approve it, then edit it up" would be the documented way round
     * the reviewer.
     */
    const { approveExpenseAllowance, payExpenseReport, submitDraftReport } = await import("@/app/actions");
    who = HR;
    const id = await openReport();
    const row = await logPerDiem(id);
    who = OWNER;
    await approveExpenseAllowance(row.id);
    who = HR;
    await editPerDiem(row.id, { amount: "52.00" });
    await submitDraftReport(id);
    who = OWNER;
    expect((await payExpenseReport(id, { paidOn: "2026-08-10", reference: "check 1044" })).error)
      .toContain("not been approved");
  });
});
