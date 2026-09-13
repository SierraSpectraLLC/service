// Entering a unit and saying whose it is, through the real action.
//
// The owner column used to be a name only: the picker offered whatever had
// been typed before, and picking "LabZen" wrote the word while LabZen could
// not open the unit. Now the picker offers organizations, and a pick sets
// the link that decides visibility together with the name (lib/owner).
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

const SIERRA = 3, CASCADE = 5, LABZEN = 7, OTHERS_CLIENT = 8;

// Sierra runs one workspace on an instance Cascade runs. Ordinary tenant
// staff, then - the instance operator's own staff see every organization by
// design, and that is not the seat this is testing from.
const STAFF: Who = {
  email: "bill@sierra.test", name: "Bill Reyes", role: "staff",
  orgId: SIERRA, operatorOrgId: SIERRA, rootOperatorOrgId: CASCADE,
};
const CLIENT_EDITOR: Who = {
  email: "rita@labzen.test", name: "Rita", role: "client_editor",
  orgId: LABZEN, operatorOrgId: null, rootOperatorOrgId: CASCADE,
};

const PUMP = {
  kind: "Pump", model: "nXDS15i", serial: "", manufacturer: "Edwards",
  owner: "", asFound: "", location: "Shelf B", note: "",
};

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator, parent_org_id) VALUES
      (${SIERRA}, 'Sierra Spectra', 'provider', true, NULL),
      (${CASCADE}, 'Cascade Analytical', 'provider', true, NULL),
      (${LABZEN}, 'LabZen', 'client', false, ${SIERRA}),
      -- Another operator's client: never on our list, whatever id is sent.
      (${OTHERS_CLIENT}, 'Rival Labs', 'client', false, ${CASCADE});
    SELECT setval('orgs_id_seq', 100);
  `);
});

beforeEach(async () => {
  who = STAFF;
  await client.exec("DELETE FROM tasks; DELETE FROM asset_events; DELETE FROM assets;");
});

const create = async (over: Record<string, unknown> = {}) => {
  const { createAsset } = await import("@/app/actions");
  return createAsset(null, { ...PUMP, ...over } as never);
};
const assetRows = () => testDb.select().from(schema.assets);

describe("saying whose a new unit is", () => {
  it("links the organization the owner was picked as, and prints its name", async () => {
    // Typed as it was picked; the name that lands is the organization's own.
    const res = await create({ owner: "labzen", ownerOrgId: LABZEN });
    expect(res.error).toBeUndefined();
    const [a] = await assetRows();
    expect(a.ownerOrgId).toBe(LABZEN);
    expect(a.owner).toBe("LabZen");
  });

  it("keeps a typed name for a company that is not on the platform", async () => {
    const res = await create({ owner: "Paulo", ownerOrgId: null });
    expect(res.error).toBeUndefined();
    const [a] = await assetRows();
    expect(a.ownerOrgId).toBeNull();
    expect(a.owner).toBe("Paulo");
  });

  it("refuses an organization the caller was never offered", async () => {
    // Another operator's client. Linking it would grant them sight of our
    // shelf - by an id nobody on our side could have picked.
    const res = await create({ owner: "Rival Labs", ownerOrgId: OTHERS_CLIENT });
    expect(res.error).toBe("Not found");
    expect(await assetRows()).toHaveLength(0);
  });

  it("does not let a client organization name somebody else as owner", async () => {
    // A client's own entries are theirs; the pick is a house control.
    who = CLIENT_EDITOR;
    const res = await create({ owner: "Sierra Spectra", ownerOrgId: SIERRA });
    expect(res.error).toBeUndefined();
    const [a] = await assetRows();
    expect(a.ownerOrgId).toBe(LABZEN);
  });
});
