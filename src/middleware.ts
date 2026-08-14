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
  // `listing` is a public page: a for-sale item's buyer-facing view, keyed by
  // its unguessable token. `api/files` does its own authorization (it must
  // serve listing files to anonymous buyers). Both 404 anything they don't
  // explicitly allow. `welcome` is the public marketing page and `landing` its
  // static screenshots (public/landing) - nothing sensitive lives under either.
  matcher: ["/((?!api/auth|api/cron|api/upload|api/files|login|listing|welcome|landing|_next/static|_next/image|favicon.ico).*)"],
};
