// Sending somebody's invitation again, with a password that works.
//
// The invitation that matters is rarely the first one - a typo in an address,
// a first email in quarantine, somebody starting three months after they were
// added. Until now the only way to send another was to REMOVE the person and
// add them back, which threw away everything set on their row to get one
// email out.
//
// Two things about the password are forced rather than chosen. It is minted
// fresh, because the stored one is a scrypt hash and there is no plaintext
// left to resend. And it goes in the email, which is a live credential in an
// inbox - deliberate, bounded by the expiry, and the reason this action is
// separate from setClientTempPassword rather than folded into it.
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

/** Every invitation this test sent, in order. */
const sent: Array<Record<string, unknown>> = [];

vi.mock("@/db", () => ({ db: testDb }));
vi.mock("@/auth", () => ({ auth: async () => (who ? { user: who } : null) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));
/** Flip to make the mail server refuse, as a real one does on a bad key. */
let deliverable = true;

vi.mock("@/lib/notify", () => ({
  notifyTaskAssigned: async () => {},
  notifyInvite: async (o: Record<string, unknown>) => { sent.push(o); return deliverable; },
}));

const OWNER: Who = {
  email: "dev@sierra.test", name: "Dev", role: "owner",
  orgId: 3, operatorOrgId: 3, rootOperatorOrgId: 3,
};

const RESET = `
  DELETE FROM client_allowlist; DELETE FROM users; DELETE FROM audit_log;
  INSERT INTO client_allowlist (id, entry, org_id) VALUES
    (1, 'thomas@labzen.test', 1),
    (2, '@labzen.test', 1);
`;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator, parent_org_id) VALUES
      (1, 'Lab Zen', 'client', false, 3),
      (3, 'Sierra Spectra', 'provider', true, NULL),
      (99, 'Rival Instruments', 'provider', true, 3);
    SELECT setval('orgs_id_seq', 200);
  `);
});

beforeEach(async () => {
  who = null;
  deliverable = true;
  sent.length = 0;
  await client.exec(RESET);
});

const userRow = async () => (await client.query<{
  id: string; password_hash: string; password_temp_until: string | null;
}>(`SELECT id, password_hash, password_temp_until FROM users WHERE email = 'thomas@labzen.test'`)).rows[0];

describe("sending it again", () => {
  it("SENDS THE INVITATION AND MINTS A PASSWORD TO GO IN IT", async () => {
    who = OWNER;
    const { resendInvite } = await import("@/app/actions");
    const res = await resendInvite(1);
    expect(res.error).toBeUndefined();
    expect(res.password).toMatch(/^[a-z]+-[a-z]+-[a-z]+-\d{4}$/);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("thomas@labzen.test");
  });

  it("PUTS THE PASSWORD IN THE EMAIL, not just a note that one exists", async () => {
    /* The whole point of the resend: they were stuck, and a phone call to
       finish the job is the same stall the resend is meant to end. */
    who = OWNER;
    const { resendInvite } = await import("@/app/actions");
    const res = await resendInvite(1);
    expect(sent[0].tempPasswordPlain).toBe(res.password);
    expect(sent[0].tempExpiresOn).toBe(res.expiresOn);
  });

  it("hands the same password back to the operator to read out as well", async () => {
    // Belt and braces: the email may be the thing that is broken.
    who = OWNER;
    const { resendInvite } = await import("@/app/actions");
    const res = await resendInvite(1);
    expect(res.password).toBeTruthy();
    expect(res.expiresOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("MINTS A FRESH ONE EVERY TIME - there is no stored plaintext to resend", async () => {
    /* The hash is one-way, so "resend their password" is not a thing that can
       be done. Two resends must produce two different passwords, and the
       second must invalidate the first. */
    who = OWNER;
    const { resendInvite } = await import("@/app/actions");
    const first = await resendInvite(1);
    const hashOne = (await userRow()).password_hash;
    const second = await resendInvite(1);
    const hashTwo = (await userRow()).password_hash;
    expect(second.password).not.toBe(first.password);
    expect(hashTwo).not.toBe(hashOne);
    expect(hashTwo).toBeTruthy();
  });

  it("stamps an expiry rather than a permanent password", async () => {
    who = OWNER;
    const { resendInvite } = await import("@/app/actions");
    await resendInvite(1);
    expect((await userRow()).password_temp_until).toBeTruthy();
  });

  it("makes the account row for somebody who never signed in", async () => {
    // Approved months ago, never once got in - which is exactly who needs a
    // resend. A password needs a row to hang on.
    who = OWNER;
    expect(await userRow()).toBeUndefined();
    const { resendInvite } = await import("@/app/actions");
    expect((await resendInvite(1)).error).toBeUndefined();
    expect(await userRow()).toBeTruthy();
  });

  it("writes an audit line saying an invitation went out, and when it lapses", async () => {
    who = OWNER;
    const { resendInvite } = await import("@/app/actions");
    const res = await resendInvite(1);
    const log = (await client.query<{ action: string }>(
      `SELECT action FROM audit_log ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(log?.action).toMatch(/resent thomas@labzen\.test's invitation/);
    expect(log?.action).toContain(res.expiresOn!);
    // And never the password itself.
    expect(log?.action).not.toContain(res.password!);
  });
});

