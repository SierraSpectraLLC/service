// The calls that actually talk to Stripe, and the one that decides whether a
// webhook is really from them.
//
// SERVER ONLY. Split from lib/stripe so the pure half - mode, surcharge
// arithmetic - can be imported by the client portal; this half reaches
// node:crypto and would not build in a browser bundle. The reasoning about
// Connect, custody of funds and card data lives in lib/stripe, which is worth
// reading before trusting either file with money.
//
// ONE KEY, MANY ACCOUNTS. Every request goes out under the PLATFORM's secret
// key, and the connected account it concerns rides in the `Stripe-Account`
// header. That is how Connect works for an account the operator authorized
// through OAuth (api/stripe/oauth/callback): the platform never holds the
// operator's own key, and a request without the header would land on the
// platform's balance instead of theirs.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { platformFee, type PayMethod } from "@/lib/stripe";

const API = "https://api.stripe.com/v1";
const CONNECT = "https://connect.stripe.com";

const platformKey = (): string => (process.env.STRIPE_SECRET_KEY ?? "").trim();

/**
 * Headers for one request: the platform key, and the connected account when
 * the request is about one. Keeping this in one place is what makes "every
 * call carries the header" a fact rather than a habit.
 */
function stripeHeaders(account?: string): Record<string, string> {
  const key = platformKey();
  if (!key) throw new Error("Stripe is not configured on this instance.");
  const h: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (account) h["Stripe-Account"] = account;
  return h;
}

async function call(path: string, body: Record<string, string>, account?: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { ...stripeHeaders(account), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } })?.error?.message ?? "Stripe rejected the request";
    throw new Error(msg);
  }
  return json as Record<string, unknown>;
}

/**
 * What Stripe kept of a payment, in cents. Read off the charge's balance
 * transaction, which is the only place the fee is a fact rather than an
 * estimate. Zero when the charge has not settled to a balance transaction
 * yet or the lookup fails: a missing fee row is a parity finding, a wrong one
 * is a lie in the books.
 *
 * The payment lives on the CONNECTED account - a direct charge - so the read
 * has to say whose it is; asked without the header, Stripe has never heard of
 * the intent.
 */
export async function paymentFee(paymentIntentId: string, account: string): Promise<number> {
  if (!platformKey() || !paymentIntentId || !account) return 0;
  const res = await fetch(`${API}/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge.balance_transaction`, {
    headers: stripeHeaders(account),
  });
  if (!res.ok) return 0;
  const pi = await res.json() as { latest_charge?: { balance_transaction?: { fee?: number } | string } | string };
  const charge = pi.latest_charge;
  if (!charge || typeof charge === "string") return 0;
  const bt = charge.balance_transaction;
  if (!bt || typeof bt === "string") return 0;
  return Math.max(0, Math.round(Number(bt.fee ?? 0)));
}

// ── Connect OAuth ──────────────────────────────────────────────────────────
//
// The operator authorizes this platform on Stripe's site and comes back with a
// code; the code is spent once at Stripe for the account id. Nothing of theirs
// is stored but that id - the platform key plus the header is what every later
// call uses, so there is no access token to keep and none to leak.

/** The platform's Connect client id (`ca_...`), from Connect > Settings. */
export const stripeClientId = (): string => (process.env.STRIPE_CLIENT_ID ?? "").trim();

/**
 * Where the "Connect with Stripe" button sends somebody.
 *
 * `redirect_uri` must be one Stripe has been told about - both the apex and
 * the www host are registered, and the caller passes whichever it is on, so
 * the person lands back on the same origin they left.
 */
export function connectAuthorizeUrl(input: { redirectUri: string; state: string; email?: string }): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: stripeClientId(),
    scope: "read_write",
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  if (input.email) q.set("stripe_user[email]", input.email);
  return `${CONNECT}/oauth/authorize?${q.toString()}`;
}

/**
 * The OAuth state: which workspace started this, signed so the callback can
 * believe it.
 *
 * Signed rather than stored because it has to survive a trip through Stripe's
 * site and, when the session lapsed in between, a sign-in - a cookie would
 * die with the session and a table row is litter for every abandoned attempt.
 * The workspace id is what stops a code started by one owner being finished
 * on another's org; the nonce is what makes two attempts different; the
 * timestamp is what stops a captured one being replayed next month.
 */
const STATE_TTL_SEC = 2 * 60 * 60;

function stateKey(): string {
  const k = (process.env.AUTH_SECRET ?? "").trim();
  if (!k) throw new Error("AUTH_SECRET is not set");
  return k;
}

