// The password path, end to end: setting one, and signing in with one.
//
// Kept out of app/actions.ts because everything here is auth rather than work,
// and because the two halves belong beside each other - the rules that decide a
// password is acceptable when it is set are the rules the sign-in relies on.
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword, needsRehash, passwordProblem, verifyPassword } from "@/lib/password";

const scryptAsync = promisify(scryptCb) as (p: string, s: Buffer, k: number, o: object) => Promise<Buffer>;
const scrypt = (p: string, s: Buffer, k: number, o: { N: number; r: number; p: number }) => scryptAsync(p, s, k, o);

/** Hash and store a password for an existing account. */
export async function setPasswordFor(email: string, password: string): Promise<{ error?: string }> {
  const e = email.trim().toLowerCase();
  const problem = passwordProblem(password, e);
  if (problem) return { error: problem };
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, e));
  // Only for an account that exists, which means one that has signed in by email
  // at least once. That is what makes this safe to offer: the address was proved
  // before a password existed for it, so nobody can bootstrap their way in.
  if (!user) return { error: "Sign in by email once first, then set a password." };
  const hash = await hashPassword(password, scrypt, randomBytes);
  await db.update(users).set({ passwordHash: hash, passwordSetAt: new Date() }).where(eq(users.id, user.id));
  return {};
}

/** Forget it. Sign-in falls back to codes, which never stopped working. */
export async function clearPasswordFor(email: string): Promise<void> {
  await db.update(users).set({ passwordHash: "", passwordSetAt: null })
    .where(eq(users.email, email.trim().toLowerCase()));
}

export async function hasPassword(email: string): Promise<boolean> {
  const [u] = await db.select({ hash: users.passwordHash }).from(users)
    .where(eq(users.email, email.trim().toLowerCase()));
  return !!u?.hash;
}

/**
 * Check an email and password. Returns the user id to start a session for, or
 * null - and never says which half was wrong, because "no account with that
 * address" and "wrong password" are two different answers only to an attacker.
 *
 * A correct password on a stale hash is re-hashed at today's cost while we have
 * the plaintext in hand, which is the only moment that is possible.
 */
export async function checkPassword(email: string, password: string): Promise<{ userId: string } | null> {
  const e = email.trim().toLowerCase();
  const [user] = await db.select({ id: users.id, hash: users.passwordHash }).from(users).where(eq(users.email, e));
  if (!user?.hash) return null;
  if (!(await verifyPassword(password, user.hash, scrypt, timingSafeEqual))) return null;
  if (needsRehash(user.hash)) {
    const fresh = await hashPassword(password, scrypt, randomBytes);
    await db.update(users).set({ passwordHash: fresh }).where(eq(users.id, user.id)).catch(() => {});
  }
  return { userId: user.id };
}
