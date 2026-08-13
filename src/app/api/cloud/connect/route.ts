import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { currentUser } from "@/lib/authz";
import { authorizeUrl, graphConfig, pkcePair } from "@/lib/msgraph";
import { seal, vaultConfigured } from "@/lib/secretBox";

export const dynamic = "force-dynamic";

/** The handshake's own state, sealed into a cookie for the two minutes it lives. */
export const HANDSHAKE_COOKIE = "cloud-oauth";
const HANDSHAKE_TTL_S = 600;

/**
 * Send somebody to Microsoft to approve this.
 *
 * The state and the PKCE verifier have to survive a round trip through another
 * company's website and come back trustworthy. They ride in a sealed,
 * short-lived, httpOnly cookie rather than in a table: they are worthless ten
 * minutes later, they belong to one browser rather than one account, and a
 * database row for each abandoned attempt is litter.
 *
 * Which email started this is sealed in with them. Otherwise a code could be
 * completed by whoever's session happens to be in the browser when it comes
 * back - and the connection would be filed under the wrong person.
 */
export async function GET() {
  const cfg = graphConfig();
  const u = await currentUser();
  if (!u || u.role === "client_viewer") return NextResponse.redirect(new URL("/pdf", process.env.APP_URL));
  if (!cfg || !vaultConfigured()) return NextResponse.redirect(new URL("/pdf?cloud=unconfigured", cfg?.redirectUri ?? process.env.APP_URL));

  const { verifier, challenge } = pkcePair();
  const state = pkcePair().verifier;   // another 48 random bytes; only its opacity matters

  const jar = await cookies();
  jar.set(HANDSHAKE_COOKIE, seal(JSON.stringify({ state, verifier, email: u.email })), {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    path: "/api/cloud", maxAge: HANDSHAKE_TTL_S,
  });
  return NextResponse.redirect(authorizeUrl(cfg, state, challenge));
}
