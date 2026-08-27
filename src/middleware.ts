import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Edge middleware can't hit the database, so this is a cheap gate: if there's
 * no session cookie at all, bounce to /login. Real authorization happens in
 * server components (auth()) and server actions (requireEditor etc).
 */
export const PATH_HEADER = "x-pathname";

export function middleware(req: NextRequest) {
  const hasSession =
    req.cookies.has("authjs.session-token") ||
    req.cookies.has("__Secure-authjs.session-token");
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  // The path, forwarded to the render. A layout is not told where it is, and
  // the first-sign-in gate (lib/welcome) has to know - it cannot live out here,
  // because deciding it means asking the database whether this person has been
  // through it, and the edge cannot.
  const headers = new Headers(req.headers);
  headers.set(PATH_HEADER, req.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // The public pages are the token-keyed ones - a listing's buyer view, a
  // drop link's sender view, a share link's recipient view - plus the API
  // routes that serve them. Every one of them treats its unguessable token as
  // the credential and 404s anything it doesn't explicitly allow.
  //
  // /equipment is the other kind of public: the indexable catalog library,
  // deliberately open to everyone including crawlers, which is why the sitemap
  // and robots.txt come out here too. It renders only models an operator has
  // explicitly published, and reads nothing that depends on who is asking -
  // see app/equipment and lib/publicCatalog. api/catalog serves the stock
  // photos those pages show.
  //
  // api/stripe is the same pattern with a different credential: Stripe holds
  // no session, and the request's SIGNATURE is what authenticates it. The
  // route verifies that against the webhook secret on the raw body before
  // parsing a byte, and answers an unverified request with a bare 400.
  // opengraph-image is the landing page's social card, and it is fetched by
  // the one visitor guaranteed never to have a cookie: Slack's unfurler, or
  // Twitter's, or Google's. Behind the gate it answered every one of them with
  // a redirect to /login, so a pasted link rendered as a bare URL and the card
  // was never seen by anybody. Next serves it from a hashed path
  // (`/opengraph-image-<hash>`), hence the prefix match rather than the exact
  // name. It reads app_settings for a name and a colour and nothing else - no
  // session, no tenant, no record - so it is public in the same sense
  // /equipment is: it renders the same bytes for everyone.
  //
  // `.+` rather than `.*`, and the difference is the whole home page: the
  // empty path is the root, and `.*` matched it, so a visitor with no cookie
  // was bounced to /login before anything rendered. The apex is the front
  // door now - it has to answer a stranger. Every other path still passes
  // through the gate above; `/` decides for itself who it is talking to (see
  // app/(dashboard)/page.tsx), because the dashboard and the landing page are
  // the same address wearing two faces.
  matcher: ["/((?!api/auth|api/cron|api/stripe|api/upload|api/files|api/drop|api/share|api/catalog|login|listing|drop|share|equipment|opengraph-image|sitemap.xml|robots.txt|_next/static|_next/image|favicon.ico).+)"],
};