export function signConnectState(orgId: number, nowSec = Math.floor(Date.now() / 1000)): string {
  const body = `${orgId}.${nowSec}.${randomBytes(12).toString("base64url")}`;
  const mac = createHmac("sha256", stateKey()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/** The workspace a state names, or null when it is forged, tampered or old. */
export function readConnectState(
  state: string, nowSec = Math.floor(Date.now() / 1000), ttlSec = STATE_TTL_SEC,
): { orgId: number } | null {
  const parts = (state ?? "").split(".");
  if (parts.length !== 4) return null;
  const [org, issued, nonce, mac] = parts;
  const expected = createHmac("sha256", stateKey()).update(`${org}.${issued}.${nonce}`).digest("base64url");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(mac, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const orgId = parseInt(org, 10);
  const at = parseInt(issued, 10);
  if (!Number.isInteger(orgId) || orgId <= 0 || !Number.isFinite(at)) return null;
  if (nowSec - at > ttlSec || at - nowSec > 60) return null;
  return { orgId };
}

/**
 * Spend the code Stripe sent back for the account it stands for.
 *
 * The client secret IS the platform's secret key - that is how Stripe's OAuth
 * is shaped - and the exchange goes to connect.stripe.com rather than the API
 * host. Stripe's own error_description comes back in the thrown message: a
 * code used twice or issued to another platform says exactly that, and the
 * owner reading the page can act on it.
 */
export async function exchangeConnectCode(code: string): Promise<{ stripeUserId: string; livemode: boolean }> {
  const key = platformKey();
  if (!key) throw new Error("Stripe is not configured on this instance.");
  if (!code) throw new Error("Stripe sent no authorization code.");
  const res = await fetch(`${CONNECT}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_secret: key, code, grant_type: "authorization_code" }).toString(),
  });
  const json = await res.json().catch(() => ({})) as {
    stripe_user_id?: string; livemode?: boolean; error?: string; error_description?: string;
  };
  if (!res.ok || !json.stripe_user_id) {
    throw new Error(json.error_description ?? json.error ?? "Stripe did not accept the authorization code.");
  }
  return { stripeUserId: String(json.stripe_user_id), livemode: Boolean(json.livemode) };
}

/**
 * Whether Stripe has finished its checks and the account may be paid into.
 * Asked AS the account - `/v1/account` under the header - which is the same
 * question the connected account's own dashboard answers.
 */
export async function accountReady(accountId: string): Promise<boolean> {
  if (!platformKey() || !accountId) return false;
  const res = await fetch(`${API}/account`, { headers: stripeHeaders(accountId) });
  if (!res.ok) return false;
  const acct = await res.json() as { charges_enabled?: boolean; payouts_enabled?: boolean };
  return Boolean(acct.charges_enabled && acct.payouts_enabled);
}

/**
 * One checkout, for the two things this app takes money for.
 *
 * Created ON the operator's account - a direct charge, the request sent under
 * their `Stripe-Account` - so the money lands in their balance and the
 * processing fee is theirs; the application fee is the platform's cut and is
 * zero unless an instance has set one. `ref` is what the webhook matches the
 * payment back to, and it is a key and an id rather than an invoice id
 * because a referral fee between two service companies is not an invoice - it
 * moves the same way and settles a different row. Both go on the SESSION and
 * the PAYMENT INTENT: Stripe hands back whichever it feels like, and a payment
 * nobody can attribute is worse than a payment that failed.
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
  if (!input.accountId) throw new Error("No connected Stripe account to charge on.");
  const fee = platformFee(input.amountCents, input.platformFeeBps);
  const body: Record<string, string> = {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(input.amountCents),
    "line_items[0][price_data][product_data][name]": input.ref.label,
    "payment_method_types[0]": input.method === "ach" ? "us_bank_account" : "card",
    [`metadata[${input.ref.key}]`]: String(input.ref.id),
    [`payment_intent_data[metadata][${input.ref.key}]`]: String(input.ref.id),
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  };
  // The invoice's id under the name the webhook looks for, on the session
  // and on the payment intent both: payment_intent.succeeded is what settles
  // it, and an intent that arrives with nothing on it becomes a suggestion
  // somebody has to match by hand.
  if (input.ref.key === "invoiceId") {
    body["metadata[ridgeline_invoice_id]"] = String(input.ref.id);
    body["payment_intent_data[metadata][ridgeline_invoice_id]"] = String(input.ref.id);
  }
  if (fee > 0) body["payment_intent_data[application_fee_amount]"] = String(fee);
  if (input.customerEmail) body.customer_email = input.customerEmail;
  const session = await call("/checkout/sessions", body, input.accountId);
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
