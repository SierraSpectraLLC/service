// Whose systems reach a fleet brief.
//
// This is the leak worth a real database. `eq(instruments.owner_org_id, orgId)`
// LOOKS like a scope and is not one: a system owned by an organization can
// carry another operator's tenant stamp - that is exactly what a shared client
// is - so the owner predicate alone would let one service company compose a
// document, and mail it OUTSIDE the company, out of a competitor's records
// about the same client. And the usual second half cannot save it, because
// forTenant(col, null) emits no predicate at all.
//
// Real Postgres, in-process PGlite from the same drizzle/schema-sync.sql every
// deploy applies, because the guarantee is entirely in the WHERE clause.
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

const { fleetRowsFor, scopeProblem } = await import("@/lib/fleetBriefData");

const TODAY = "2026-08-27";

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES
      (1, 'Emery Pharma', 'client', false),
      (3, 'Sierra Spectra', 'provider', true),
      (4, 'Another Shop', 'provider', true);
    SELECT setval('orgs_id_seq', 100);

    -- Emery Pharma's estate, split across two service companies. Both rows are
    -- owned by Emery; only the tenant stamp tells them apart, which is the
    -- whole point of this file.
    INSERT INTO instruments (id, external_id, client, model, category, owner_org_id, tenant_org_id) VALUES
      (1, 'EP-001', 'Emery Pharma', 'LC-MS', 'LC-MS', 1, 3),
      (2, 'EP-002', 'Emery Pharma', 'LC-MS', 'LC-MS', 1, 3),
      (3, 'EP-900', 'Emery Pharma', 'GC-MS', 'GC-MS', 1, 4);
    UPDATE instruments SET stages = ARRAY['Waiting / blocked'] WHERE id = 2;

    INSERT INTO assets (instrument_id, kind, model, serial, manufacturer, tenant_org_id) VALUES
      (1, 'Mass Spec', 'Altis', '12345', 'Thermo', 3),
      (1, 'Pump', 'nXDS15i', 'A77', 'Edwards', 3);

    INSERT INTO agreements (org_id, kind, number, status, starts_on, ends_on, instrument_ids, tenant_org_id)
      VALUES (1, 'contract', 'AGR-1', 'active', '2026-01-01', '2027-01-01', '{1}', 3);
  `);
});

describe("whose systems reach the brief", () => {
  it("returns this workspace's, and never the other operator's", async () => {
    /*
     * EP-900 is Emery Pharma's machine and is NOT ours. It is owned by the
     * same organization and differs only in its tenant stamp, so a brief built
     * on ownership alone would put another shop's record in our email.
     */
    const rows = await fleetRowsFor({
      orgId: 1, tenantOrgId: 3, today: TODAY, operatorName: "Sierra Spectra",
    });
    expect(rows.map((r) => r.externalId).sort()).toEqual(["EP-001", "EP-002"]);
  });

  it("refuses a caller whose workspace could not be resolved", () => {
    // A null tenant emits NO predicate, so falling through would compose the
    // brief out of every operator's rows. On a path that mails a document
    // outside the company the honest answer to a bug is an error.
    expect(scopeProblem(null, false)).toContain("could not be resolved");
    expect(scopeProblem(null, true)).toBeNull();     // platform staff, deliberately
    expect(scopeProblem(3, false)).toBeNull();
  });

  it("intersects a share's frozen ids with the scope rather than trusting them", async () => {
    /*
     * A share NAMES systems; it does not grant them. A link minted while we
     * held EP-900 must stop showing it the moment the machine moves, without
     * anybody remembering to revoke.
     */
    const rows = await fleetRowsFor({
      orgId: 1, tenantOrgId: 3, today: TODAY, operatorName: "Sierra Spectra",
      only: [1, 3],
    });
    expect(rows.map((r) => r.externalId)).toEqual(["EP-001"]);
  });

  it("carries the modules with their models and serials", async () => {
    const [ep1] = await fleetRowsFor({
      orgId: 1, tenantOrgId: 3, today: TODAY, operatorName: "Sierra Spectra", only: [1],
    });
    expect(ep1.modules).toEqual([
      { kind: "Mass Spec", model: "Altis", serial: "12345", manufacturer: "Thermo" },
      { kind: "Pump", model: "nXDS15i", serial: "A77", manufacturer: "Edwards" },
    ]);
  });

  it("says which systems somebody already has a contract on", async () => {
    const rows = await fleetRowsFor({
      orgId: 1, tenantOrgId: 3, today: TODAY, operatorName: "Sierra Spectra",
    });
    const byId = new Map(rows.map((r) => [r.externalId, r]));
    expect(byId.get("EP-001")!.coverage).toBe("ours");
    // Nothing recorded reads as "no contract ON FILE" - we know what we have
    // been shown, not what exists.
    expect(byId.get("EP-002")!.coverage).toBe("unknown");
  });

  it("says a stalled machine is stalled, in the client's own words", async () => {
    /*
     * A peer's first question is whether the machine runs. The word comes from
     * lib/clientView, the same one the client's own page uses - and note what
     * is NOT carried: the state, never the reason. Why a system is down is the
     * client's story to tell, not ours.
     */
    const rows = await fleetRowsFor({
      orgId: 1, tenantOrgId: 3, today: TODAY, operatorName: "Sierra Spectra",
    });
    expect(rows.find((r) => r.externalId === "EP-002")!.state).toBe("blocked");
    expect(rows.find((r) => r.externalId === "EP-001")!.state).toBe("ok");
  });

  it("has nothing to say about a client with no systems here", async () => {
    expect(await fleetRowsFor({
      orgId: 999, tenantOrgId: 3, today: TODAY, operatorName: "Sierra Spectra",
    })).toEqual([]);
  });
});
