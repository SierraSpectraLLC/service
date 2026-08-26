// Who may accept four thousand dollars of work, and from where.
//
// A logged-in client used to be handed a link to the PUBLIC share page to
// approve their own quote. That route authorizes by URL possession alone, so a
// client_viewer - read-only in every other corner of this app - could accept
// work by following a link somebody forwarded them, and the signature on the
// record was whatever they typed into a box. If nobody had minted a share link,
// or somebody had revoked one, the same client had no way to approve at all.
//
// This runs against a real Postgres, in-process PGlite seeded from the same
// drizzle/schema-sync.sql every deploy applies, because the guarantees are in
// the WHERE clauses and in the role check - and a test with a stubbed database
// would be checking that my mock refuses rather than that the door does.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });

/**
 * Whoever is signed in for the case under test. Only the SESSION is faked:
 * lib/authz, and therefore the real requireEditor, runs against it - so these
 * tests exercise the actual gate rather than a stand-in for it.
 */
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

const CLIENT_EDITOR: Who = {
  email: "maria@labzen.test", name: "Maria Chen", role: "client_editor",
  orgId: 1, operatorOrgId: null, rootOperatorOrgId: null,
};
const CLIENT_VIEWER: Who = {
  email: "tech@labzen.test", name: "A Tech", role: "client_viewer",
  orgId: 1, operatorOrgId: null, rootOperatorOrgId: null,
};

