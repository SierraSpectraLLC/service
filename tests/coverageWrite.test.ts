// Who may say who covers a system.
//
// agreements is where OUR contracts live - the rows that decide what we bill
// and what we absorb - and this change opens a door onto that table for the
// client's own editors, because the client knows their own paperwork better
// than we do. So the door is narrow in three directions at once, and the one
// that matters most is the third: a client who could write a row with a NULL
// provider could grant their own organization unlimited visits on our dime.
//
// Real Postgres, in-process PGlite from the same drizzle/schema-sync.sql every
// deploy applies, because the guarantee is in the WHERE clauses and the role
// check - a stubbed database would prove only that my mock refuses.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });

type Who = {
  email: string; name: string; role: string;
  orgId: number | null; operatorOrgId: number | null; rootOperatorOrgId: number | null;
} | null;
let who: Who = null;

vi.mock("@/db", () => ({ db: testDb }));
vi.mock("@/auth", () => ({ auth: async () => (who ? { user: who } : null) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));
vi.mock("@/lib/notify", () => ({ notifyTaskAssigned: async () => {}, notifyInvite: async () => {} }));

const OWNER_EDITOR: Who = {
  email: "maria@labzen.test", name: "Maria Chen", role: "client_editor",
  orgId: 1, operatorOrgId: null, rootOperatorOrgId: null,
};
const OWNER_VIEWER: Who = {
  email: "tech@labzen.test", name: "A Tech", role: "client_viewer",
  orgId: 1, operatorOrgId: null, rootOperatorOrgId: null,
};
const OTHER_CLIENT: Who = {
  email: "dana@coastal.test", name: "Dana", role: "client_editor",
  orgId: 2, operatorOrgId: null, rootOperatorOrgId: null,
};
const STAFF: Who = {
  email: "bill@sierra.test", name: "Bill", role: "staff",
  orgId: 3, operatorOrgId: 3, rootOperatorOrgId: 3,
};

/* LZ-001 belongs to Lab Zen and is shared with them, because client visibility
   comes from a share rather than from ownership. LZ-900 belongs to nobody -
   house-stewarded, ours outright, nothing for anyone to hold a contract on. */
const RESET = `
  DELETE FROM agreements; DELETE FROM system_shares; DELETE FROM instruments;
  DELETE FROM orgs WHERE id > 3;
  INSERT INTO instruments (id, external_id, client, model, owner_org_id, tenant_org_id)
    VALUES (1, 'LZ-001', 'Lab Zen', '6495C', 1, 3),
           (9, 'LZ-900', 'House',   'Spare', NULL, 3);
  INSERT INTO system_shares (instrument_id, org_id, access) VALUES (1, 1, 'edit'), (9, 1, 'edit');
`;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES
      (1, 'Lab Zen', 'client', false), (2, 'Coastal Analytical', 'client', false),
      (3, 'Sierra Spectra', 'provider', true);
    -- Explicit ids leave the sequence at 1, so the first org this code
    -- creates would collide with Lab Zen.
    SELECT setval('orgs_id_seq', 100);
  `);
});

beforeEach(async () => {
  who = null;
  await client.exec(RESET);
});

const form = (over: Record<string, string> = {}) => ({
  instrumentId: 1, providerName: "Agilent", title: "Advantage Gold", number: "AG-77",
  startsOn: "2026-01-01", endsOn: "2027-03-01",
  visitsIncluded: "2", partsAllowance: "1000", laborIncludedHours: "8", note: "",
  ...over,
});

const rows = async () =>
  (await client.query<{
    id: number; org_id: number; provider_org_id: number | null; instrument_ids: number[];
    visits_included: number;
  }>(`SELECT id, org_id, provider_org_id, instrument_ids, visits_included FROM agreements`)).rows;

describe("recording somebody else's contract", () => {
  it("lets an editor at the owning organization record it", async () => {
    who = OWNER_EDITOR;
    const { recordCoverage } = await import("@/app/actions");
    expect((await recordCoverage(form())).error).toBeUndefined();
    const [r] = await rows();
    expect(r.org_id).toBe(1);
    expect(r.provider_org_id).not.toBeNull();
    // Scoped to the one system, never the whole account: a panel on one
    // record is not the place to make an account-wide claim.
    expect(r.instrument_ids).toEqual([1]);
    // Entitlements are recorded as given - the operator asked for that.
    expect(r.visits_included).toBe(2);
  });

  it("REFUSES to write one with no provider - the whole point of the door", async () => {
    /* A null provider is what marks an agreement as OURS. A client able to
       write one could grant their own organization unlimited visits against
       our labour, from a dialog on their own instrument page. */
    who = OWNER_EDITOR;
    const { recordCoverage } = await import("@/app/actions");
    const res = await recordCoverage(form({ providerName: "" }));
    expect(res.error).toMatch(/who provides/i);
    expect(await rows()).toEqual([]);
  });

  it("REFUSES to write one naming US as the provider", async () => {
    // The same attack with the operator's own name typed in. resolveProvider
    // reads our name as null, which is exactly the row that must not exist.
    who = OWNER_EDITOR;
    const { recordCoverage } = await import("@/app/actions");
    const res = await recordCoverage(form({ providerName: "Sierra Spectra" }));
    expect(res.error).toMatch(/somebody else holds/i);
    expect(await rows()).toEqual([]);
  });

  it("is case-blind about our own name", async () => {
    who = OWNER_EDITOR;
    const { recordCoverage } = await import("@/app/actions");
    expect((await recordCoverage(form({ providerName: "  sierra spectra " }))).error)
      .toMatch(/somebody else holds/i);
    expect(await rows()).toEqual([]);
  });

  it("REFUSES another organization's system", async () => {
    // Coastal cannot see LZ-001, so this reads as absent rather than as
    // forbidden - a refusal that confirms the record exists is a leak.
    who = OTHER_CLIENT;
    const { recordCoverage } = await import("@/app/actions");
    expect((await recordCoverage(form())).error).toMatch(/not found/i);
    expect(await rows()).toEqual([]);
  });

  it("REFUSES a read-only account", async () => {
    who = OWNER_VIEWER;
    const { recordCoverage } = await import("@/app/actions");
    await expect(recordCoverage(form())).rejects.toThrow(/read-only/i);
    expect(await rows()).toEqual([]);
  });

  it("refuses a system nobody owns", async () => {
    // House-stewarded: ours outright, with no counterparty to hold a contract.
    who = STAFF;
    const { recordCoverage } = await import("@/app/actions");
    expect((await recordCoverage(form({}))).error).toBeUndefined();
    const res = await (await import("@/app/actions")).recordCoverage({ ...form(), instrumentId: 9 });
    expect(res.error).toMatch(/no owner/i);
  });

  it("reuses one directory entry for a company named twice", async () => {
    // Otherwise every typed "Agilent" becomes another company and the pill on
    // the card stops meaning anything.
    who = OWNER_EDITOR;
    const { recordCoverage } = await import("@/app/actions");
    await recordCoverage(form({ number: "A-1" }));
    await recordCoverage(form({ providerName: "agilent", number: "A-2" }));
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all[0].provider_org_id).toBe(all[1].provider_org_id);
    const made = await client.query<{ n: string; kind: string }>(
      `SELECT name AS n, kind FROM orgs WHERE id > 3`);
    expect(made.rows).toHaveLength(1);
    // A directory entry, not a participant: no workspace, no login.
    expect(made.rows[0].kind).toBe("provider");
  });
});

describe("taking it back off", () => {
  const record = async () => {
    who = OWNER_EDITOR;
    const { recordCoverage } = await import("@/app/actions");
    await recordCoverage(form());
    return (await rows())[0].id;
  };

  it("lets the organization that recorded it remove it", async () => {
    const id = await record();
    const { removeCoverage } = await import("@/app/actions");
    expect((await removeCoverage(id)).error).toBeUndefined();
    expect(await rows()).toEqual([]);
  });

  it("REFUSES to delete one of OUR contracts through this door", async () => {
    /* The mirror of the write gate. Our commercial paper leaves from the
       agreements screen, by staff, with a reason - not from a button on an
       instrument page. */
    await client.exec(`
      INSERT INTO agreements (id, org_id, tenant_org_id, kind, number, status, provider_org_id)
        VALUES (500, 1, 3, 'contract', 'C-OURS', 'active', NULL);
    `);
    who = OWNER_EDITOR;
    const { removeCoverage } = await import("@/app/actions");
    expect((await removeCoverage(500)).error).toMatch(/not found/i);
    expect((await rows()).some((r) => r.id === 500)).toBe(true);
  });

  it("REFUSES another organization's recorded coverage", async () => {
    const id = await record();
    who = OTHER_CLIENT;
    const { removeCoverage } = await import("@/app/actions");
    expect((await removeCoverage(id)).error).toMatch(/not found/i);
    expect(await rows()).toHaveLength(1);
  });
});
