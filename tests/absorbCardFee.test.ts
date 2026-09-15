// A card at face value on one invoice. Against a real Postgres: the toggle
// is an audited, org-scoped write, and startPayment then asks Stripe for
// exactly the balance - card offered whatever the client's policy says, no
// surcharge - while every other invoice keeps the policy. Stripe is faked.
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });

type Who = { email: string; name: string; role: string; orgId: number | null; operatorOrgId: number | null; rootOperatorOrgId: number | null };
const OWNER: Who = { email: "joe@sierra.test", name: "Joe", role: "owner", orgId: null, operatorOrgId: 3, rootOperatorOrgId: 3 };
const RIVAL: Who = { email: "r@rival.test", name: "R", role: "owner", orgId: null, operatorOrgId: 4, rootOperatorOrgId: 3 };
let who: Who = OWNER;
vi.mock("@/db", () => ({ db: testDb }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: who }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Map() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const SIERRA = 3, LABZEN = 1;
const money = await import("@/app/money/actions");
const actions = await import("@/app/actions");

const bodies: URLSearchParams[] = [];
beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO app_settings (id, client_access_enabled, billing_policy) VALUES
      (1, true, '{"cardsEnabled": false, "cardSurchargeBps": 290, "cardSurchargeFlatCents": 30}');
    INSERT INTO orgs (name, kind) VALUES ('Lab Zen', 'client'), ('Coastal', 'client'), ('Sierra Spectra', 'provider'), ('Rival', 'provider');
    UPDATE orgs SET is_operator = true WHERE id IN (3, 4);
    UPDATE orgs SET parent_org_id = 3, terms_days = 30 WHERE id IN (1, 2);
    UPDATE orgs SET stripe_account_id = 'acct_sierra', stripe_ready = true WHERE id = 3;
    UPDATE app_settings SET operator_org_id = 3 WHERE id = 1;
    INSERT INTO house_members (email, org_id, role, name) VALUES ('joe@sierra.test', 3, 'owner', 'Joe');
  `);
});
beforeEach(() => {
  who = OWNER;
  bodies.length = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
    bodies.push(new URLSearchParams(String(init.body ?? "")));
    return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.STRIPE_SECRET_KEY; });

async function sentInvoice(number: string, cents: number, token: string): Promise<number> {
  const [{ id }] = (await client.query<{ id: number }>(
    `INSERT INTO invoices (tenant_org_id, org_id, number, status, title, issued_on, due_on)
     VALUES (${SIERRA}, ${LABZEN}, '${number}', 'sent', 'Test', '2026-09-01', '2026-10-01') RETURNING id`)).rows;
  await client.exec(`INSERT INTO invoice_lines (invoice_id, kind, description, qty, unit_cents, covered, position)
    VALUES (${id}, 'labor', 'Work', 1000, ${cents}, false, 0)`);
  await client.exec(`INSERT INTO share_links (token, kind, org_id, invoice_id, label, expires_on, tenant_org_id, created_by)
    VALUES ('${token}', 'invoice', ${LABZEN}, ${id}, '${number}', '2099-01-01', ${SIERRA}, 'joe@sierra.test')`);
  return id;
}
const rowOf = async (id: number) => (await testDb.select().from(schema.invoices)).find((i) => i.id === id)!;

describe("a card at face value", () => {
  it("is refused with the policy, and asked for at exactly the balance once set", async () => {
    const id = await sentInvoice("INV-5001", 2400000, "tok_face_value_1");
    expect((await actions.startPayment("tok_face_value_1", id, "card")).error).toMatch(/not offered/);

    expect(await money.setAbsorbCardFee(id, true)).toEqual({});
    expect((await rowOf(id)).absorbCardFee).toBe(true);
    const res = await actions.startPayment("tok_face_value_1", id, "card");
    expect(res.url).toBe("https://checkout.stripe.com/c/pay/cs_1");
    expect(bodies).toHaveLength(1);
    expect(bodies[0].get("line_items[0][price_data][unit_amount]")).toBe("2400000");
    expect(bodies[0].get("payment_method_types[0]")).toBe("card");
    expect(bodies[0].get("metadata[ridgeline_invoice_id]")).toBe(String(id));

    const log = (await testDb.select().from(schema.auditLog)).map((a) => a.action);
    expect(log.some((a) => a.includes("take a card at face value"))).toBe(true);
    expect(log.some((a) => a.includes("at face value, fee absorbed"))).toBe(true);
  });

  it("leaves every other invoice on the policy", async () => {
    const id = await sentInvoice("INV-5002", 84000, "tok_face_value_2");
    expect((await actions.startPayment("tok_face_value_2", id, "card")).error).toMatch(/not offered/);
    expect((await actions.startPayment("tok_face_value_2", id, "ach")).url).toBeTruthy();
    expect(bodies[0].get("line_items[0][price_data][unit_amount]")).toBe("84000");
  });

  it("is undone the same way, and is another workspace's business to nobody else", async () => {
    const id = await sentInvoice("INV-5003", 10000, "tok_face_value_3");
    await money.setAbsorbCardFee(id, true);
    who = RIVAL;
    expect((await money.setAbsorbCardFee(id, false)).error).toBe("Not found");
    expect((await rowOf(id)).absorbCardFee).toBe(true);
    who = OWNER;
    expect(await money.setAbsorbCardFee(id, false)).toEqual({});
    expect((await rowOf(id)).absorbCardFee).toBe(false);
  });
});
