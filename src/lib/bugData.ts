// The reads behind problem reports. The rules are lib/bugs and stay pure.

import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { bugReports, orgs, trailEvents } from "@/db/schema";
import {
  BREADCRUMB_MINUTES, MAX_BREADCRUMBS, parseCrumbs, serializeCrumbs, type Breadcrumb,
} from "@/lib/bugs";

export type ReportRow = {
  id: number;
  kind: string;
  title: string;
  body: string;
  blocking: boolean;
  status: string;
  route: string;
  query: string;
  userAgent: string;
  viewport: string;
  buildSha: string;
  breadcrumbs: Breadcrumb[];
  reportedBy: string;
  reportedByName: string;
  resolution: string;
  resolvedBy: string;
  when: string;
  /** Which workspace filed it. Only platform staff are shown this. */
  fromName: string;
};

/**
 * The reporter's own last few minutes, for freezing onto a report.
 *
 * Scoped three ways and every one matters: their OWN email (a report must not
 * become a window onto a colleague's afternoon), a short window (an hour ago
 * is not context, it is yesterday's work), and a hard count. The trail is
 * gated to one address for good reason - this is the one crack in that, and it
 * is narrow enough that what comes through is only ever the reporter's own
 * immediate past, shown back to them on the report they filed.
 */
export async function crumbsFor(email: string): Promise<string> {
  const since = new Date(Date.now() - BREADCRUMB_MINUTES * 60_000);
  const rows = await db.select({
    at: trailEvents.at, kind: trailEvents.kind,
    route: trailEvents.route, query: trailEvents.query, message: trailEvents.message,
  }).from(trailEvents)
    .where(and(eq(trailEvents.email, email.trim().toLowerCase()), gte(trailEvents.at, since)))
    .orderBy(desc(trailEvents.at))
    .limit(MAX_BREADCRUMBS);
  return serializeCrumbs(rows.map((r): Breadcrumb => ({
    at: r.at.toISOString(),
    kind: r.kind,
    route: r.route + (r.query ? `?${r.query}` : ""),
    message: r.message,
  })));
}

const shape = (
  r: typeof bugReports.$inferSelect,
  names: Map<number, string>,
): ReportRow => ({
  id: r.id, kind: r.kind, title: r.title, body: r.body, blocking: r.blocking,
  status: r.status, route: r.route, query: r.query, userAgent: r.userAgent,
  viewport: r.viewport, buildSha: r.buildSha,
  breadcrumbs: parseCrumbs(r.breadcrumbs),
  reportedBy: r.reportedBy, reportedByName: r.reportedByName,
  resolution: r.resolution, resolvedBy: r.resolvedBy,
  when: r.createdAt.toISOString().slice(0, 16).replace("T", " "),
  fromName: (r.tenantOrgId !== null ? names.get(r.tenantOrgId) : "") ?? "",
});

/**
 * The reports this reader may see.
 *
 * A workspace's own staff see their shop's list - it is theirs, and a queue
 * nobody can watch is a queue people stop filing into. Platform staff see
 * every workspace's, because a bug in the SOFTWARE is not the operator's to
 * fix, and a report that stopped at their own settings page would never reach
 * anybody who could act on it.
 */
export async function reportsFor(
  tenantOrgId: number | null, platform: boolean,
): Promise<ReportRow[]> {
  if (!platform && tenantOrgId === null) return [];
  const rows = platform
    ? await db.select().from(bugReports).orderBy(desc(bugReports.id))
    : await db.select().from(bugReports)
      .where(eq(bugReports.tenantOrgId, tenantOrgId as number))
      .orderBy(desc(bugReports.id));
  if (!rows.length) return [];
  // Only the platform reader is told WHOSE a report is; inside one workspace
  // the answer is always "ours" and the column would be noise.
  const ids = platform
    ? [...new Set(rows.map((r) => r.tenantOrgId).filter((x): x is number => x !== null))]
    : [];
  const names = new Map(ids.length
    ? (await db.select({ id: orgs.id, name: orgs.name }).from(orgs).where(inArray(orgs.id, ids)))
      .map((o) => [o.id, o.name])
    : []);
  return rows.map((r) => shape(r, names));
}
