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
  // `listing` is the one public page: a for-sale item's buyer-facing view,
  // keyed by its unguessable token. `api/files` does its own authorization
  // (it must serve listing files to anonymous buyers). Both 404 anything
  // they don't explicitly allow.
  matcher: ["/((?!api/auth|api/cron|api/upload|api/files|login|listing|_next/static|_next/image|favicon.ico).*)"],
};
