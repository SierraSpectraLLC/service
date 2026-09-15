import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgs } from "@/db/schema";
import { audit } from "@/lib/audit";
import { currentUser, myTenantOrgId } from "@/lib/authz";
import { connectOrigin, stripeMode } from "@/lib/stripe";
import { accountReady, exchangeConnectCode, readConnectState } from "@/lib/stripeApi";

export const dynamic = "force-dynamic";

/** What the connection is called on the page the owner reads. */
const PLATFORM = "Craton";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

/**
 * A plain page. Deliberately unstyled: this is the one screen in the app that
 * is not rendered by React and cannot share the stylesheet, and the honest
 * alternative to a second design system is none - a heading, a sentence, and
 * the way back.
 */
function page(title: string, body: string, status = 200): NextResponse {
  const html = `<!doctype html><html lang="en-US"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head>`
    + `<body><main><h1>${esc(title)}</h1><p>${body}</p>`
    + `<p><a href="/settings/billing">Back to Billing &amp; payments</a></p></main></body></html>`;
  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * The origin this request arrived on - apex or www - so the sign-in bounce
 * and the page's own links keep the person on the host whose cookie they
 * hold. Vercel puts the public host in x-forwarded-host; a bare Host is what
 * a local dev server sends. Anything unrecognised falls back to APP_URL.
 */
function requestOrigin(req: Request): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return connectOrigin(host ? `${proto}://${host}` : "");
}

/**
 * Where Stripe sends the owner back to after "Connect with Stripe".
 *
 * Every step is a check on a request that arrived from outside, in order: the
 * person is signed in (and if not, they sign in and come straight back here,
 * code and all - the code is good for a while and the state for two hours);
 * they are an owner; the state is one this instance signed, for the workspace
 * they own; and only then is the code spent. The account id it buys is
 * written to that workspace's org row and nowhere else.
 *
 * Refusals are sentences on a page, not status codes: the person is in a
 * browser, mid-task, and a 400 tells them nothing they can act on.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = requestOrigin(req);

  const u = await currentUser();
  if (!u) {
    const back = `${url.pathname}${url.search}`;
    return NextResponse.redirect(`${origin}/login?next=${encodeURIComponent(back)}`);
  }
  if (u.role !== "owner") {
    return page("Owner only", "Connecting a Stripe account is something the workspace owner does.", 403);
  }

  // Stripe says no by redirecting here with a reason, not by failing to.
  const denied = url.searchParams.get("error_description") || url.searchParams.get("error");
  if (denied) return page("Stripe did not connect", esc(denied.split("\n")[0].slice(0, 200)), 400);

  const orgId = myTenantOrgId(u);
  const state = readConnectState(url.searchParams.get("state") ?? "");
  if (orgId === null || !state || state.orgId !== orgId) {
    return page("This link has expired", "Start again from Billing &amp; payments and press Connect with Stripe.", 400);
  }
  const [org] = await db.select({ id: orgs.id, name: orgs.name, stripeAccountId: orgs.stripeAccountId })
    .from(orgs).where(eq(orgs.id, orgId));
  if (!org) return page("This link has expired", "The workspace it was started from no longer exists.", 400);

  const code = url.searchParams.get("code") ?? "";
  let accountId: string;
  let livemode = false;
  try {
    ({ stripeUserId: accountId, livemode } = await exchangeConnectCode(code));
  } catch (e) {
    return page("Stripe did not connect", esc((e as Error).message), 400);
  }

  // Best effort: a Standard account that was already taking payments is ready
  // now; one Stripe is still checking is not, and Re-check on the billing page
  // asks again. A lookup failure is "not yet", never a failed connection.
  const ready = await accountReady(accountId).catch(() => false);
  await db.update(orgs)
    .set({ stripeAccountId: accountId, stripeStatus: "connected", stripeReady: ready })
    .where(eq(orgs.id, orgId));
  await audit({
    actor: u.email, entityType: "org", entityId: orgId, tenantOrgId: orgId,
    action: `connected Stripe account ${accountId} (${livemode ? "live" : stripeMode()} mode)`
      + (org.stripeAccountId && org.stripeAccountId !== accountId ? `, replacing ${org.stripeAccountId}` : "")
      + (ready ? "; it can take payments" : "; Stripe is still checking it"),
  });

  return page(
    `Connected ${org.name} to ${PLATFORM}`,
    ready
      ? "Clients can now pay invoices by card or bank transfer."
      : "Stripe is still finishing its checks on the account. Press Re-check on the billing page once they are done.",
  );
}
