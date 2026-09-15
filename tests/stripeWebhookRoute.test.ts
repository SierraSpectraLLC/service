// The webhook, end to end against a real Postgres: the signature on the raw
// body, the event-id claim, the account-to-workspace routing, and what each
// event does to the rows and the journal. Only Stripe itself is faked - the
// fee lookup - and the session, for the one-click Record.
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });

const OWNER = { email: "joe@sierra.test", name: "Joe", role: "owner", orgId: null, operatorOrgId: 3, rootOperatorOrgId: 3 };
vi.mock("@/db", () => ({ db: testDb }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: OWNER }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/stripeApi", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripeApi")>()),
  paymentFee: async (pi: string) => (pi === "pi_known" ? 388 : 0),
}));

const SIERRA = 3, LABZEN = 1;
const ACCOUNT = "acct_sierra";
const SECRET = "whsec_test";

const { POST } = await import("@/app/api/stripe/webhook/route");
const money = await import("@/app/money/actions");
const ledger = await import("@/lib/ledger");

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO app_settings (id, client_access_enabled) VALUES (1, true);
    INSERT INTO orgs (name, kind) VALUES
      ('Lab Zen', 'client'), ('Coastal Analytical', 'client'), ('Sierra Spectra', 'provider'), ('Rival Instruments', 'provider');
    UPDATE orgs SET is_operator = true WHERE id IN (3, 4);
    UPDATE orgs SET parent_org_id = 3, terms_days = 30 WHERE id IN (1, 2);
    UPDATE orgs SET stripe_account_id = '${ACCOUNT}', stripe_ready = true, stripe_status = 'connected' WHERE id = 3;
    UPDATE orgs SET stripe_account_id = 'acct_rival', stripe_ready = true WHERE id = 4;
    UPDATE app_settings SET operator_org_id = 3 WHERE id = 1;
    INSERT INTO house_members (email, org_id, role, name) VALUES ('joe@sierra.test', 3, 'owner', 'Joe');
  `);
});
beforeEach(() => { process.env.STRIPE_WEBHOOK_SECRET = SECRET; });

/** A sent invoice with one line, in the workspace given. */
async function sentInvoice(number: string, cents: number, tenant = SIERRA, orgId = LABZEN): Promise<number> {
  const [{ id }] = (await client.query<{ id: number }>(
    `INSERT INTO invoices (tenant_org_id, org_id, number, status, title, issued_on, due_on)
     VALUES (${tenant}, ${orgId}, '${number}', 'sent', 'Test', '2026-09-01', '2026-10-01') RETURNING id`)).rows;
  await client.exec(`INSERT INTO invoice_lines (invoice_id, kind, description, qty, unit_cents, covered, position)
    VALUES (${id}, 'labor', 'Work', 1000, ${cents}, false, 0)`);
  return id;
}
const paymentsOn = (invoiceId: number) => testDb.select().from(schema.payments).then((r) => r.filter((p) => p.invoiceId === invoiceId));
const statusOf = async (invoiceId: number) => (await testDb.select().from(schema.invoices)).find((i) => i.id === invoiceId)!.status;
const shape = (e: { lines: { account: string; debitCents: number; creditCents: number }[] }) =>
  e.lines.map((l) => [l.account, l.debitCents, l.creditCents] as const).sort((a, b) => a[0].localeCompare(b[0]));

let n = 0;
const signed = (event: object, raw = JSON.stringify(event)) => {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex");
  return new Request("http://x/api/stripe/webhook", { method: "POST", body: raw, headers: { "stripe-signature": `t=${t},v1=${v1}` } });
};
const intent = (over: Record<string, unknown>, account = ACCOUNT) => ({
  id: `evt_${++n}`, type: "payment_intent.succeeded", account, created: 1789516800,
  data: { object: { object: "payment_intent", payment_method_types: ["card"], created: 1789516800, ...over } },
});

describe("POST /api/stripe/webhook", () => {
  it("rejects a bad signature before reading the payload, and writes nothing", async () => {
    const event = intent({ id: "pi_forged", amount_received: 100000, metadata: { ridgeline_invoice_id: "1" } });
    const raw = JSON.stringify(event);
    const forged = new Request("http://x/api/stripe/webhook", {
      method: "POST", body: raw, headers: { "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` },
    });
    expect((await POST(forged)).status).toBe(400);
    // A real signature over a different body is just as forged.
    const tampered = new Request("http://x/api/stripe/webhook", {
      method: "POST", body: raw.replace("100000", "1"), headers: signed(event).headers,
    });
    expect((await POST(tampered)).status).toBe(400);
    expect(await testDb.select().from(schema.stripeEvents)).toHaveLength(0);
    expect(await testDb.select().from(schema.payments)).toHaveLength(0);
  });

  it("settles the invoice named on the intent, in the Stripe balance, with the fee as its own row", async () => {
    const id = await sentInvoice("INV-4001", 100000);
    const res = await POST(signed(intent({
      id: "pi_known", amount_received: 100000, metadata: { ridgeline_invoice_id: String(id) },
    })));
    expect(await res.json()).toEqual({ recorded: id });
    const [p] = await paymentsOn(id);
    expect(p).toMatchObject({ amountCents: 100000, method: "card", reference: "pi_known", recordedBy: "stripe", receivedOn: "2026-09-16", tenantOrgId: SIERRA });
    expect(await statusOf(id)).toBe("paid");
    const es = await ledger.timelineFor(SIERRA, "invoice", id);
    expect(es.map(shape)).toEqual([
      [["receivable", 0, 100000], ["stripe", 100000, 0]],
      [["cost_processing", 388, 0], ["stripe", 0, 388]],
    ]);
  });

  it("answers a redelivered event as a duplicate and records nothing twice", async () => {
    const id = await sentInvoice("INV-4002", 50000);
    const event = intent({ id: "pi_twice", amount_received: 50000, metadata: { ridgeline_invoice_id: String(id) } });
    expect(await (await POST(signed(event))).json()).toEqual({ recorded: id });
    expect(await (await POST(signed(event))).json()).toEqual({ duplicate: event.id });
    expect(await paymentsOn(id)).toHaveLength(1);
    // The same money under a NEW event id is caught one layer down, on the reference.
    expect(await (await POST(signed({ ...event, id: "evt_again" }))).json()).toEqual({ recorded: id });
    expect(await paymentsOn(id)).toHaveLength(1);
    expect(await ledger.timelineFor(SIERRA, "invoice", id)).toHaveLength(1);
  });

  it("offers an unknown payment as a suggestion against the one invoice it matches, and Record posts it", async () => {
    const id = await sentInvoice("INV-4003", 84000);
    await sentInvoice("INV-4004", 12000);   // a different balance: not a match
    const res = await POST(signed(intent({ id: "pi_unknown", amount_received: 84000, payment_method_types: ["us_bank_account"] })));
    expect(await res.json()).toEqual({ suggested: expect.any(Number), invoice: "INV-4003" });
    expect(await paymentsOn(id)).toHaveLength(0);
    expect(await statusOf(id)).toBe("sent");
    const [s] = (await testDb.select().from(schema.paymentSuggestions)).filter((x) => x.reference === "pi_unknown");
    expect(s).toMatchObject({ tenantOrgId: SIERRA, invoiceId: id, amountCents: 84000, method: "ach", status: "open", receivedOn: "2026-09-16" });
    expect(s.description).toBe("Stripe payment $840 on Sep 16 matches open invoice INV-4003 for Lab Zen");

    // Delivered again under another event id: still one suggestion.
    await POST(signed(intent({ id: "pi_unknown", amount_received: 84000 })));
    expect((await testDb.select().from(schema.paymentSuggestions)).filter((x) => x.reference === "pi_unknown")).toHaveLength(1);

    // The one click.
    const rec = await money.recordSuggestedPayment(s.id);
    expect(rec).toEqual({ number: "INV-4003" });
    const [p] = await paymentsOn(id);
    expect(p).toMatchObject({ amountCents: 84000, method: "ach", reference: "pi_unknown", recordedBy: "stripe", receivedOn: "2026-09-16" });
    expect(await statusOf(id)).toBe("paid");
    expect(shape((await ledger.timelineFor(SIERRA, "invoice", id))[0])).toEqual([["receivable", 0, 84000], ["stripe", 84000, 0]]);
    const [after] = (await testDb.select().from(schema.paymentSuggestions)).filter((x) => x.id === s.id);
    expect(after).toMatchObject({ status: "recorded", paymentId: p.id });
    expect((await money.recordSuggestedPayment(s.id)).error).toMatch(/already/);
  });

  it("suggests, rather than guesses, when no single invoice matches", async () => {
    await sentInvoice("INV-4005", 30000);
    await sentInvoice("INV-4006", 30000);
    const res = await POST(signed(intent({ id: "pi_two", amount_received: 30000 })));
    expect(await res.json()).toEqual({ suggested: expect.any(Number), invoice: null });
    const [s] = (await testDb.select().from(schema.paymentSuggestions)).filter((x) => x.reference === "pi_two");
    expect(s.invoiceId).toBeNull();
    expect(s.description).toContain("2 open invoices have that balance");
    expect((await money.recordSuggestedPayment(s.id)).error).toMatch(/No single open invoice/);
  });

  it("never settles an invoice in another workspace, whatever the metadata says", async () => {
    const mine = await sentInvoice("INV-4007", 20000);
    const res = await POST(signed(intent({ id: "pi_rival", amount_received: 20000, metadata: { ridgeline_invoice_id: String(mine) } }, "acct_rival")));
    expect(await res.json()).toMatchObject({ reason: expect.stringContaining("not in the workspace") });
    expect(await paymentsOn(mine)).toHaveLength(0);
    // It arrived at Rival's account, so it is Rival's suggestion - and matches nothing of theirs.
    const [s] = (await testDb.select().from(schema.paymentSuggestions)).filter((x) => x.reference === "pi_rival");
    expect(s).toMatchObject({ tenantOrgId: 4, invoiceId: null });
    // An account nobody here owns records nothing at all.
    const stranger = await POST(signed(intent({ id: "pi_stranger", amount_received: 20000 }, "acct_nobody")));
    expect(await stranger.json()).toEqual({ ignored: "no workspace owns that account" });
  });

  it("records a refund as a second row and puts the receivable back", async () => {
    const id = await sentInvoice("INV-4008", 60000);
    await POST(signed(intent({ id: "pi_refunded", amount_received: 60000, metadata: { ridgeline_invoice_id: String(id) } })));
    const refund = (refunded: number, evt: string) => signed({
      id: evt, type: "charge.refunded", account: ACCOUNT, created: 1789603200,
      data: { object: { object: "charge", id: "ch_1", payment_intent: "pi_refunded", amount: 60000, amount_refunded: refunded } },
    });
    expect(await (await POST(refund(25000, "evt_r1"))).json()).toEqual({ refunded: 25000 });
    expect(await (await POST(refund(25000, "evt_r1"))).json()).toEqual({ duplicate: "evt_r1" });
    // Stripe reports the cumulative total: a second partial refund posts only its own delta.
    expect(await (await POST(refund(60000, "evt_r2"))).json()).toEqual({ refunded: 35000 });
    const rows = await paymentsOn(id);
    expect(rows.map((p) => [p.amountCents, p.reference])).toEqual([
      [60000, "pi_refunded"], [-25000, "ch_1:refund:25000"], [-35000, "ch_1:refund:60000"],
    ]);
    expect(await statusOf(id)).toBe("sent");
    const es = await ledger.timelineFor(SIERRA, "invoice", id);
    expect(es.filter((e) => e.memo.startsWith("Refund on ")).map(shape)).toEqual([
      [["receivable", 25000, 0], ["stripe", 0, 25000]],
      [["receivable", 35000, 0], ["stripe", 0, 35000]],
    ]);
    // The invoice here was inserted as sent, never posted, so the journal
    // saw only the payment and its refunds: net nothing.
    expect(await ledger.balanceOf(id, SIERRA)).toBe(0);
  });

  it("posts a payout to the workspace that owns the account, and ignores one nobody owns", async () => {
    const res = await POST(signed({ id: "evt_po", type: "payout.paid", account: ACCOUNT, data: { object: { id: "po_1", amount: 278000, arrival_date: 1789516800 } } }));
    expect(await res.json()).toEqual({ posted: "po_1" });
    const stranger = await POST(signed({ id: "evt_po2", type: "payout.paid", account: "acct_x", data: { object: { id: "po_2", amount: 5 } } }));
    expect(await stranger.json()).toEqual({ ignored: "no workspace owns that account" });
  });

  it("still listens to one event for money in", async () => {
    const res = await POST(signed({ id: "evt_cs", type: "checkout.session.completed", account: ACCOUNT, data: { object: { id: "cs_1", amount_total: 5, metadata: { ridgeline_invoice_id: "1" } } } }));
    expect(await res.json()).toEqual({ ignored: "checkout.session.completed" });
  });
});
