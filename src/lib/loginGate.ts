// The database half of code sign-in: the counters lib/loginCode reasons about.
//
// Every function here fails OPEN on a database error, and that is a deliberate
// trade. This sits in front of sign-in itself: a throttle that cannot read its
// own table would otherwise lock every person on the instance out of a portal
// that is working fine. The credential is still a credential - a wrong code is
// still refused by Auth.js - so the worst case of a failure here is that the
// rate limit stops counting for as long as the database is unwell.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { loginAttempts, verificationTokens } from "@/db/schema";
import {
  afterWrongCode, freshAttempts, mayTryCode, maySendCode, type AttemptRow, type Verdict,
} from "@/lib/loginCode";

const norm = (email: string) => email.trim().toLowerCase();

async function readRow(identifier: string): Promise<AttemptRow | null> {
  const [row] = await db.select().from(loginAttempts)
    .where(eq(loginAttempts.identifier, identifier)).catch(() => []);
  if (!row) return null;
  return {
    attempts: row.attempts, requests: row.requests,
    windowStart: row.windowStart, lockedUntil: row.lockedUntil,
  };
}

async function writeRow(identifier: string, row: AttemptRow): Promise<void> {
  await db.insert(loginAttempts)
    .values({ identifier, ...row, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: loginAttempts.identifier,
      set: { ...row, updatedAt: new Date() },
    })
    .catch(() => {});
}

/** May this address be sent a code? Records the ask when it may. */
export async function takeSendSlot(email: string, now = new Date()): Promise<Verdict> {
  const id = norm(email);
  const verdict = maySendCode(await readRow(id), now);
  if (verdict.allow) await writeRow(id, verdict.row);
  return verdict;
}

/** May this address try a code at all? */
export async function checkTryAllowed(email: string, now = new Date()): Promise<Verdict> {
  return mayTryCode(await readRow(norm(email)), now);
}

/**
 * Record a wrong guess - a code or a password, since both are guesses at the same
 * door and an attacker should not get two budgets for it.
 *
 * When it is the last guess allowed, that address's outstanding codes are deleted
 * too: a locked front door with a live link beside it is not locked.
 */
export async function recordFailure(email: string, now = new Date()): Promise<{ locked: boolean }> {
  const id = norm(email);
  const current = await readRow(id) ?? freshAttempts(now);
  const { row, locked } = afterWrongCode(current, now);
  await writeRow(id, row);
  if (locked) {
    await db.delete(verificationTokens).where(eq(verificationTokens.identifier, id)).catch(() => {});
  }
  return { locked };
}

/** Signing in clears the slate: the counters exist to stop strangers, not people. */
export async function clearAttempts(email: string): Promise<void> {
  await db.delete(loginAttempts).where(eq(loginAttempts.identifier, norm(email))).catch(() => {});
}
