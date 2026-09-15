// The webhook's two branches: money in settles an invoice with its fee row,
// a payout posts stripe -> bank. The signature is checked in tests/stripe;
// here the settle functions are faked so the routing itself is under test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const settle = { recordStripePayment: vi.fn(), recordReferralPayment: vi.fn(), recordStripePayout: vi.fn() };
vi.mock("@/lib/stripeSettle", () => settle);
vi.mock("@/lib/stripeApi", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripeApi")>()),
  paymentFee: async (pi: string) => (pi === "pi_1" ? 388 : 0),
}));

const SECRET = "whsec_test";
const signed = (event: object) => {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex");
  return new Request("http://x/api/stripe/webhook", { method: "POST", body: raw, headers: { "stripe-signature": `t=${t},v1=${v1}` } });
};

describe("POST /api/stripe/webhook", () => {
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    for (const f of Object.values(settle)) f.mockReset();
    settle.recordStripePayout.mockResolvedValue({ posted: true });
  });

  it("settles a checkout with the fee Stripe kept", async () => {
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(signed({
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", payment_intent: "pi_1", amount_total: 282000, payment_method_types: ["card"], metadata: { invoiceId: "14" } } },
    }));
    expect(await res.json()).toEqual({ recorded: 14 });
    expect(settle.recordStripePayment).toHaveBeenCalledWith({ invoiceId: 14, amountCents: 282000, reference: "pi_1", method: "card", feeCents: 388 });
  });

  it("posts a payout to the workspace that owns the account", async () => {
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(signed({
      type: "payout.paid", account: "acct_9",
      data: { object: { id: "po_1", amount: 278000, arrival_date: 1789516800 } },
    }));
    expect(await res.json()).toEqual({ posted: "po_1" });
    expect(settle.recordStripePayout).toHaveBeenCalledWith({ account: "acct_9", payoutId: "po_1", amountCents: 278000, arrivalDate: "2026-09-16" });
  });

  it("ignores a payout nobody here owns rather than posting it anywhere", async () => {
    settle.recordStripePayout.mockResolvedValue({ posted: false, reason: "no workspace owns that account" });
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(signed({ type: "payout.paid", account: "acct_x", data: { object: { id: "po_2", amount: 5 } } }));
    expect(await res.json()).toEqual({ ignored: "no workspace owns that account" });
  });

  it("still listens to one event for money in", async () => {
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(signed({ type: "payment_intent.succeeded", data: { object: { id: "pi_2", amount: 5 } } }));
    expect(await res.json()).toEqual({ ignored: "payment_intent.succeeded" });
    expect(settle.recordStripePayment).not.toHaveBeenCalled();
  });
});
