// Connect OAuth, the half without a browser: the code is exchanged at
// connect.stripe.com under the platform key, the state that rides through
// Stripe's site is signed and checked, the origin somebody is sent back to is
// one of ours, and every call about a connected account carries its id in the
// Stripe-Account header. fetch is faked; nothing here reaches Stripe.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectOrigin } from "@/lib/stripe";
import {
  accountReady, checkoutSession, connectAuthorizeUrl, exchangeConnectCode, readConnectState, signConnectState,
} from "@/lib/stripeApi";
import { safeNext } from "@/lib/loginNext";

type Call = { url: string; init: RequestInit };
const calls: Call[] = [];
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let answer: (c: Call) => Response;

// The keys are set per test and put back after: another suite in the same
// worker reads "absent" off an unset key, and must go on reading it.
const saved = { key: process.env.STRIPE_SECRET_KEY, client: process.env.STRIPE_CLIENT_ID };
beforeEach(() => {
  calls.length = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_platform";
  process.env.STRIPE_CLIENT_ID = "ca_platform";
  answer = () => reply(200, {});
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), init };
    calls.push(c);
    return answer(c);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (saved.key === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = saved.key;
  if (saved.client === undefined) delete process.env.STRIPE_CLIENT_ID; else process.env.STRIPE_CLIENT_ID = saved.client;
});

const bodyOf = (c: Call) => new URLSearchParams(String(c.init.body ?? ""));
const headersOf = (c: Call) => c.init.headers as Record<string, string>;