describe("who and what it refuses", () => {
  it("REFUSES A WHOLE-DOMAIN ENTRY - there is no mailbox to send to", async () => {
    /* "@labzen.test" covers everybody at that company. Resending it would
       either mail nobody or, worse, mint a password against a made-up row. */
    who = OWNER;
    const { resendInvite } = await import("@/app/actions");
    expect((await resendInvite(2)).error).toMatch(/whole domain/);
    expect(sent).toEqual([]);
  });

  it("refuses somebody with no admin hold on that organization", async () => {
    who = { ...OWNER, email: "other@rival.test", role: "staff",
      orgId: 99, operatorOrgId: 99, rootOperatorOrgId: 3 };
    const { resendInvite } = await import("@/app/actions");
    expect((await resendInvite(1)).error).toBe("Not found");
    expect(sent).toEqual([]);
  });

  it("refuses a row that does not exist", async () => {
    who = OWNER;
    const { resendInvite } = await import("@/app/actions");
    expect((await resendInvite(9999)).error).toBe("Not found");
    expect(sent).toEqual([]);
  });

  it("sends nothing to a client's own editor - a credential is the shop's call", async () => {
    who = { email: "thomas@labzen.test", name: "Thomas", role: "client_editor",
      orgId: 1, operatorOrgId: 3, rootOperatorOrgId: 3 };
    const { resendInvite } = await import("@/app/actions");
    await expect(resendInvite(1)).rejects.toThrow();
    expect(sent).toEqual([]);
  });
});

describe("when the email does not go out", () => {
  /* The trap this feature walks into. A resend mints a password, which
     INVALIDATES the one they had; if the send then fails silently, the person
     who could not get in a minute ago now cannot get in with the password they
     were already holding, and the operator has been told it worked. */

  it("SAYS SO, rather than reporting a send that did not happen", async () => {
    who = OWNER;
    deliverable = false;
    const { resendInvite } = await import("@/app/actions");
    const res = await resendInvite(1);
    expect(res.error).toBeUndefined();
    expect(res.mailed).toBe(false);
  });

  it("still hands back the password, because it is already set", async () => {
    // The mint succeeded and the old password is already dead. Withholding it
    // would be a second failure on top of the first - the phone call is now
    // the only way in, and this is the only copy.
    who = OWNER;
    deliverable = false;
    const { resendInvite } = await import("@/app/actions");
    const res = await resendInvite(1);
    expect(res.password).toMatch(/^[a-z]+-[a-z]+-[a-z]+-\d{4}$/);
    expect((await userRow()).password_hash).toBeTruthy();
  });

  it("records the truth in the audit line", async () => {
    who = OWNER;
    deliverable = false;
    const { resendInvite } = await import("@/app/actions");
    await resendInvite(1);
    const log = (await client.query<{ action: string }>(
      `SELECT action FROM audit_log ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(log?.action).toMatch(/did NOT go out/);
    expect(log?.action).not.toMatch(/resent .* invitation with/);
  });

  it("reports a clean send as mailed", async () => {
    who = OWNER;
    const { resendInvite } = await import("@/app/actions");
    expect((await resendInvite(1)).mailed).toBe(true);
  });
});
