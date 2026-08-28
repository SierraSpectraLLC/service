// The calls that actually talk to Stripe, and the one that decides whether a
// webhook is really from them.
//
// SERVER ONLY. Split from lib/stripe so the pure half - mode, surcharge
// arithmetic - can be imported by the client portal; this half reaches
// node:crypto and would not build in a browser bundle. The reasoning about
// Connect, custody of funds and card data lives in lib/stripe, which is worth
// reading before trusting either file with money.

import { createHmac, timingSafeEqual } from "node:crypto";
import { platformFee, type PayMethod } from "@/lib/stripe";

const API = "https://api.stripe.com/v1";

async function call(path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const key = (process.env.STRIPE_SECRET_KEY ?? "").trim();
  if (!key) throw new Error("Stripe is not configured on this instance.");
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } })?.error?.message ?? "Stripe rejected the request";
    throw new Error(msg);
  }
  return json as Record<string, unknown>;
}

/** Start Connect onboarding for the operator. Express: Stripe does the KYB. */
export async function createConnectAccount(email: string): Promise<string> {
  const acct = await call("/accounts", {
    type: "express",
    email,
    "capabilities[transfers][requested]": "true",
    "capabilities[us_bank_account_ach_payments][requested]": "true",
    "capabilities[card_payments][requested]": "true",
  });
  return String(acct.id);
}

export async function onboardingLink(accountId: string, returnUrl: string): Promise<string> {
  const link = await call("/account_links", {
    account: accountId,
    refresh_url: returnUrl,
    return_url: returnUrl,
    type: "account_onboarding",
  });
  return String(link.url);
}

/** Whether Stripe has finished its checks and the account may be paid into. */
export async function accountReady(accountId: string): Promise<boolean> {
  const key = (process.env.STRIPE_SECRET_KEY ?? "").trim();
  if (!key || !accountId) return false;
  const res = await fetch(`${API}/accounts/${accountId}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return false;
  const acct = await res.json() as { charges_enabled?: boolean; payouts_enabled?: boolean };
  return Boolean(acct.charges_enabled && acct.payouts_enabled);
}

/**
 * The hosted page the client actually pays on.
 *
 * `on_behalf_of` and the destination transfer put the money in the operator's
 * account; the application fee is the platform's cut and is zero unless an
 * instance has set one. The invoice id rides in metadata, because the webhook
 * needs to know which bill was just paid and a client-supplied field is not a
 * thing to trust with that.
 */
/**
 * One checkout, for the two things this app takes money for.
 *
 * `ref` is what the webhook matches the payment back to, and it is a key and
 * an id rather than an invoice id because a referral fee between two service
 * companies is not an invoice - it moves the same way and settles a different
 * row. Both go on the SESSION and the PAYMENT INTENT: Stripe hands back
 * whichever it feels like, and a payment nobody can attribute is worse than a
 * payment that failed.
 */
export type PayRef = { key: "invoiceId" | "referralFeeId"; id: number; label: string };

export async function checkoutSession(input: {
  accountId: string;
  ref: PayRef;
  amountCents: number;
  method: PayMethod;
  platformFeeBps: number;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
}): Promise<string> {
  const fee = platformFee(input.amountCents, input.platformFeeBps);
  const body: Record<string, string> = {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(input.amountCents),
    "line_items[0][price_data][product_data][name]": input.ref.label,
    "payment_method_types[0]": input.method === "ach" ? "us_bank_account" : "card",
    "payment_intent_data[on_behalf_of]": input.accountId,
    "payment_intent_data[transfer_data][destination]": input.accountId,
    [`metadata[${input.ref.key}]`]: String(input.ref.id),
    [`payment_intent_data[metadata][${input.ref.key}]`]: String(input.ref.id),
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  };
  if (fee > 0) body["payment_intent_data[application_fee_amount]"] = String(fee);
  if (input.customerEmail) body.customer_email = input.customerEmail;
  const session = await call("/checkout/sessions", body);
  return String(session.url);
}

/**
 * Verify a webhook came from Stripe.
 *
 * Written out rather than pulled from the SDK because it is four lines of
 * HMAC and one comparison, and because an unverified webhook endpoint is an
 * open door that marks anybody's invoice paid. The timestamp check is what
 * stops a captured payload being replayed a month later.
 */
export function verifyWebhook(
  payload: string, header: string, secret: string, toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!payload || !header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=").map((x) => x.trim()) as [string, string]),
  );
  const t = parseInt(parts.t ?? "", 10);
  const sig = parts.v1 ?? "";
  if (!Number.isFinite(t) || !sig) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;

  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