describe("exchangeConnectCode", () => {
  it("spends the code at connect.stripe.com under the platform key and returns the account", async () => {
    answer = () => reply(200, { stripe_user_id: "acct_operator", livemode: false, scope: "read_write" });
    const got = await exchangeConnectCode("ac_code");
    expect(got).toEqual({ stripeUserId: "acct_operator", livemode: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://connect.stripe.com/oauth/token");
    expect(calls[0].init.method).toBe("POST");
    const body = bodyOf(calls[0]);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("ac_code");
    expect(body.get("client_secret")).toBe("sk_test_platform");
    // The token endpoint takes the key as a form field, not as a bearer.
    expect(headersOf(calls[0]).Authorization).toBeUndefined();
  });

  it("surfaces Stripe's own reason when the code is refused", async () => {
    answer = () => reply(400, { error: "invalid_grant", error_description: "This authorization code has already been used." });
    await expect(exchangeConnectCode("ac_used")).rejects.toThrow("already been used");
  });

  it("refuses to send anything without a code or a key", async () => {
    await expect(exchangeConnectCode("")).rejects.toThrow("no authorization code");
    process.env.STRIPE_SECRET_KEY = "";
    await expect(exchangeConnectCode("ac_x")).rejects.toThrow("not configured");
    expect(calls).toHaveLength(0);
  });
});

describe("the signed state", () => {
  it("names the workspace that started it, and only to this instance", () => {
    const s = signConnectState(42, 1_700_000_000);
    expect(readConnectState(s, 1_700_000_100)).toEqual({ orgId: 42 });
    // Two starts are two states, so one cannot stand in for the other.
    expect(signConnectState(42, 1_700_000_000)).not.toBe(s);
  });

  it("rejects a tampered workspace, a forged signature and an old one", () => {
    const s = signConnectState(42, 1_700_000_000);
    const [, issued, nonce, mac] = s.split(".");
    expect(readConnectState(`43.${issued}.${nonce}.${mac}`, 1_700_000_100)).toBeNull();
    expect(readConnectState(`42.${issued}.${nonce}.${"A".repeat(mac.length)}`, 1_700_000_100)).toBeNull();
    expect(readConnectState(s, 1_700_000_000 + 3 * 3600)).toBeNull();
    expect(readConnectState("", 1_700_000_100)).toBeNull();
    expect(readConnectState("nonsense", 1_700_000_100)).toBeNull();
  });
});

describe("connectAuthorizeUrl", () => {
  it("sends the owner to Stripe with the client id, the state and the way back", () => {
    const u = new URL(connectAuthorizeUrl({
      redirectUri: "https://www.ridgelinefield.com/api/stripe/oauth/callback", state: "st", email: "o@x.com",
    }));
    expect(u.origin + u.pathname).toBe("https://connect.stripe.com/oauth/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("ca_platform");
    expect(u.searchParams.get("scope")).toBe("read_write");
    expect(u.searchParams.get("redirect_uri")).toBe("https://www.ridgelinefield.com/api/stripe/oauth/callback");
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("stripe_user[email]")).toBe("o@x.com");
  });
});

describe("connectOrigin", () => {
  const app = "https://ridgelinefield.com";
  it("keeps the person on the apex or the www host, whichever they were on", () => {
    expect(connectOrigin("https://ridgelinefield.com", app)).toBe("https://ridgelinefield.com");
    expect(connectOrigin("https://www.ridgelinefield.com", app)).toBe("https://www.ridgelinefield.com");
    expect(connectOrigin("https://WWW.RidgelineField.com/settings", app)).toBe("https://www.ridgelinefield.com");
    // The twin works from either side of APP_URL.
    expect(connectOrigin("https://ridgelinefield.com", "https://www.ridgelinefield.com/")).toBe("https://ridgelinefield.com");
  });
  it("falls back to APP_URL for any host that is not ours", () => {
    expect(connectOrigin("https://evil.example.com", app)).toBe(app);
    expect(connectOrigin("http://ridgelinefield.com", app)).toBe(app);
    expect(connectOrigin("not a url", app)).toBe(app);
    expect(connectOrigin("", app)).toBe(app);
  });
  it("lets a local dev server be itself", () => {
    expect(connectOrigin("http://localhost:3000", app)).toBe("http://localhost:3000");
  });
});

describe("calls about a connected account", () => {
  it("creates the checkout ON the operator's account, as a direct charge", async () => {
    answer = () => reply(200, { url: "https://checkout.stripe.com/c/pay/cs_1" });
    const url = await checkoutSession({
      accountId: "acct_operator", ref: { key: "invoiceId", id: 14, label: "Invoice INV-14" },
      amountCents: 84000, method: "ach", platformFeeBps: 25,
      successUrl: "https://ridgelinefield.com/share/t?paid=1", cancelUrl: "https://ridgelinefield.com/share/t",
    });
    expect(url).toBe("https://checkout.stripe.com/c/pay/cs_1");
    expect(calls[0].url).toBe("https://api.stripe.com/v1/checkout/sessions");
    const h = headersOf(calls[0]);
    expect(h.Authorization).toBe("Bearer sk_test_platform");
    expect(h["Stripe-Account"]).toBe("acct_operator");
    const body = bodyOf(calls[0]);
    expect(body.get("payment_intent_data[application_fee_amount]")).toBe("210");
    expect(body.get("metadata[invoiceId]")).toBe("14");
    // Destination-charge fields would be refused on a request made as the account.
    expect(body.has("payment_intent_data[on_behalf_of]")).toBe(false);
    expect(body.has("payment_intent_data[transfer_data][destination]")).toBe(false);
  });

  it("asks the account itself whether it may be paid into", async () => {
    answer = () => reply(200, { charges_enabled: true, payouts_enabled: true });
    expect(await accountReady("acct_operator")).toBe(true);
    expect(calls[0].url).toBe("https://api.stripe.com/v1/account");
    expect(headersOf(calls[0])["Stripe-Account"]).toBe("acct_operator");
    answer = () => reply(200, { charges_enabled: true, payouts_enabled: false });
    expect(await accountReady("acct_operator")).toBe(false);
    expect(await accountReady("")).toBe(false);
  });
});

describe("safeNext", () => {
  it("allows a path on this site and nothing that leaves it", () => {
    expect(safeNext("/api/stripe/oauth/callback?code=ac_1&state=s")).toBe("/api/stripe/oauth/callback?code=ac_1&state=s");
    expect(safeNext("https://evil.example.com/")).toBe("");
    expect(safeNext("//evil.example.com/")).toBe("");
    expect(safeNext("/\\evil.example.com")).toBe("");
    expect(safeNext(undefined)).toBe("");
  });
});
