// The database half of lib/loginLog: recording a sign-in, marking somebody
// seen, and reading the log back. Split from the rules it serves because the
// usage panel is a client component and shares those rules (see
// tests/clientBundle).
//
// Everything here is best-effort. Nothing about bookkeeping may fail a sign-in
// or a page load: an unreachable table is not a reason to keep somebody out of
// their own portal.
import { desc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { loginEvents, users } from "@/db/schema";
import { TOUCH_INTERVAL_MS, type Method } from "@/lib/loginLog";

/**
 * Record one sign-in. Returns whether it was this address's first ever, which
 * is the only login worth pushing at somebody the moment it happens.
 *
 * `ip` and `userAgent` come from the request when there is one - Auth.js calls
 * its sign-in event inside the route handler, so there is.
 */
export async function recordLogin(input: {
  email: string; method: Method;
  userId?: string | null; role?: string;
  orgId?: number | null; orgName?: string; operatorOrgId?: number | null;
  ip?: string; userAgent?: string;
}): Promise<{ first: boolean }> {
  const email = input.email.trim().toLowerCase();
  if (!email) return { first: false };
  try {
    const [prior] = await db.select({ id: loginEvents.id }).from(loginEvents)
      .where(eq(loginEvents.email, email)).limit(1);
    await db.insert(loginEvents).values({
      email,
      userId: input.userId ?? null,
      method: input.method,
      role: input.role ?? "",
      orgId: input.orgId ?? null,
      orgName: input.orgName ?? "",
      operatorOrgId: input.operatorOrgId ?? null,
      ip: (input.ip ?? "").slice(0, 60),
      userAgent: (input.userAgent ?? "").slice(0, 200),
    });
    return { first: !prior };
  } catch (e) {
    console.error("[loginLog] could not record sign-in:", (e as Error).message);
    return { first: false };
  }
}

/**
 * Mark somebody as seen, at most once an hour. Called from the session
 * callback, which already holds the user row - so the common case (seen twelve
 * minutes ago) costs a comparison and no query at all.
 */
export async function touchLastSeen(userId: string, lastSeenAt: Date | null | undefined, now = new Date()): Promise<void> {
  if (lastSeenAt && now.getTime() - lastSeenAt.getTime() < TOUCH_INTERVAL_MS) return;
  try {
    await db.update(users).set({ lastSeenAt: now }).where(eq(users.id, userId));
  } catch {
    // A page load is not the place to care that a timestamp did not move.
  }
}

/** Sign-ins since a date, newest first, for the report and the page's feed. */
export async function loginsSince(since: Date, limit = 500) {
  return db.select().from(loginEvents)
    .where(gte(loginEvents.createdAt, since))
    .orderBy(desc(loginEvents.createdAt))
    .limit(limit);
}
