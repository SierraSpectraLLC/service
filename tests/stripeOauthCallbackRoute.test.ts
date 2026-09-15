// Stripe sends the owner back here with a code. The gates in order: signed in
// (else sign in and come straight back, code and all), an owner, a state this
// instance signed for their workspace - and only then is the code spent and
// the account id written to that org. The exchange itself is under test in
// tests/stripeConnect; here it is faked so the routing is what is tested.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const who = { user: null as null | { email: string; role: string; operatorOrgId: number | null; rootOperatorOrgId: number | null } };
vi.mock("@/lib/authz", () => ({
  currentUser: async () => who.user,
  myTenantOrgId: (u: { operatorOrgId: number | null; rootOperatorOrgId: number | null }) => u.operatorOrgId ?? u.rootOperatorOrgId,
}));

const org = { id: 7, name: "Cascade Instrument Service", stripeAccountId: "" };
const written: Record<string, unknown> = {};
vi.mock("@/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [org] }) }),
    update: () => ({ set: (patch: Record<string, unknown>) => ({ where: async () => { Object.assign(written, patch); } }) }),
  },
}));

const audits: string[] = [];
vi.mock("@/lib/audit", () => ({ audit: async (e: { action: string }) => { audits.push(e.action); } }));

const stripe = { exchangeConnectCode: vi.fn(), accountReady: vi.fn() };
vi.mock("@/lib/stripeApi", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripeApi")>()),
  exchangeConnectCode: (code: string) => stripe.exchangeConnectCode(code),
  accountReady: (id: string) => stripe.accountReady(id),
}));

const owner = { email: "owner@cascade.example", role: "owner", operatorOrgId: 7, rootOperatorOrgId: 7 };

const get = (query: string, host = "www.ridgelinefield.com") =>
  new Request(`https://${host}/api/stripe/oauth/callback${query}`, {
    headers: { "x-forwarded-host": host, "x-forwarded-proto": "https" },
  });

describe("GET /api/stripe/oauth/callback", () => {
  const saved = { app: process.env.APP_URL, key: process.env.STRIPE_SECRET_KEY };
  afterAll(() => {
    if (saved.app === undefined) delete process.env.APP_URL; else process.env.APP_URL = saved.app;
    if (saved.key === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = saved.key;
  });
  beforeEach(() => {
    process.env.APP_URL = "https://ridgelinefield.com";
    process.env.STRIPE_SECRET_KEY = "sk_test_platform";
    who.user = null;
    for (const k of Object.keys(written)) delete written[k];
    audits.length = 0;
    stripe.exchangeConnectCode.mockReset().mockResolvedValue({ stripeUserId: "acct_operator", livemode: false });
    stripe.accountReady.mockReset().mockResolvedValue(true);
  });

  it("sends a stranger to sign in and straight back here, on the host they arrived on", async () => {
    const { GET } = await import("@/app/api/stripe/oauth/callback/route");
    const res = await GET(get("?code=ac_1&state=st"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location"))
      .toBe("https://www.ridgelinefield.com/login?next=" + encodeURIComponent("/api/stripe/oauth/callback?code=ac_1&state=st"));
    expect(stripe.exchangeConnectCode).not.toHaveBeenCalled();
  });

  it("connects the owner's workspace and says so", async () => {
    who.user = owner;
    const { signConnectState } = await import("@/lib/stripeApi");
    const { GET } = await import("@/app/api/stripe/oauth/callback/route");
    const res = await GET(get(`?code=ac_1&state=${encodeURIComponent(signConnectState(7))}`, "ridgelinefield.com"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Connected Cascade Instrument Service to Craton");
    expect(stripe.exchangeConnectCode).toHaveBeenCalledWith("ac_1");
    expect(stripe.accountReady).toHaveBeenCalledWith("acct_operator");
    expect(written).toEqual({ stripeAccountId: "acct_operator", stripeStatus: "connected", stripeReady: true });
    expect(audits[0]).toContain("connected Stripe account acct_operator");
  });

  it("refuses a state it did not sign for this workspace, without spending the code", async () => {
    who.user = owner;
    const { signConnectState } = await import("@/lib/stripeApi");
    const { GET } = await import("@/app/api/stripe/oauth/callback/route");
    for (const state of ["forged", signConnectState(8)]) {
      const res = await GET(get(`?code=ac_1&state=${encodeURIComponent(state)}`));
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("This link has expired");
    }
    expect(stripe.exchangeConnectCode).not.toHaveBeenCalled();
    expect(written).toEqual({});
  });

  it("is for owners only", async () => {
    who.user = { ...owner, role: "staff" };
    const { GET } = await import("@/app/api/stripe/oauth/callback/route");
    const res = await GET(get("?code=ac_1&state=st"));
    expect(res.status).toBe(403);
    expect(stripe.exchangeConnectCode).not.toHaveBeenCalled();
  });

  it("shows Stripe's refusal, and the exchange's, as a sentence", async () => {
    who.user = owner;
    const { signConnectState } = await import("@/lib/stripeApi");
    const { GET } = await import("@/app/api/stripe/oauth/callback/route");
    const denied = await GET(get("?error=access_denied&error_description=The%20user%20denied%20your%20request"));
    expect(denied.status).toBe(400);
    expect(await denied.text()).toContain("The user denied your request");

    stripe.exchangeConnectCode.mockRejectedValue(new Error("This authorization code has already been used."));
    const used = await GET(get(`?code=ac_1&state=${encodeURIComponent(signConnectState(7))}`));
    expect(used.status).toBe(400);
    expect(await used.text()).toContain("already been used");
    expect(written).toEqual({});
  });
});
