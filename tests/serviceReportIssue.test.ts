// Issuing the service report for a finished visit.
//
// The document a client signs, so what is pinned here is what cannot be
// allowed to drift: that it is numbered in the job's own thread (030182_SR1,
// then _SR2), that it is FROZEN at issue rather than re-rendered from rows
// that keep moving, that it refuses to be written about work nobody has
// finished or described, and that its money agrees with the invoice the same
// job would raise - every line at its price, the covered ones taken off at the
// bottom, nothing due.
//
// Real Postgres, in-process, from the same DDL every deploy applies.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");
const { eq } = await import("drizzle-orm");

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

const SIERRA = 1, EMERY = 2, CASCADE = 3;
const SLOW = 30_000;

const OWNER: Who = {
  email: "joe@sierra.test", name: "Joe Harris", role: "owner",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: SIERRA,
};

/** The shop's own numbering: the job is 030182 and its paper hangs off it. */
const SCHEME = JSON.stringify({
  templates: {
    work_order: "{job:6}", quote: "Q{job:6}_{alpha}",
    invoice: "{job:6}_INV{seq}", purchase_order: "{job:6}_PO{seq}",
    service_report: "{job:6}_SR{seq}",
  },
  jobStart: 30120,
});

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator, parent_org_id, doc_scheme, billing_address) VALUES
      (${SIERRA}, 'Sierra Spectra', 'provider', true,  NULL, '${SCHEME}',
       '6770 Stanford Ranch Rd.\nSuite #1220\nRoseville, CA 95678'),
      (${EMERY},  'Emery Pharma',   'client',   false, ${SIERRA}, '',
       '1000 Atlantic Ave.,\nSuite #110\nAlameda, CA 94501'),
      (${CASCADE}, 'Cascade Instrument', 'provider', true, NULL, '', '');
    INSERT INTO app_settings (id, operator_org_id) VALUES (1, ${SIERRA});
    INSERT INTO house_members (email, org_id, role, name) VALUES
      ('joe@sierra.test', ${SIERRA}, 'owner', 'Joe Harris');

    INSERT INTO org_sites (id, tenant_org_id, org_id, name, address) VALUES
      (1, ${SIERRA}, ${EMERY}, 'Alameda', '1000 Atlantic Ave.,\nSuite #110\nAlameda, CA 94501');

    INSERT INTO instruments (id, tenant_org_id, external_id, client, manufacturer, name, model, serial,
                             owner_org_id, site_id) VALUES
      (1, ${SIERRA}, 'EQ-227', 'Emery Pharma', 'Thermo', 'UPLC', 'Vanquish Flex', '8339399', ${EMERY}, 1);

    -- Four visits a year and a $16,000 parts allowance, none of it spent yet.
    INSERT INTO agreements (id, tenant_org_id, org_id, number, kind, status, starts_on, ends_on,
                            visits_included, parts_allowance_cents) VALUES
      (1, ${SIERRA}, ${EMERY}, '030182_Ar2', 'contract', 'active', '2026-01-01', '2026-12-31', 4, 1600000);

    INSERT INTO rate_cards (id, tenant_org_id, org_id, hourly_cents, travel_pct, min_increment_min) VALUES
      (1, ${SIERRA}, ${EMERY}, 50000, 80, 60);
  `);
});

/** A job as the engineer leaves it: resolved, with a close-out written on it. */
async function seedJob(over: { state?: string; closeSummary?: string } = {}) {
  await client.exec(`
    DELETE FROM service_reports; DELETE FROM parts; DELETE FROM time_entries; DELETE FROM work_orders;
    INSERT INTO work_orders (id, tenant_org_id, number, instrument_id, org_id, requested_by, title, body,
                             severity, state, assignee, opened_on, close_summary, closed_by, resolved_at) VALUES
      (1, ${SIERRA}, '030182', 1, ${EMERY}, 'Prajita Pandey', 'Repair on Pump B',
       'Customer states Pump B not working.', 'Down', '${over.state ?? "resolved"}', 'Joe Harris',
       '2026-09-10', '${over.closeSummary ?? "Removed Pump Head B\\n- Broken sapphire plunger\\nALL OK"}',
       '', '2026-09-14T12:00:00Z');

    INSERT INTO parts (id, instrument_id, work_order_id, name, part_number, qty,
                       cost_cents, status, owner_org_id, installed_at) VALUES
      (1, 1, 1, 'Pump Head - Certified Working', '6044.5201', '1', 225000, 'Installed', ${EMERY}, '2026-09-14'),
      (2, 1, 1, 'Sapphire Piston 2ct',           '6040.0042', '1',  48300, 'Installed', ${EMERY}, '2026-09-14');

    INSERT INTO time_entries (tenant_org_id, instrument_id, work_order_id, person, date, minutes, category, billable) VALUES
      (${SIERRA}, 1, 1, 'Joe Harris', '2026-09-14', 240, 'onsite', true),
      (${SIERRA}, 1, 1, 'Joe Harris', '2026-09-14', 120, 'travel', true);
  `);
}

beforeEach(async () => {
  who = OWNER;
  await seedJob();
  await client.exec(`DELETE FROM audit_log;`);
});

describe("issuing a report", () => {
  it("numbers it in the job's own thread, and the next one after it", async () => {
    const { issueServiceReport } = await import("@/app/actions");

    const first = await issueServiceReport(1);
    expect(first.error).toBeUndefined();

    // A second visit, a second report. Without new work on the job there is
    // nothing for a second one to be about - see "what it refuses" below.
    await client.exec(`
      INSERT INTO time_entries (tenant_org_id, instrument_id, work_order_id, person, date, minutes, category, billable)
      VALUES (${SIERRA}, 1, 1, 'Joe Harris', '2026-09-21', 90, 'onsite', true);
    `);
    const second = await issueServiceReport(1);
    expect(second.error).toBeUndefined();

    const rows = await testDb.select().from(schema.serviceReports).orderBy(schema.serviceReports.id);
    expect(rows.map((r) => r.number)).toEqual(["030182_SR1", "030182_SR2"]);
    expect(rows[0].workOrderId).toBe(1);
    expect(rows[0].orgId).toBe(EMERY);
    expect(rows[0].tenantOrgId).toBe(SIERRA);
    expect(rows[0].issuedBy).toBe("joe@sierra.test");
  }, SLOW);

  it("writes the visit down, in the words the original uses", async () => {
    const { issueServiceReport } = await import("@/app/actions");
    const { reportTotals } = await import("@/lib/serviceReport");
    await issueServiceReport(1);

    const [row] = await testDb.select().from(schema.serviceReports);
    const r = row.data as import("@/lib/serviceReport").ServiceReport;

    expect(r.reportNumber).toBe("030182_SR1");
    expect(r.serviceType).toBe("Repair");
    expect(r.engineer).toBe("Joe Harris");
    expect(r.visitDate).toBe("Monday, September 14, 2026");
    expect(r.customer.name).toBe("Emery Pharma");
    expect(r.customer.lines).toEqual(["1000 Atlantic Ave.,", "Suite #110", "Alameda, CA 94501"]);
    expect(r.provider.name).toBe("Sierra Spectra");
    expect(r.instrument).toMatchObject({ type: "Thermo UPLC", model: "Vanquish Flex", serial: "8339399" });
    expect(r.workCompleted).toBe("Repair on Pump B");
    expect(r.request).toMatchObject({ date: "2026-09-10", from: "Prajita Pandey" });
    expect(r.notes.body).toContain("Broken sapphire plunger");
    // The PO a client pays against: no purchase order on file, so the paper
    // that IS the authority to work - their agreement.
    expect(r.poNumber).toBe("030182_Ar2");

    // The parts fitted, by their own numbers, and the hours as one line each.
    expect(r.parts.map((l) => l.partNumber)).toEqual(["6044.5201", "6040.0042"]);
    expect(r.labor.map((l) => l.description)).toEqual([
      "Labor, on site - Joe Harris", "Travel - Joe Harris",
    ]);

    // A contract visit: everything priced, everything absorbed, nothing due.
    // The prices themselves are the markup's business (lib/billing.sellPrice),
    // so what is pinned here is that they are real and that they cancel.
    const t = reportTotals(r);
    expect(t.parts).toBeGreaterThan(273_300);   // the parts cost, plus markup
    expect(t.labor).toBeGreaterThan(0);
    expect(t.adjustment).toBe(-t.sub);
    expect(t.due).toBe(0);
  }, SLOW);

  it("shows the hours worked whether or not anybody is charging for them", async () => {
    // The visit Ridgeline logged for UCSF: four hours driving and one on the
    // bench, both unticked because the contract covers them. A report that
    // dropped them said an engineer spent no time on a day he spent five
    // hours on.
    await client.exec(`UPDATE time_entries SET billable = false WHERE work_order_id = 1;`);
    const { issueServiceReport } = await import("@/app/actions");
    const { reportTotals } = await import("@/lib/serviceReport");
    await issueServiceReport(1);

    const [row] = await testDb.select().from(schema.serviceReports);
    const r = row.data as import("@/lib/serviceReport").ServiceReport;
    expect(r.labor).toEqual([
      { description: "Labor, on site - Joe Harris - covered by 030182_Ar2", partNumber: "", quantity: 4, unitCents: 0, taxExempt: true },
      { description: "Travel - Joe Harris - covered by 030182_Ar2", partNumber: "", quantity: 2, unitCents: 0, taxExempt: true },
    ]);
    // Nothing at nothing is still nothing: the totals are the parts alone.
    const t = reportTotals(r);
    expect(t.labor).toBe(0);
    expect(t.parts).toBeGreaterThan(0);
    expect(t.due).toBe(0);
  }, SLOW);

  it("counts the visit it is about, whether or not the job is closed yet", async () => {
    const { issueServiceReport } = await import("@/app/actions");
    await issueServiceReport(1);
    const [resolved] = await testDb.select().from(schema.serviceReports);
    const a = resolved.data as import("@/lib/serviceReport").ServiceReport;
    // Four included, this one spent: the first visit, three left.
    expect(a.visitNumber).toBe("01");
    expect(a.balances.visitsRemaining).toBe("03");
    // $16,000 less the parts this visit drew.
    expect(a.balances.partsRemaining).toBe("$13,267.00");

    await client.exec(`
      UPDATE work_orders SET state = 'closed', closed_at = '2026-09-15T12:00:00Z' WHERE id = 1;
      INSERT INTO time_entries (tenant_org_id, instrument_id, work_order_id, person, date, minutes, category, billable)
      VALUES (${SIERRA}, 1, 1, 'Joe Harris', '2026-09-15', 60, 'onsite', true);
    `);
    await issueServiceReport(1);
    const rows = await testDb.select().from(schema.serviceReports).orderBy(schema.serviceReports.id);
    const b = rows[1].data as import("@/lib/serviceReport").ServiceReport;
    // The drawdown counts it now, so the report must not count it twice.
    expect(b.visitNumber).toBe("01");
    expect(b.balances.visitsRemaining).toBe("03");
  }, SLOW);

  it("stays as it was signed when the rows behind it move", async () => {
    const { issueServiceReport } = await import("@/app/actions");
    await issueServiceReport(1);
    const [before] = await testDb.select().from(schema.serviceReports);
    const was = (before.data as import("@/lib/serviceReport").ServiceReport).parts[0].unitCents;

    await client.exec(`UPDATE parts SET cost_cents = 999999 WHERE id = 1; UPDATE work_orders SET title = 'Something else' WHERE id = 1;`);

    const [row] = await testDb.select().from(schema.serviceReports);
    const r = row.data as import("@/lib/serviceReport").ServiceReport;
    expect(r.workCompleted).toBe("Repair on Pump B");
    expect(r.parts[0].unitCents).toBe(was);
  }, SLOW);

  it("draws the PDF it says it will", async () => {
    const { issueServiceReport } = await import("@/app/actions");
    const { buildServiceReport } = await import("@/lib/serviceReport");
    const { PDFDocument } = await import("pdf-lib");
    await issueServiceReport(1);
    const [row] = await testDb.select().from(schema.serviceReports);
    const bytes = await buildServiceReport(row.data as import("@/lib/serviceReport").ServiceReport);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(pdf.getTitle()).toBe("Service Report 030182_SR1");
  }, SLOW);

  it("says so in the log", async () => {
    const { issueServiceReport } = await import("@/app/actions");
    await issueServiceReport(1);
    const [entry] = await testDb.select().from(schema.auditLog);
    expect(entry.entityType).toBe("service_report");
    expect(entry.action).toContain("issued 030182_SR1 for 030182");
    expect(entry.tenantOrgId).toBe(SIERRA);
  }, SLOW);
});

describe("whose address the footer carries", () => {
  it("is the service company's own, not the platform's support desk", async () => {
    const { issueServiceReport, setOrgContactEmail, reissueServiceReport } = await import("@/app/actions");
    await client.exec(`UPDATE app_settings SET public_contact_email = 'support@ridgelinefield.com' WHERE id = 1;`);
    await issueServiceReport(1);
    const [first] = await testDb.select().from(schema.serviceReports);
    // Nothing set, so the instance's own address stands in - right for a
    // one-company instance, wrong the moment the platform is somebody else.
    expect((first.data as import("@/lib/serviceReport").ServiceReport).contact)
      .toBe("Sierra Spectra | support@ridgelinefield.com");

    expect((await setOrgContactEmail(SIERRA, " service@sierraspectra.com ")).error).toBeUndefined();
    await reissueServiceReport(first.id);

    const [row] = await testDb.select().from(schema.serviceReports);
    expect((row.data as import("@/lib/serviceReport").ServiceReport).contact)
      .toBe("Sierra Spectra | service@sierraspectra.com");
    await client.exec(`UPDATE orgs SET contact_email = '' WHERE id = ${SIERRA};`);
  }, SLOW);

  it("refuses something that is not an address, and takes a blank as clearing it", async () => {
    const { setOrgContactEmail } = await import("@/app/actions");
    expect((await setOrgContactEmail(SIERRA, "service.sierraspectra.com")).error)
      .toMatch(/does not look like an email/);
    expect((await setOrgContactEmail(SIERRA, "service@sierraspectra.com")).error).toBeUndefined();
    expect((await setOrgContactEmail(SIERRA, "")).error).toBeUndefined();
    const [org] = await testDb.select().from(schema.orgs).where(eq(schema.orgs.id, SIERRA));
    expect(org.contactEmail).toBe("");
  }, SLOW);
});

describe("what the client's page leaves out", () => {
  it("shows no expense claim of the engineer's, billable or not", async () => {
    await client.exec(`
      INSERT INTO expenses (tenant_org_id, work_order_id, kind, description, amount_cents, incurred_on, billable) VALUES
        (${SIERRA}, 1, 'per_diem', 'Per diem, day trip - HAL Primary Lab', 3000, '2026-09-14', true),
        (${SIERRA}, 1, 'other',    'Parking',                             3100, '2026-09-14', true),
        (${SIERRA}, 1, 'mileage',  'Travel fuel',                         4250, '2026-09-14', false);
    `);
    const { issueServiceReport } = await import("@/app/actions");
    const { reportTotals } = await import("@/lib/serviceReport");
    await issueServiceReport(1);

    const [row] = await testDb.select().from(schema.serviceReports);
    const r = row.data as import("@/lib/serviceReport").ServiceReport;
    expect(r.labor.map((l) => l.description)).toEqual([
      "Labor, on site - Joe Harris", "Travel - Joe Harris",
    ]);
    expect(JSON.stringify(r)).not.toContain("Per diem");
    expect(JSON.stringify(r)).not.toContain("Parking");
    // The invoice still charges them; this document never counted them - the
    // labour total is the four hours and the two of travel, and nothing else.
    expect(reportTotals(r).labor).toBe(280_000);
    await client.exec(`DELETE FROM expenses;`);
  }, SLOW);
});

describe("taking one back, and drawing it again", () => {
  it("redraws in place, under the same number, from the job as it stands", async () => {
    const { issueServiceReport, reissueServiceReport } = await import("@/app/actions");
    await issueServiceReport(1);
    const [before] = await testDb.select().from(schema.serviceReports);
    expect((before.data as import("@/lib/serviceReport").ServiceReport).workCompleted).toBe("Repair on Pump B");

    // The record is corrected after the fact - a serial nobody had typed in,
    // a title that named the wrong pump. Reissuing is the honest fix.
    await client.exec(`UPDATE work_orders SET title = 'Repair on Pump A' WHERE id = 1;`);
    const res = await reissueServiceReport(before.id);
    expect(res.error).toBeUndefined();

    const rows = await testDb.select().from(schema.serviceReports);
    expect(rows).toHaveLength(1);                       // redrawn, not added to
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].number).toBe("030182_SR1");          // and it keeps its name
    expect((rows[0].data as import("@/lib/serviceReport").ServiceReport).workCompleted).toBe("Repair on Pump A");

    const log = await testDb.select().from(schema.auditLog).orderBy(schema.auditLog.id);
    expect(log[log.length - 1].action).toContain("reissued 030182_SR1");
  }, SLOW);

  it("deletes one, says so in the log, and hands its number back", async () => {
    const { issueServiceReport, deleteServiceReport } = await import("@/app/actions");
    await issueServiceReport(1);
    const [row] = await testDb.select().from(schema.serviceReports);

    const res = await deleteServiceReport(row.id);
    expect(res.error).toBeUndefined();
    expect(await testDb.select().from(schema.serviceReports)).toHaveLength(0);

    const log = await testDb.select().from(schema.auditLog).orderBy(schema.auditLog.id);
    const last = log[log.length - 1];
    expect(last.entityType).toBe("service_report");
    expect(last.action).toContain("deleted 030182_SR1");

    // Nothing was sent, so the number is free. The next report is SR1 again.
    await issueServiceReport(1);
    const [again] = await testDb.select().from(schema.serviceReports);
    expect(again.number).toBe("030182_SR1");
  }, SLOW);

  it("is not another workspace's to touch", async () => {
    const { issueServiceReport, deleteServiceReport, reissueServiceReport } = await import("@/app/actions");
    await issueServiceReport(1);
    const [row] = await testDb.select().from(schema.serviceReports);

    // Another operator on the same instance - not platform staff, whose own
    // workspace this is not. See lib/tenants.isHouseOf.
    who = { ...OWNER, email: "someone@cascade.test", operatorOrgId: CASCADE, rootOperatorOrgId: SIERRA };
    expect((await deleteServiceReport(row.id)).error).toBe("Not found");
    expect((await reissueServiceReport(row.id)).error).toBe("Not found");
    expect(await testDb.select().from(schema.serviceReports)).toHaveLength(1);
  }, SLOW);
});

describe("who asked, and who signs", () => {
  it("prints the signatory the job names, and the requester when it names none", async () => {
    const { issueServiceReport, updateWorkOrder } = await import("@/app/actions");
    await issueServiceReport(1);
    const [first] = await testDb.select().from(schema.serviceReports);
    const a = first.data as import("@/lib/serviceReport").ServiceReport;
    expect(a.request.from).toBe("Prajita Pandey");
    expect(a.signatures.customerName).toBe("Prajita Pandey");

    // The person who called is at their desk; the person who watched the
    // engineer pack up signs for the visit.
    await updateWorkOrder(1, {
      title: "Repair on Pump B", body: "Customer states Pump B not working.",
      severity: "Down", assignee: "Joe Harris",
      requestedBy: "Prajita Pandey", clientSignatory: "Brianna White",
    });
    const { reissueServiceReport } = await import("@/app/actions");
    await reissueServiceReport(first.id);

    const [row] = await testDb.select().from(schema.serviceReports);
    const b = row.data as import("@/lib/serviceReport").ServiceReport;
    expect(b.request.from).toBe("Prajita Pandey");        // who asked, unchanged
    expect(b.signatures.customerName).toBe("Brianna White");
  }, SLOW);
});

describe("a visit on a job that is not finished", () => {
  /*
   * The case that made this exist, in the owner's words: "We were onsite
   * assessing an open service report. We determined the roughing pump is okay
   * temporarily and they can continue running it. However we're going to order
   * them a new roughing pump. Client still wants a service report for our
   * visit today."
   *
   * Closing the job would be a lie - the pump is still to be fitted, and a
   * closed job in this app cannot take the return visit's hours, the PO, or
   * the booking. So the job stays open and the VISIT gets its paper.
   */
  const VISIT = "Roughing pump tested at 42 mTorr - within spec and safe to run.\n"
    + "Ordering a replacement; return visit to fit it.";

  it("reports the visit and leaves the job open", async () => {
    const { issueServiceReport } = await import("@/app/actions");
    await seedJob({ state: "active", closeSummary: "" });

    expect((await issueServiceReport(1, VISIT)).error).toBeUndefined();
    const [row] = await testDb.select().from(schema.serviceReports);
    const r = row.data as import("@/lib/serviceReport").ServiceReport;

    expect(row.number).toBe("030182_SR1");
    expect(r.notes.body).toBe(VISIT);
    // Dated to the day on site, not to a finish that has not happened.
    expect(r.notes.date).toBe("2026-09-14");
    expect(r.visitDate).toBe("Monday, September 14, 2026");
    // The visit's hours and parts are on it, priced as any other visit's.
    expect(r.labor.map((l) => l.description)).toEqual([
      "Labor, on site - Joe Harris", "Travel - Joe Harris",
    ]);
    expect(r.parts).toHaveLength(2);

    const [wo] = await testDb.select().from(schema.workOrders).where(eq(schema.workOrders.id, 1));
    expect(wo.state).toBe("active");
    expect(wo.closeSummary).toBe("");          // the job's own close-out is still unwritten
  }, SLOW);

  it("keeps the visit's words with the report, so a reissue redraws the same page", async () => {
    const { issueServiceReport, reissueServiceReport } = await import("@/app/actions");
    await seedJob({ state: "active", closeSummary: "" });
    await issueServiceReport(1, VISIT);
    const [first] = await testDb.select().from(schema.serviceReports);
    expect(first.visitNotes).toBe(VISIT);

    // The job is finished weeks later, with its own close-out about the pump
    // that was finally fitted. SR1 is the page the client signed in September
    // and must not quietly become a report about October.
    await client.exec(`
      UPDATE work_orders SET state = 'resolved', close_summary = 'Fitted the new roughing pump.'
      WHERE id = 1;
    `);
    expect((await reissueServiceReport(first.id)).error).toBeUndefined();
    const [row] = await testDb.select().from(schema.serviceReports);
    expect((row.data as import("@/lib/serviceReport").ServiceReport).notes.body).toBe(VISIT);
  }, SLOW);

  it("gives the second visit its own report, carrying only its own work", async () => {
    // The whole reason a report records what it covered: the return trip's
    // page must not re-bill September's four hours and two parts.
    const { issueServiceReport } = await import("@/app/actions");
    const { reportTotals } = await import("@/lib/serviceReport");
    await seedJob({ state: "active", closeSummary: "" });
    await issueServiceReport(1, VISIT);

    await client.exec(`
      INSERT INTO parts (id, instrument_id, work_order_id, name, part_number, qty,
                         cost_cents, status, owner_org_id, installed_at) VALUES
        (3, 1, 1, 'Roughing Pump', 'PFE-0141', '1', 410000, 'Installed', ${EMERY}, '2026-10-05');
      INSERT INTO time_entries (tenant_org_id, instrument_id, work_order_id, person, date, minutes, category, billable)
      VALUES (${SIERRA}, 1, 1, 'Joe Harris', '2026-10-05', 180, 'onsite', true);
      UPDATE work_orders SET state = 'resolved', close_summary = 'Fitted the new roughing pump. ALL OK'
      WHERE id = 1;
    `);
    expect((await issueServiceReport(1)).error).toBeUndefined();

    const rows = await testDb.select().from(schema.serviceReports).orderBy(schema.serviceReports.id);
    expect(rows.map((r) => r.number)).toEqual(["030182_SR1", "030182_SR2"]);
    const second = rows[1].data as import("@/lib/serviceReport").ServiceReport;

    // October's part and October's hours, and September's on neither.
    expect(second.parts.map((l) => l.partNumber)).toEqual(["PFE-0141"]);
    expect(second.labor.map((l) => l.description)).toEqual(["Labor, on site - Joe Harris"]);
    expect(second.visitDate).toBe("Monday, October 5, 2026");
    expect(second.notes.body).toContain("Fitted the new roughing pump");

    // Neither page carries a line the other one does, which is the point:
    // between them they state the job once, not twice.
    const first = rows[0].data as import("@/lib/serviceReport").ServiceReport;
    expect(first.parts.map((l) => l.partNumber)).toEqual(["6044.5201", "6040.0042"]);
    expect(reportTotals(second).parts).toBeLessThan(reportTotals(first).parts + reportTotals(second).parts);
    expect(reportTotals(second).labor).toBeGreaterThan(0);
    // September's four hours are on September's page and nowhere else.
    expect(second.labor.every((l) => l.quantity === 3)).toBe(true);
  }, SLOW);

  it("hands a deleted report's work back to the next one", async () => {
    // Deleting a report is for one issued in error. Its hours and parts were
    // never reported, so the next report is the one that carries them.
    const { issueServiceReport, deleteServiceReport } = await import("@/app/actions");
    await seedJob({ state: "active", closeSummary: "" });
    await issueServiceReport(1, VISIT);
    const [first] = await testDb.select().from(schema.serviceReports);
    expect((await deleteServiceReport(first.id)).error).toBeUndefined();

    expect((await issueServiceReport(1, VISIT)).error).toBeUndefined();
    const [again] = await testDb.select().from(schema.serviceReports);
    expect((again.data as import("@/lib/serviceReport").ServiceReport).parts).toHaveLength(2);
  }, SLOW);

  it("tells whoever picks the job up that the client already has paper", async () => {
    const { issueServiceReport } = await import("@/app/actions");
    await seedJob({ state: "active", closeSummary: "" });
    await issueServiceReport(1, VISIT);
    const [note] = await testDb.select().from(schema.workOrderNotes);
    expect(note.text).toContain("Issued 030182_SR1 for the visit of Monday, September 14, 2026");
    expect(note.text).toContain("030182 stays open");
  }, SLOW);
});

describe("what it refuses", () => {
  it("will not report on an open job with nothing said about the visit", async () => {
    // An open job CAN be reported on - see "a visit on a job that is not
    // finished" - but only with an account of the visit, because there is no
    // close-out behind it to fall back on.
    const { issueServiceReport } = await import("@/app/actions");
    await seedJob({ state: "active", closeSummary: "" });
    const res = await issueServiceReport(1);
    expect(res.error).toMatch(/say what was done on this visit/i);
    expect(await testDb.select().from(schema.serviceReports)).toHaveLength(0);
  }, SLOW);

  it("will not put a signature under an empty page", async () => {
    const { issueServiceReport } = await import("@/app/actions");
    await seedJob({ closeSummary: "" });
    const res = await issueServiceReport(1);
    expect(res.error).toMatch(/Nothing is written/);
    expect(await testDb.select().from(schema.serviceReports)).toHaveLength(0);
  }, SLOW);

  it("will not issue the same page twice under two numbers", async () => {
    // Every hour and every part is already on a report the client has. A
    // second one would be the first one again, under a number that implies a
    // second visit happened.
    const { issueServiceReport } = await import("@/app/actions");
    expect((await issueServiceReport(1)).error).toBeUndefined();
    expect((await issueServiceReport(1)).error).toMatch(/Nothing has been logged on 030182 since the last report/);
    expect(await testDb.select().from(schema.serviceReports)).toHaveLength(1);
  }, SLOW);

  it("has nothing to report on a job that was cancelled", async () => {
    const { issueServiceReport } = await import("@/app/actions");
    await seedJob({ state: "cancelled" });
    expect((await issueServiceReport(1, "We were there")).error).toMatch(/was cancelled/);
  }, SLOW);
});
