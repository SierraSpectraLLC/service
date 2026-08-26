// Recording whose block it is.
//
// The default is the whole feature: "if we are working on a system and block
// it, it's blocked with us" has to be what happens when nobody touches the
// picker, and it has to keep happening when the reason says we are waiting on
// the customer. The picker exists for the minority case where the problem
// really is somebody else's to hold.
//
// Real Postgres, in-process PGlite from the same drizzle/schema-sync.sql every
// deploy applies, because what is being checked is a column default, a guard
// clause and a WHERE - none of which a mocked database would exercise.
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
const LZ_EDITOR: Who = {
  email: "maria@labzen.test", name: "Maria", role: "client_editor",
  orgId: 1, operatorOrgId: 3, rootOperatorOrgId: 3,
};

const BLOCKED = "Waiting / blocked";

/* LZ-001 is Lab Zen's machine, on Sierra Spectra's bench, shared with Lab Zen
   so their editor can work it. Coastal (org 2) has nothing to do with it. */
const RESET = `
  DELETE FROM stage_events; DELETE FROM system_shares; DELETE FROM instruments;
  INSERT INTO instruments (id, external_id, client, model, owner_org_id, tenant_org_id, stages)
    VALUES (1, 'LZ-001', 'Lab Zen', '6495C', 1, 3, '{"Refurbishment"}');
  INSERT INTO system_shares (instrument_id, org_id, access) VALUES (1, 1, 'edit');
`;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES
      (1, 'Lab Zen', 'client', false), (2, 'Coastal Analytical', 'client', false),
      (3, 'Sierra Spectra', 'provider', true);
    SELECT setval('orgs_id_seq', 100);
    -- schema-sync.sql already seeds the built-in vocabulary; it just has to be
    -- stamped into this workspace, because getStageDefs reads by tenant.
    UPDATE stage_defs SET tenant_org_id = 3;
  `);
});

beforeEach(async () => {
  who = null;
  await client.exec(RESET);
});

const row = async () =>
  (await client.query<{ stages: string[]; blocked_reason: string; blocked_org_id: number | null }>(
    `SELECT stages, blocked_reason, blocked_org_id FROM instruments WHERE id = 1`)).rows[0];

const WAITING_ON_THEM = "waiting on Lab Zen to approve the quote for the HED supply";

describe("the default nobody touches", () => {
  it("blocks it with the shop when the shop blocks it", async () => {
    who = BILL;
    const { toggleStage } = await import("@/app/actions");
    expect((await toggleStage(1, BLOCKED, "waiting on the rotor seal")).error).toBeUndefined();
    expect((await row()).blocked_org_id).toBe(3);
  });

  it("KEEPS IT WITH THE SHOP WHEN THE REASON NAMES THE CLIENT", async () => {
    // The trap. "Waiting on Lab Zen" is who we are waiting ON; the machine is
    // still on our bench and the chase is still ours. Nothing in the write
    // path may read the reason to decide this.
    who = BILL;
    const { toggleStage } = await import("@/app/actions");
    await toggleStage(1, BLOCKED, WAITING_ON_THEM);
    const r = await row();
    expect(r.blocked_reason).toBe(WAITING_ON_THEM);
    expect(r.blocked_org_id).toBe(3);
  });

  it("blocks it with the client's own org when the client blocks it", async () => {
    // "Us" is whoever is doing the blocking, not always the shop.
    who = LZ_EDITOR;
    const { toggleStage } = await import("@/app/actions");
    expect((await toggleStage(1, BLOCKED, "our facilities team is moving the bench")).error)
      .toBeUndefined();
    expect((await row()).blocked_org_id).toBe(1);
  });
});

describe("the picker", () => {
  it("puts the block under the organization that was chosen", async () => {
    who = BILL;
    const { toggleStage } = await import("@/app/actions");
    expect((await toggleStage(1, BLOCKED, "their bench, their move", 1)).error).toBeUndefined();
    expect((await row()).blocked_org_id).toBe(1);
  });

  it("refuses an organization with no hold on this system", async () => {
    // Coastal neither works it, owns it, nor has it shared with them. A picker
    // that could name any org would let a block be parked somewhere nobody
    // would ever look, and on a multi-operator instance it would leak the
    // client list as well.
    who = BILL;
    const { toggleStage } = await import("@/app/actions");
    expect((await toggleStage(1, BLOCKED, "parked on a stranger", 2)).error)
      .toMatch(/nothing to do with this system/);
    const r = await row();
    expect(r.stages).not.toContain(BLOCKED);
    expect(r.blocked_org_id).toBeNull();
  });

  it("still demands a reason before it will record a holder", async () => {
    who = BILL;
    const { toggleStage } = await import("@/app/actions");
    const res = await toggleStage(1, BLOCKED, "no", 3);
    expect(res.needsReason).toBe(true);
    expect((await row()).blocked_org_id).toBeNull();
  });
});

describe("re-pointing a block that is already on", () => {
  it("moves the holder without unblocking or losing the date", async () => {
    who = BILL;
    const { toggleStage, setBlockedReason } = await import("@/app/actions");
    await toggleStage(1, BLOCKED, "waiting on the rotor seal");
    const before = (await client.query<{ blocked_since: Date }>(
      `SELECT blocked_since FROM instruments WHERE id = 1`)).rows[0].blocked_since;

    expect((await setBlockedReason(1, "shipped back to them for a facilities fix", 1)).error)
      .toBeUndefined();
    const r = await row();
    expect(r.blocked_org_id).toBe(1);
    expect(r.stages).toContain(BLOCKED);
    const after = (await client.query<{ blocked_since: Date }>(
      `SELECT blocked_since FROM instruments WHERE id = 1`)).rows[0].blocked_since;
    expect(new Date(after).getTime()).toBe(new Date(before).getTime());
  });

  it("leaves the holder alone when only the wording changes", async () => {
    who = BILL;
    const { toggleStage, setBlockedReason } = await import("@/app/actions");
    await toggleStage(1, BLOCKED, "their bench, their move", 1);
    await setBlockedReason(1, "still on their bench, no date yet");
    expect((await row()).blocked_org_id).toBe(1);
  });
});

describe("unblocking", () => {
  it("clears the holder with the reason, so neither outlives the state", async () => {
    who = BILL;
    const { toggleStage } = await import("@/app/actions");
    await toggleStage(1, BLOCKED, "their bench, their move", 1);
    await toggleStage(1, BLOCKED);
    const r = await row();
    expect(r.stages).not.toContain(BLOCKED);
    expect(r.blocked_reason).toBe("");
    expect(r.blocked_org_id).toBeNull();
  });
});
