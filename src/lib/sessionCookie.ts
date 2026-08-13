// Signing somebody in without going through Auth.js's own routes.
//
// Auth.js will not do password sign-in on top of database sessions - its
// Credentials provider forces JWT sessions, and this instance keeps sessions in
// the database on purpose: revoking access has to mean revoking access, which a
// signed token in somebody's browser cannot honour until it expires. So the
// password path mints the session itself.
//
// What that costs is two pieces of Auth.js's own shape, and both are pinned here
// rather than scattered: the row in `sessions` that its adapter reads, and the
// name of the cookie that carries the token. Everything else - who may sign in,
// what the session then means - is the same code every other path runs.
//
// Verified against the pinned @auth/core: defaultCookies() names the cookie
// `authjs.session-token`, prefixed `__Secure-` when the deployment URL is https
// (lib/utils/cookie.js), and a database session is looked up by that value
// through the adapter's getSessionAndUser.
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "@/db";
import { sessions } from "@/db/schema";

/** Auth.js's own default, and the one this instance has always used. */
export const SESSION_DAYS = 30;

/**
 * Secure cookies follow the protocol of the deployment URL, exactly as Auth.js
 * derives them - so a local http instance keeps working and a real one gets the
 * `__Secure-` prefix without anybody setting a second variable.
 */
export function sessionCookieName(url = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? ""): string {
  const secure = url.startsWith("https:") || (!url && process.env.NODE_ENV === "production");
  return `${secure ? "__Secure-" : ""}authjs.session-token`;
}

/**
 * Start a session for a user id and put the cookie on the response.
 *
 * The token is 32 random bytes: this is the whole credential for as long as the
 * session lives, so it is generated the same way Auth.js generates its own and
 * never derived from anything about the person.
 */
export async function startSession(userId: string): Promise<void> {
  const sessionToken = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({ sessionToken, userId, expires });
  (await cookies()).set(sessionCookieName(), sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: sessionCookieName().startsWith("__Secure-"),
    expires,
  });
}
