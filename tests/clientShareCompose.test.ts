// Taking the snapshot: what a hand-off actually picks up off the sender's
// database before it is frozen into an offer.
//
// The materialize test asks whether everything lands; this one asks whether
// the right things were gathered in the first place. Two properties matter.
// One is scope - a payload is composed to be written into a COMPETITOR's
// database, so a row from the wrong workspace here is the worst bug this
// feature has. The other is honesty: the hand-off page advertises these by
// count, so anything gathered has to be something the sender is entitled to
// pass on, and anything not gathered must not be counted.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));

const { composePayload, composePricing } = await import("@/lib/clientShareData");
const { inventoryOf } = await import("@/lib/clientShare");

/** 3 = the sender. 5 = another operator entirely, whose rows must never appear. */
beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES
      (3, 'Sierra Spectra', 'provider', true),
      (5, 'Northwest Instrument Services', 'provider', true);
    INSERT INTO orgs (id, name, kind, parent_org_id) VALUES
      (10, 'Emery Pharma', 'client', 3);
    SELECT setval('orgs_id_seq', 100);

    INSERT INTO org_sites (id, tenant_org_id, org_id, name, address)
      VALUES (1, 3, 10, 'Hayward', '2000 Sample Way, Hayward CA 94544');

    INSERT INTO instruments (id, tenant_org_id, external_id, client, model, owner_org_id, site_id)
      VALUES (1, 3, 'EP-001', 'Emery Pharma', '6495C', 10, 1);
    -- Somebody else's machine, at a lab that is not this client's.
    INSERT INTO instruments (id, tenant_org_id, external_id, client, model, owner_org_id)
      VALUES (2, 5, 'NW-001', 'Someone Else', '6495C', NULL);
    SELECT setval('instruments_id_seq', 100);

    INSERT INTO assets (id, tenant_org_id, instrument_id, kind, model, serial, sort_order) VALUES
      (1, 3, 1, 'Mass Spec', '6495C', 'SN7009', 0),
      (2, 3, 1, 'Pump', 'nXDS15i', 'P409', 1);
    SELECT setval('assets_id_seq', 100);

    -- Two live schedules and one paused one.
    INSERT INTO pm_schedules (tenant_org_id, instrument_id, title, every_days, next_due, paused) VALUES
      (3, 1, 'Annual PM',   365, '2026-11-02', false),
      (3, 1, 'Source clean', 90, '2026-09-14', false),
      (3, 1, 'Retired job',  30, '2025-01-01', true);
    -- On the PUMP, which is the second module. A pump oil change belongs to
    -- the pump, not to the LC-MS around it.
    INSERT INTO pm_schedules (tenant_org_id, instrument_id, asset_id, title, every_days, next_due)
      VALUES (3, 1, 2, 'Rough pump oil change', 180, '2026-10-01');
    -- Written before pm_schedules carried a stamp. A null is not a scope, and
    -- dropping it would lose real maintenance out of a hand-off.
    INSERT INTO pm_schedules (instrument_id, title, every_days, next_due)
      VALUES (1, 'Older than the stamp', 365, '2026-12-01');
    -- The other operator's schedule, on the other operator's machine.
    INSERT INTO pm_schedules (tenant_org_id, instrument_id, title, every_days, next_due)
      VALUES (5, 2, 'Theirs', 30, '2026-09-01');

    -- One fitted, one still on order, one somebody only asked for.
    INSERT INTO parts (instrument_id, name, part_number, qty, installed_at, status, cost_cents) VALUES
      (1, 'Roughing pump oil', '6040-0855', '2', '2026-03-04', 'Installed', 4200),
      (1, 'Calibrant vial',    'G1969-85000', '1', '', 'Ordered', 9900),
      (1, 'Spare seal kit',    'X-1',        '1', '', 'Needed',  NULL);

    -- Ours to pass on, ours to pass on, and the manufacturer's.
    INSERT INTO catalog_refs (tenant_org_id, asset_type, model, kind, title, provenance) VALUES
      (3, 'Mass Spec', '6495C', 'note', 'Source clean, our way', 'original'),
      (3, 'Mass Spec', '',      'note', 'Vent sequence',         'facts'),
      (3, 'Mass Spec', '6495C', 'link', 'Agilent service manual', 'oem'),
      (3, 'Mass Spec', '6495C', 'note', 'Nobody has said',        ''),
      -- Files a type nothing in this fleet has.
      (3, 'Autosampler', '', 'note', 'Wrong kit entirely', 'original'),
      -- The other operator's library.
      (5, 'Mass Spec', '6495C', 'note', 'Theirs', 'original');
  `);
});

const compose = () => composePayload({
  orgId: 10, tenantOrgId: 3, operatorName: "Sierra Spectra",
  by: "joe@sierra.test", on: "2026-08-29", note: "",
});

describe("the maintenance rhythm", () => {
  it("takes the live schedules and leaves the paused ones", async () => {
    const p = (await compose())!;
    expect(p.pms!.map((m) => m.title).sort()).toEqual([
      "Annual PM", "Older than the stamp", "Rough pump oil change", "Source clean",
    ]);
  });

  it("names the machine by the sender's own tag, for materialize to re-hang", async () => {
    const p = (await compose())!;
    expect(p.pms!.every((m) => m.sourceRef === "EP-001")).toBe(true);
  });

  it("keeps a module's schedule on the module", async () => {
    /*
     * A pump oil change belongs to the pump. Carried as the module's POSITION
     * rather than its serial, because the serial is the one field blinding
     * removes - a reference that survives redaction cannot leak through it.
     */
    const p = (await compose())!;
    const pump = p.pms!.find((m) => m.title === "Rough pump oil change")!;
    expect(pump.moduleIndex).toBe(1);
    expect(p.systems[0].modules[1].kind).toBe("Pump");
    // And a system's own schedule says so, rather than pointing at module 0.
    expect(p.pms!.find((m) => m.title === "Annual PM")!.moduleIndex).toBeNull();
  });

  it("does not drop a row written before the table carried a stamp", async () => {
    /*
     * Scoped on the fleet rather than on the stamp, deliberately. The
     * instrument list is already scoped on owner AND tenant, a record hanging
     * off a system takes that system's tenant, and a null in the stamp column
     * is not a scope - reading it would silently lose maintenance out of a
     * hand-off the page had already advertised by count.
     */
    const p = (await compose())!;
    expect(p.pms!.some((m) => m.title === "Older than the stamp")).toBe(true);
  });
});

describe("the parts history", () => {
  it("is a history: what went in, not what is on order", async () => {
    const p = (await compose())!;
    expect(p.parts!.map((r) => r.name)).toEqual(["Roughing pump oil"]);
  });

  it("carries no cost, and has nowhere to put one", async () => {
    /*
     * The row it was read from has cost_cents on it. What a client was charged
     * is the sender's business and the client's; what the machine consumes is
     * the fact worth handing over, and it needs no price attached.
     */
    const p = (await compose())!;
    expect(JSON.stringify(p.parts)).not.toContain("4200");
    expect(Object.keys(p.parts![0])).toEqual(
      ["sourceRef", "name", "partNumber", "qty", "installedAt"]);
  });
});

describe("the reference library", () => {
  it("passes on only what the shop is entitled to pass on", async () => {
    /*
     * The same question lib/provenance answers for a licensed library, with a
     * different buyer: our own work and our own restatement of facts may go,
     * the manufacturer's words may not, and unreviewed counts as not ours -
     * the expensive mistake runs the other way.
     */
    const p = (await compose())!;
    expect(p.refs!.map((r) => r.title).sort())
      .toEqual(["Source clean, our way", "Vent sequence"]);
  });

  it("leaves behind what does not cover this fleet", async () => {
    // Filed on an Autosampler, and there is no autosampler here.
    const p = (await compose())!;
    expect(p.refs!.some((r) => r.assetType === "Autosampler")).toBe(false);
  });
});

describe("nothing from another workspace, ever", () => {
  it("takes no row belonging to a second operator", async () => {
    const p = (await compose())!;
    const json = JSON.stringify(p);
    expect(json).not.toContain("Theirs");
    expect(json).not.toContain("NW-001");
    expect(json).not.toContain("Someone Else");
  });

  it("refuses outright when the caller has no workspace", async () => {
    /*
     * A null tenant emits no predicate, so a composer that shrugged at it
     * would gather every operator's rows - on the one path whose whole purpose
     * is writing into somebody else's database. See lib/fleetBriefData.
     */
    expect(await composePayload({
      orgId: 10, tenantOrgId: null, operatorName: "x", by: "x", on: "x", note: "",
    })).toBeNull();
    expect(await composePricing({ orgId: 10, tenantOrgId: null })).toBeNull();
  });
});

describe("what the offer may advertise", () => {
  it("counts exactly what was gathered", async () => {
    const p = (await compose())!;
    expect(inventoryOf(p)).toEqual({
      systems: 1, sites: 1, modules: 2, pms: 4, parts: 1, refs: 2, pricingYears: 0,
    });
  });

  it("leaves pricing out unless somebody asked for it", async () => {
    // composePayload never reaches for it. The opt-in lives in the action.
    const p = (await compose())!;
    expect(p.pricing).toBeUndefined();
  });
});

describe("what the account has billed", () => {
  beforeAll(async () => {
    await client.exec(`
      INSERT INTO work_orders (id, tenant_org_id, title) VALUES (1, 3, 'March visit');
      SELECT setval('work_orders_id_seq', 100);
      INSERT INTO invoices (id, tenant_org_id, org_id, work_order_id, number, status, issued_on) VALUES
        (1, 3, 10, 1,    'INV-1', 'paid',  '2025-03-04'),
        (2, 3, 10, 1,    'INV-2', 'sent',  '2025-03-19'),
        (3, 3, 10, NULL, 'INV-3', 'paid',  '2025-09-02'),
        (4, 3, 10, NULL, 'INV-4', 'paid',  '2024-05-05'),
        (5, 3, 10, NULL, 'INV-5', 'draft', '2025-10-01'),
        (6, 3, 10, NULL, 'INV-6', 'void',  '2025-10-02');
      SELECT setval('invoices_id_seq', 100);
      INSERT INTO invoice_lines (invoice_id, kind, qty, unit_cents, covered) VALUES
        (1, 'labor', 4000, 19500, false),
        (1, 'part',  1000, 12000, false),
        (2, 'labor', 2000, 19500, false),
        (3, 'labor', 1000, 19500, false),
        -- The contract absorbed this one, so it prices at zero.
        (3, 'part',  1000, 50000, true),
        (4, 'labor', 3000, 17500, false),
        -- Never counted: a draft is a thing somebody is still writing.
        (5, 'labor', 9000, 99900, false),
        (6, 'labor', 9000, 99900, false);
    `);
  });

  it("totals a year the way an invoice totals itself", async () => {
    /*
     * qty is thousandths and a covered line prices at zero, because the
     * agreement already paid for it. 2025 is 4h + 2h + 1h of labour at $195
     * plus one $120 part, and NOT the $500 the contract absorbed.
     */
    const pr = (await composePricing({ orgId: 10, tenantOrgId: 3 }))!;
    const y2025 = pr.years.find((y) => y.year === "2025")!;
    expect(y2025.billedCents).toBe(19500 * 7 + 12000);
  });

  it("counts a visit as a job, not as a bill", async () => {
    // Two invoices against one work order is one trip. Counting them twice
    // flatters the account, which is the direction that costs a buyer money.
    const pr = (await composePricing({ orgId: 10, tenantOrgId: 3 }))!;
    expect(pr.years.find((y) => y.year === "2025")!.visits).toBe(2);
    expect(pr.years.find((y) => y.year === "2024")!.visits).toBe(1);
  });

  it("leaves drafts and voids out - neither is money anybody asked for", async () => {
    const pr = (await composePricing({ orgId: 10, tenantOrgId: 3 }))!;
    expect(JSON.stringify(pr)).not.toContain("99900");
    expect(pr.years.map((y) => y.year)).toEqual(["2025", "2024"]);
  });

  it("quotes the rate that shows up most, not the average and not the highest", async () => {
    /*
     * An average is dragged around by one long warranty job at zero; the
     * highest is the emergency call-out nobody is charged twice a year. What a
     * buyer needs is the number they would quote against.
     */
    const pr = (await composePricing({ orgId: 10, tenantOrgId: 3 }))!;
    expect(pr.laborRateCents).toBe(19500);
  });

  it("says nothing at all rather than nothing much", async () => {
    // A client who has never been invoiced has no billing history, and an
    // empty year list on the offer would read as an account worth nothing.
    expect(await composePricing({ orgId: 3, tenantOrgId: 3 })).toBeNull();
  });

  it("stops at a summary: no invoice, no line, no document", async () => {
    const pr = (await composePricing({ orgId: 10, tenantOrgId: 3 }))!;
    expect(Object.keys(pr).sort()).toEqual(["laborRateCents", "note", "years"]);
    expect(Object.keys(pr.years[0]).sort()).toEqual(["billedCents", "visits", "year"]);
    // Not an invoice number in sight, and nothing about how they pay.
    expect(JSON.stringify(pr)).not.toContain("INV-");
  });
});
