import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Edge middleware can't hit the database, so this is a cheap gate: if there's
 * no session cookie at all, bounce to /login. Real authorization happens in
 * server components (auth()) and server actions (requireEditor etc).
 */
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
  return NextResponse.next();
}

export const config = {
  // `listing` is the one public page: a for-sale system's buyer-facing view,
  // keyed by its unguessable token. The page itself 404s anything not live.
  matcher: ["/((?!api/auth|api/cron|api/upload|login|listing|_next/static|_next/image|favicon.ico).*)"],
};
