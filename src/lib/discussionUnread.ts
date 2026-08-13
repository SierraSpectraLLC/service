// How many general-room posts this person hasn't seen - the number on the
// discussions icon in the header. Server-only.
//
// Deliberately reuses canSeePost and roomThreadId rather than reimplementing
// "who may read this" in SQL: a badge that counted posts the reader can't open
// would be worse than no badge, and audience rules that live in two places
// drift. The cost is fetching rows to count them, so the fetch is bounded.
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { db } from "@/db";
import { discussionPosts, discussionReads, orgs } from "@/db/schema";
import type { SessionUser } from "@/lib/authz";
import { canSeePost, roomThreadId, type Audience } from "@/lib/discussionScope";
import { isHouse } from "@/lib/houseRole";
import { forTenant, readTenant } from "@/lib/tenancy";

/** Enough for any real backlog; the badge caps rather than scanning a year. */
const SCAN_CAP = 200;

export async function unreadDiscussions(user: SessionUser): Promise<number> {
  const myTenant = readTenant(user);
  const viewer = {
    isHouse: isHouse(user.role), orgId: user.orgId,
    houseOrgId: isHouse(user.role) ? myTenant : null,
  };
  // An org viewer has exactly one room; the operator has its own plus a seat in
  // every organization's.
  const marks = await db.select().from(discussionReads)
    .where(and(eq(discussionReads.userEmail, user.email), lte(discussionReads.threadId, 0)))
    .catch(() => []);
  if (!viewer.isHouse && user.orgId === null) return 0;

  // Only posts newer than the oldest marker can possibly be unread anywhere.
  const oldest = marks.length ? marks.reduce((a, m) => (m.lastSeenAt < a ? m.lastSeenAt : a), marks[0].lastSeenAt) : null;
  const posts = await db.select({
    roomOrgId: discussionPosts.roomOrgId, authorEmail: discussionPosts.authorEmail,
    authorOrgId: discussionPosts.authorOrgId, audience: discussionPosts.audience,
    tenantOrgId: discussionPosts.tenantOrgId, createdAt: discussionPosts.createdAt,
  }).from(discussionPosts)
    .where(and(
      isNull(discussionPosts.instrumentId),
      forTenant(discussionPosts.tenantOrgId, myTenant),
      oldest ? gt(discussionPosts.createdAt, oldest) : undefined,
    ))
    .limit(SCAN_CAP)
    .catch(() => []);
  if (!posts.length) return 0;

  const rooms: (number | null)[] = viewer.isHouse
    ? [null, ...(await db.select({ id: orgs.id }).from(orgs).catch(() => [])).map((o) => o.id)]
    : [user.orgId];

  let n = 0;
  for (const room of rooms) {
    const mark = marks.find((m) => m.threadId === roomThreadId(viewer, room))?.lastSeenAt;
    n += posts.filter((p) => p.roomOrgId === room
      && p.authorEmail !== user.email
      && (!mark || p.createdAt > mark)
      // instrumentId is null throughout: these are general-room posts only.
      && canSeePost(viewer, { ...p, instrumentId: null, audience: p.audience as Audience })).length;
  }
  return n;
}
