// The database half of lib/trail: writing a row, reading them back, and
// throwing away the old ones.
//
// EVERYTHING HERE IS BEST-EFFORT. A debugging tool that can break a page is
// worse than no debugging tool: it would manufacture the very errors it exists
// to find, and it would do it on the pages people actually use. Every call
// swallows its own failure.
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, trailEvents } from "@/db/schema";
import {
  DETAIL_MAX, MESSAGE_MAX, TRAIL_KEEP_DAYS, isTrailKind, safeQuery, shortUa, type TrailRow,
} from "@/lib/trail";

/** Is the module on? Its own read, because a page load consults it. */
export async function trailOn(): Promise<boolean> {
  try {
    const [s] = await db.select({ on: appSettings.trailEnabled })
      .from(appSettings).where(eq(appSettings.id, 1));
    return s?.on ?? false;
  } catch {
    return false;
  }
}

export type TrailInput = {
  kind: string;
  email: string;
  role?: string;
  orgId?: number | null;
  orgName?: string;
  operatorOrgId?: number | null;
  viewingAs?: string;
  route: string;
  /** The raw location search; the values are stripped on the way in. */
  search?: string;
  message?: string;
  detail?: string;
  userAgent?: string;
};

/**
 * Record one thing. Never throws, never blocks anything that matters.
 *
 * The toggle is checked HERE rather than at each call site, so there is one
 * answer to "is this on" and no path that records while the switch says off.
 */
export async function recordTrail(input: TrailInput): Promise<void> {
  try {
    if (!isTrailKind(input.kind)) return;
    if (!(await trailOn())) return;
    await db.insert(trailEvents).values({
      kind: input.kind,
      email: input.email.trim().toLowerCase().slice(0, 200),
      role: (input.role ?? "").slice(0, 40),
      orgId: input.orgId ?? null,
      orgName: (input.orgName ?? "").slice(0, 200),
      operatorOrgId: input.operatorOrgId ?? null,
      viewingAs: (input.viewingAs ?? "").slice(0, 200),
      route: input.route.slice(0, 300),
      query: safeQuery(input.search ?? ""),
      message: (input.message ?? "").slice(0, MESSAGE_MAX),
      detail: (input.detail ?? "").slice(0, DETAIL_MAX),
      userAgent: shortUa(input.userAgent ?? ""),
    });
  } catch {
    // Deliberately silent. See the note at the top of this file.
  }
}

/** Everything since a moment, newest first. */
export async function trailSince(since: Date, limit = 4000): Promise<TrailRow[]> {
  try {
    return await db.select({
      id: trailEvents.id, kind: trailEvents.kind, email: trailEvents.email,
      role: trailEvents.role, orgName: trailEvents.orgName, viewingAs: trailEvents.viewingAs,
      route: trailEvents.route, query: trailEvents.query, message: trailEvents.message,
      detail: trailEvents.detail, userAgent: trailEvents.userAgent, at: trailEvents.at,
    }).from(trailEvents)
      .where(gte(trailEvents.at, since))
      .orderBy(desc(trailEvents.at))
      .limit(limit);
  } catch {
    return [];
  }
}

/**
 * Everything one person did around a moment, oldest first.
 *
 * The reason a page trail is worth keeping at all: an error on its own says
 * what threw, and the twenty rows before it say what they were doing when it
 * did.
 */
export async function trailAround(email: string, at: Date, minutes = 30): Promise<TrailRow[]> {
  try {
    const from = new Date(at.getTime() - minutes * 60_000);
    const to = new Date(at.getTime() + minutes * 60_000);
    const rows = await db.select({
      id: trailEvents.id, kind: trailEvents.kind, email: trailEvents.email,
      role: trailEvents.role, orgName: trailEvents.orgName, viewingAs: trailEvents.viewingAs,
      route: trailEvents.route, query: trailEvents.query, message: trailEvents.message,
      detail: trailEvents.detail, userAgent: trailEvents.userAgent, at: trailEvents.at,
    }).from(trailEvents)
      .where(and(
        eq(trailEvents.email, email.trim().toLowerCase()),
        gte(trailEvents.at, from),
        lt(trailEvents.at, to),
      ))
      .orderBy(trailEvents.at)
      .limit(400);
    return rows;
  } catch {
    return [];
  }
}

/**
 * Throw away what is past keeping.
 *
 * Called opportunistically on write rather than by a cron, because a module
 * that is off writes nothing and therefore needs no cleaning - and one that is
 * on is being written to constantly, so there is no shortage of chances.
 */
export async function pruneTrail(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - TRAIL_KEEP_DAYS * 86_400_000);
    const gone = await db.delete(trailEvents).where(lt(trailEvents.at, cutoff)).returning({ id: trailEvents.id });
    return gone.length;
  } catch {
    return 0;
  }
}

/** How many rows are being kept, for the panel that offers to clear them. */
export async function trailCount(): Promise<number> {
  try {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(trailEvents);
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}