const RESET = `
  DELETE FROM quote_lines; DELETE FROM share_links; DELETE FROM quotes;
  INSERT INTO quotes (id, org_id, tenant_org_id, number, title, status, sent_on, deposit_pct)
    VALUES (10, 1, 3, 'Q-1001', 'Ion source rebuild', 'sent', '2026-08-01', 0),
           (11, 2, 3, 'Q-1002', 'Column swap',        'sent', '2026-08-01', 0);
  INSERT INTO quote_lines (quote_id, kind, description, qty, unit_cents, covered, position)
    VALUES (10, 'labor', 'Rebuild', 1000, 428000, false, 0),
           (11, 'labor', 'Swap',    1000, 100000, false, 0);
  INSERT INTO share_links (token, kind, org_id, quote_id, expires_on, created_by)
    VALUES ('tok-lab-zen-000001', 'quote', 1, 10, '2099-12-31', 'fixture');
`;

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind) VALUES
      (1, 'Lab Zen', 'client'), (2, 'Coastal Analytical', 'client'), (3, 'Sierra Spectra', 'provider');
  `);
});

beforeEach(async () => {
  who = null;
  await client.exec(RESET);
});

const statusOf = async (id: number) =>
  (await client.query<{ status: string; answered_by: string }>(
    `SELECT status, answered_by FROM quotes WHERE id = ${id}`)).rows[0];

describe("the session door", () => {
  it("lets a client_editor approve their own organization's quote", async () => {
    who = CLIENT_EDITOR;
    const { approveQuoteAsClient } = await import("@/app/actions");
    const res = await approveQuoteAsClient(10, "Maria Chen");
    expect(res.error).toBeUndefined();
    expect(await statusOf(10)).toMatchObject({ status: "approved", answered_by: "Maria Chen" });
  });

  it("REFUSES a client_viewer", async () => {
    // The whole point. Approving work is financial authority; a lab tech who
    // can report a down instrument must not be able to accept the repair.
    who = CLIENT_VIEWER;
    const { approveQuoteAsClient } = await import("@/app/actions");
    const res = await approveQuoteAsClient(10, "A Tech");
    expect(res.error).toMatch(/read-only/i);
    expect((await statusOf(10)).status).toBe("sent");
  });

  it("REFUSES another organization's quote", async () => {
    who = CLIENT_EDITOR;
    const { approveQuoteAsClient } = await import("@/app/actions");
    const res = await approveQuoteAsClient(11, "Maria Chen");
    expect(res.error).toMatch(/not yours/i);
    expect((await statusOf(11)).status).toBe("sent");
  });

  it("refuses a signed-out caller", async () => {
    who = null;
    const { approveQuoteAsClient } = await import("@/app/actions");
    expect((await approveQuoteAsClient(10, "Nobody")).error).toBeTruthy();
    expect((await statusOf(10)).status).toBe("sent");
  });

  it("signs with the account when nothing is typed", async () => {
    who = CLIENT_EDITOR;
    const { approveQuoteAsClient } = await import("@/app/actions");
    await approveQuoteAsClient(10, "   ");
    expect((await statusOf(10)).answered_by).toBe("Maria Chen");
  });

  it("cannot approve the same quote twice", async () => {
    // The idempotency guard lives inside the shared core, so it protects both
    // doors. Move it to a caller and a double submit raises a second deposit.
    who = CLIENT_EDITOR;
    const { approveQuoteAsClient } = await import("@/app/actions");
    expect((await approveQuoteAsClient(10, "Maria Chen")).error).toBeUndefined();
    const second = await approveQuoteAsClient(10, "Maria Chen");
    expect(second.error).toMatch(/cannot be answered/i);
  });

  it("declines with the same authority as approving", async () => {
    who = CLIENT_VIEWER;
    const { declineQuoteAsClient } = await import("@/app/actions");
    expect((await declineQuoteAsClient(10, "A Tech", "no thanks")).error).toMatch(/read-only/i);
    expect((await statusOf(10)).status).toBe("sent");

    who = CLIENT_EDITOR;
    expect((await declineQuoteAsClient(10, "Maria Chen", "too costly")).error).toBeUndefined();
    expect((await statusOf(10)).status).toBe("declined");
  });
});

describe("the token door is unchanged", () => {
  it("still approves through a valid share link", async () => {
    // Somebody emailed a quote and holding no account still has to be able to
    // answer it - that is what the token is for.
    who = null;
    const { approveQuote } = await import("@/app/actions");
    const res = await approveQuote("tok-lab-zen-000001", 10, "Adam Floyd");
    expect(res.error).toBeUndefined();
    expect(await statusOf(10)).toMatchObject({ status: "approved", answered_by: "Adam Floyd" });
  });

  it("still refuses a token pointed at another org's quote", async () => {
    who = null;
    const { approveQuote } = await import("@/app/actions");
    expect((await approveQuote("tok-lab-zen-000001", 11, "Adam Floyd")).error).toMatch(/not valid/i);
    expect((await statusOf(11)).status).toBe("sent");
  });

  it("still refuses a junk token", async () => {
    who = null;
    const { approveQuote } = await import("@/app/actions");
    expect((await approveQuote("short", 10, "X")).error).toBeTruthy();
    expect((await approveQuote("tok-does-not-exist-01", 10, "X")).error).toBeTruthy();
    expect((await statusOf(10)).status).toBe("sent");
  });

  it("still requires a typed signature, having no account to fall back on", async () => {
    who = null;
    const { approveQuote } = await import("@/app/actions");
    expect((await approveQuote("tok-lab-zen-000001", 10, "  ")).error).toMatch(/type your name/i);
    expect((await statusOf(10)).status).toBe("sent");
  });
});

describe("the portal no longer sends a signed-in client out to approve", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("answers the quote in session on the order page", () => {
    const src = read("src/app/orders/q/[id]/page.tsx");
    expect(src).toMatch(/<ClientApprove/);
    expect(src).not.toMatch(/\/share\/\$\{/);
  });

  it("keeps the share bounce only where a hosted page is the point", () => {
    // Payment goes through the processor's hosted page and the invoice
    // document is a printable page; neither is "accept money with no session".
    const list = read("src/app/orders/page.tsx");
    expect(list).not.toMatch(/Review &amp; approve[\s\S]{0,120}\/share\//);
    const inv = read("src/app/orders/i/[id]/page.tsx");
    expect(inv).toMatch(/Pay \{formatCents/);
  });

  it("gates the control on the role rather than on the link existing", () => {
    const src = read("src/components/ClientApprove.tsx");
    expect(src).toMatch(/canApprove/);
    expect(src).toMatch(/approveQuoteAsClient/);
    // No token is passed to it or used by it - the word appears only in the
    // comment explaining what it replaced.
    expect(src).not.toMatch(/\btoken:/);
    expect(src).not.toMatch(/\$\{token\}/);
  });
});
