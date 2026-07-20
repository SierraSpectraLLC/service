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
  matcher: ["/((?!api/auth|api/cron|api/upload|login|_next/static|_next/image|favicon.ico).*)"],
};
