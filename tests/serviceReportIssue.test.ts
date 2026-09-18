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

const SIERRA = 1, EMERY = 2;
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
       '1000 Atlantic Ave.,\nSuite #110\nAlameda, CA 94501');
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

    await client.exec(`UPDATE work_orders SET state = 'closed', closed_at = '2026-09-15T12:00:00Z' WHERE id = 1;`);
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

describe("what it refuses", () => {
  it("will not report on work nobody has finished", async () => {
    const { issueServiceReport } = await import("@/app/actions");
    await seedJob({ state: "active" });
    const res = await issueServiceReport(1);
    expect(res.error).toMatch(/the work has to be done first/);
    expect(await testDb.select().from(schema.serviceReports)).toHaveLength(0);
  }, SLOW);

  it("will not put a signature under an empty page", async () => {
    const { issueServiceReport } = await import("@/app/actions");
    await seedJob({ closeSummary: "" });
    const res = await issueServiceReport(1);
    expect(res.error).toMatch(/Nothing is written/);
    expect(await testDb.select().from(schema.serviceReports)).toHaveLength(0);
  }, SLOW);
});
