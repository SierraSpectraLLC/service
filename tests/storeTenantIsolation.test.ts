// The file store, between two service companies.
//
// The sibling of tests/tenantIsolation.test.ts, which asks the same question
// of the pure rules (costs, stockrooms, the queue, remote access). This one
// asks it of the queries, against real Postgres - and of the one surface a
// buyer actually opened.
//
// This is the leak that was caught live: a demo workspace was opened on a
// running instance, and its owner opened Files and read the real operator's
// contracts, manuals and photos. The tab was even labelled with the demo
// company's own name, which is what made it look like their shelf.
//
// The cause is worth stating plainly, because it is the same one in every
// place this had to be fixed: A NULL IS NOT A SCOPE. A house shelf file
// carries org_id NULL. An unclaimed system carries owner_org_id NULL. Staff
// carry orgId null. EVERY workspace has rows like that, so a predicate written
// against NULL matches all of them at once, and the role check in front of it
// - isStaffRole, isHouse, role === "owner" - is true for every operator's
// people. Only the tenant stamp separates one house from the next.
//
// Real Postgres, in-process, from the same DDL every deploy applies: the
// guarantee is in the WHERE clause, so a mocked database would be testing the
// mock.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });

vi.mock("@/db", () => ({ db: testDb }));

// Orgs 1 and 2 are the operators, 3 and 4 their clients. app_settings names
// operator 1 as the instance's - which is precisely the setting that used to
// hand operator 2's people operator 1's shelf.
beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (name, kind, is_operator, parent_org_id) VALUES
      ('Sierra Spectra', 'provider', true,  NULL),
      ('Cascade Instrument', 'provider', true, NULL),
      ('Lab Zen', 'client', false, 1),
      ('Ellison BioLabs', 'client', false, 2);
    INSERT INTO app_settings (id, operator_org_id) VALUES (1, 1);

    -- One system each, unclaimed: owner_org_id NULL on both, which is the
    -- second NULL that used to make these two workspaces one.
    INSERT INTO instruments (tenant_org_id, external_id, client, model, owner_org_id) VALUES
      (1, 'SIERRA-SYS', 'Lab Zen', 'GC-2030', NULL),
      (2, 'CASCADE-SYS', 'Ellison BioLabs', 'LC-40', NULL);

    -- House shelf files: org_id NULL on both.
    INSERT INTO attachments (tenant_org_id, org_id, instrument_id, asset_id, file_name, kind, size, url, uploaded_by) VALUES
      (1, NULL, NULL, NULL, 'sierra-master-agreement.pdf', 'Report', 1000, 'https://example.test/a', 'joe'),
      (2, NULL, NULL, NULL, 'cascade-demo-sop.pdf',        'Report', 2000, 'https://example.test/b', 'dana');

    -- And the paperwork hanging off each unclaimed system.
    INSERT INTO attachments (tenant_org_id, org_id, instrument_id, asset_id, file_name, kind, size, url, uploaded_by) VALUES
      (1, NULL, 1, NULL, 'sierra-calibration.pdf', 'Report', 4000, 'https://example.test/c', 'joe'),
      (2, NULL, 2, NULL, 'cascade-calibration.pdf', 'Report', 8000, 'https://example.test/d', 'dana');
  `);
});

const names = (rows: { fileName: string }[]) => rows.map((r) => r.fileName).sort();

describe("one operator's house shelf is not another's", () => {
  it("storeFiles returns only the asking workspace's files", async () => {
    const { storeFiles } = await import("@/lib/storeUsage");
    // orgId null is "our own shelf". Both operators ask the identical question
    // and must get different answers - that is the whole test.
    expect(names(await storeFiles(null, 1))).toEqual([
      "sierra-calibration.pdf", "sierra-master-agreement.pdf",
    ]);
    expect(names(await storeFiles(null, 2))).toEqual([
      "cascade-calibration.pdf", "cascade-demo-sop.pdf",
    ]);
  });

  it("the meter counts the same bytes the list shows", async () => {
    // These two disagreeing is how the leak stayed invisible: a store can show
    // the right files and still be sized against everybody's.
    const { storeUsedBytes } = await import("@/lib/storeUsage");
    expect(await storeUsedBytes(null, 1)).toBe(5000);
    expect(await storeUsedBytes(null, 2)).toBe(10000);
  });

  it("an operator reached by its own org row gets the same one store", async () => {
    // An operator is reachable two ways - as the house (org null) and as its
    // own org row, since it can own equipment like any client. Those are one
    // tenant and must be one store, or it silently gets twice the ceiling.
    const { storeUsedBytes } = await import("@/lib/storeUsage");
    expect(await storeUsedBytes(2, 2)).toBe(await storeUsedBytes(null, 2));
  });

  it("the quota names the asking workspace's store, not the instance's", async () => {
    // The mislabelled tab: operator 2 opened Files, saw its own name on the
    // heading, and was reading operator 1's shelf underneath.
    const { storeQuota } = await import("@/lib/storeUsage");
    expect((await storeQuota(null, 2)).usedBytes).toBe(10000);
    expect((await storeQuota(null, 1)).usedBytes).toBe(5000);
  });
});

describe("platform staff still see the whole instance", () => {
  // Null tenant has to keep meaning "no restriction" - somebody supports every
  // workspace, and that is the reason the rule is written this way at all.
  it("null reads across both workspaces", async () => {
    const { storeFiles, storeUsedBytes } = await import("@/lib/storeUsage");
    expect(names(await storeFiles(null, null))).toEqual([
      "cascade-calibration.pdf", "cascade-demo-sop.pdf",
      "sierra-calibration.pdf", "sierra-master-agreement.pdf",
    ]);
    expect(await storeUsedBytes(null, null)).toBe(15000);
  });
});

describe("the organization directory", () => {
  it("a client of one operator is not visible to the other", async () => {
    const { visibleOrgs } = await import("@/lib/tenancy");
    const asCascade = await visibleOrgs({
      email: "owner@cascade.test", role: "owner", orgId: null,
      operatorOrgId: 2, rootOperatorOrgId: 1,
    } as never);
    const seen = asCascade.map((o) => o.name);
    expect(seen).toContain("Ellison BioLabs");
    expect(seen).not.toContain("Lab Zen");
    // Operators stay visible to each other by design: that directory is what
    // makes a client bringing in a second service company possible at all.
    expect(seen).toContain("Sierra Spectra");
  });
});
