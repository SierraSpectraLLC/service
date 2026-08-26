// Recording a part somebody is making, and keeping it off the allowance.
//
// Two guarantees live in SQL and a guard clause, so they are checked against a
// real table: that a maker has to be an organization with a hold on the
// machine, and that a part the client made themselves does not draw down the
// parts cover we owe them. The second is the money one - charging a lab two
// dollars of their own filament against their contract is the same shape of
// error as counting an Agilent contract's visits as our drawdown.
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

const BILL: Who = {
  email: "bill@sierra.test", name: "Bill", role: "staff",
  orgId: 3, operatorOrgId: 3, rootOperatorOrgId: 3,
};

/* LZ-001 is Lab Zen's machine on Sierra Spectra's bench, shared with Lab Zen.
   Coastal (org 2) has nothing to do with it. */
const RESET = `
  DELETE FROM parts; DELETE FROM system_shares; DELETE FROM instruments;
  INSERT INTO instruments (id, external_id, client, model, owner_org_id, tenant_org_id)
    VALUES (1, 'LZ-001', 'Lab Zen', '6495C', 1, 3);
  INSERT INTO system_shares (instrument_id, org_id, access) VALUES (1, 1, 'edit');
`;

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
  who = null;
  await client.exec(RESET);
});

const form = (over: Record<string, unknown> = {}) => ({
  kind: "part", name: "Sparger bracket", partNumber: "", serial: "", qty: "", specs: "",
  vendor: "", po: "", cost: "", carrier: "", tracking: "", orderedAt: "", eta: "",
  status: "Being made", note: "", ...over,
});

const rows = async () => (await client.query<{
  id: number; status: string; maker_org_id: number | null; made_at: string; cost_cents: number | null;
}>(`SELECT id, status, maker_org_id, made_at, cost_cents FROM parts ORDER BY id`)).rows;

describe("recording who is making it", () => {
  it("takes the organization that was chosen", async () => {
    who = BILL;
    const { createPart } = await import("@/app/actions");
    expect((await createPart({ instrumentId: 1, assetId: null }, form({ makerOrgId: 1 }) as never)).error)
      .toBeUndefined();
    expect((await rows())[0].maker_org_id).toBe(1);
  });

  it("refuses an organization with no hold on the system", async () => {
    // A picker built on the whole instance would let a print job be parked on
    // a company nobody would ever ask about it - and would leak the client
    // list on a multi-operator instance. See lib/parties.
    who = BILL;
    const { createPart } = await import("@/app/actions");
    expect((await createPart({ instrumentId: 1, assetId: null }, form({ makerOrgId: 2 }) as never)).error)
      .toMatch(/nothing to do with this part/);
    expect(await rows()).toEqual([]);
  });

  it("leaves the maker alone when an edit says nothing about it", async () => {
    // The intake dialog and older forms never send it; saving a note through
    // one of them must not silently clear an attribution.
    who = BILL;
    const { createPart, updatePart } = await import("@/app/actions");
    await createPart({ instrumentId: 1, assetId: null }, form({ makerOrgId: 1 }) as never);
    const id = (await rows())[0].id;
    await updatePart(id, form({ note: "printed at 0.2mm" }) as never);
    expect((await rows())[0].maker_org_id).toBe(1);
  });
});

describe("the day it was made", () => {
  it("stamps made_at rather than received_at", async () => {
    who = BILL;
    const { createPart, setPartStatus } = await import("@/app/actions");
    await createPart({ instrumentId: 1, assetId: null }, form({ makerOrgId: 1 }) as never);
    const id = (await rows())[0].id;
    await setPartStatus(id, "Made");
    const [r] = await client.query<{ made_at: string; received_at: string }>(
      `SELECT made_at, received_at FROM parts WHERE id = ${id}`).then((x) => x.rows);
    expect(r.made_at).not.toBe("");
    // Nobody sent it, so it was never received.
    expect(r.received_at).toBe("");
  });
});

describe("the parts allowance", () => {
  const contract = { startsOn: "2026-01-01", endsOn: "2026-12-31" };

  const fit = (makerOrgId: number | null, cents: number) => client.exec(`
    INSERT INTO parts (instrument_id, name, status, cost_cents, owner_org_id, installed_at, maker_org_id)
    VALUES (1, 'Bracket', 'Installed', ${cents}, 1, '2026-06-01',
            ${makerOrgId === null ? "NULL" : makerOrgId});
  `);

  it("counts a part we bought for them", async () => {
    await fit(null, 4200);
    const { usageFor } = await import("@/lib/agreementUsage");
    expect((await usageFor(contract, 1)).partsCents).toBe(4200);
  });

  it("counts a part WE fabricated for them - our material, our bench", async () => {
    await fit(3, 4200);
    const { usageFor } = await import("@/lib/agreementUsage");
    expect((await usageFor(contract, 1)).partsCents).toBe(4200);
  });

  it("DOES NOT COUNT A PART THEY MADE THEMSELVES", async () => {
    // The allowance is what this contract entitles them to have bought FOR
    // them. A bracket they printed is not something we supplied, and eating
    // their cover with it would take away service they have already paid for.
    await fit(1, 4200);
    const { usageFor } = await import("@/lib/agreementUsage");
    expect((await usageFor(contract, 1)).partsCents).toBe(0);
  });

  it("counts the ones we supplied and skips the ones they made, in one term", async () => {
    await fit(null, 1000);
    await fit(1, 9999);
    await fit(3, 500);
    const { usageFor } = await import("@/lib/agreementUsage");
    expect((await usageFor(contract, 1)).partsCents).toBe(1500);
  });
});
