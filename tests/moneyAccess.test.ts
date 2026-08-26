// The database half of the books rule: who at a client may read its money, and
// what the switch that decides it does when nobody has touched it.
//
// The pure rule is in lib/books and tested there. What has to be checked
// against a real table is the DEFAULT, because the default is the whole risk
// in this change. Restricting an operator's books is safe - the operator has
// an OWNER role, and the owner keeps them. A client organization has no owner
// role, so getting the default wrong here does not make a lab's invoices
// private, it makes them unreachable by everybody at that lab until somebody
// at the shop goes in and hands the privilege back.
//
// Real Postgres, in-process PGlite from the same drizzle/schema-sync.sql every
// deploy applies, because a mocked column default proves only that I typed the
// same value twice.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });

vi.mock("@/db", () => ({ db: testDb }));

const { maySeeOrgMoney } = await import("@/lib/tenancy");

const RITA = { role: "client_editor", email: "rita@labzen.test", orgId: 1 };
const THOMAS = { role: "client_editor", email: "thomas@labzen.test", orgId: 1 };
/* Nobody's own row - they sign in through the @labzen.test wildcard. */
const WILDCARD = { role: "client_viewer", email: "newhire@labzen.test", orgId: 1 };
const DANA = { role: "client_editor", email: "dana@coastal.test", orgId: 2 };
const BILL = { role: "staff", email: "bill@sierra.test", orgId: 3 };

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES
      (1, 'Lab Zen', 'client', false), (2, 'Coastal Analytical', 'client', false),
      (3, 'Sierra Spectra', 'provider', true);
    SELECT setval('orgs_id_seq', 100);
  `);
});

beforeEach(async () => {
  await client.exec(`
    DELETE FROM client_allowlist;
    -- Written the way the app writes them: nothing names can_see_money, so
    -- every row here takes the column's default.
    INSERT INTO client_allowlist (entry, org_id, can_edit) VALUES
      ('rita@labzen.test', 1, true),
      ('thomas@labzen.test', 1, true),
      ('@labzen.test', 1, false),
      ('dana@coastal.test', 2, true);
  `);
});

const off = (entry: string) =>
  client.exec(`UPDATE client_allowlist SET can_see_money = false WHERE entry = '${entry}'`);

describe("the default nobody has touched", () => {
  it("leaves everyone at a client reading their own money", async () => {
    // The privilege everyone at an organization already had. This switch
    // exists to take it away from a named person, deliberately - never to
    // remove it from a whole lab by shipping a release.
    expect(await maySeeOrgMoney(RITA, 1)).toBe(true);
    expect(await maySeeOrgMoney(THOMAS, 1)).toBe(true);
  });

  it("leaves a domain-wildcard person reading it too", async () => {
    // Somebody who signs in through @labzen.test has no row of their own, so
    // there is no flag to read. Absence of a grant is the org's default, not a
    // denial - the same reading as maySeeAgreements beside it.
    expect(await maySeeOrgMoney(WILDCARD, 1)).toBe(true);
  });
});

describe("the switch, once somebody turns it off", () => {
  it("closes it for that person and nobody else", async () => {
    await off("thomas@labzen.test");
    expect(await maySeeOrgMoney(THOMAS, 1)).toBe(false);
    expect(await maySeeOrgMoney(RITA, 1)).toBe(true);
    expect(await maySeeOrgMoney(WILDCARD, 1)).toBe(true);
  });

  it("has exactly one row to be turned off on", async () => {
    // allowlist_entry_unique is on the ADDRESS alone, so a person cannot be
    // duplicated into a second organization and cannot carry a second, still
    // open, copy of this flag. Worth pinning: the whole switch would be
    // theatre if the same address could hold two rows and a session could
    // resolve to whichever one still said yes.
    await off("thomas@labzen.test");
    await expect(client.exec(
      `INSERT INTO client_allowlist (entry, org_id, can_edit) VALUES ('thomas@labzen.test', 2, true)`
    )).rejects.toThrow(/allowlist_entry_unique/);
    expect(await maySeeOrgMoney(THOMAS, 1)).toBe(false);
  });
});

describe("the walls that hold either way", () => {
  it("never lets one client read another's, flag on or off", async () => {
    expect(await maySeeOrgMoney(DANA, 1)).toBe(false);
    expect(await maySeeOrgMoney(RITA, 2)).toBe(false);
  });

  it("does not answer for a client reading an operator's books", async () => {
    // /money has its own gate; this function is the client's own room. What
    // matters is that it never says yes about a workspace they are not in.
    expect(await maySeeOrgMoney(RITA, 3)).toBe(false);
  });

  it("passes staff through to the gate that is actually theirs", async () => {
    // Not a grant: staff do not read a client's money HERE. /orders sends
    // them to /money, which asks lib/books about the operator's own books and
    // turns Bill away there.
    expect(await maySeeOrgMoney(BILL, 1)).toBe(true);
  });
});
