// How many direct messages are waiting for this person, for the header badge.
//
// Separate from lib/discussionUnread because the two counters answer different
// questions: that one is "has anything been said in a room I can see", this one
// is "has anybody written to ME".

import { and, eq, gt, isNull, or, inArray } from "drizzle-orm";
import { db } from "@/db";
import { messages, threadMembers } from "@/db/schema";

export async function unreadMessages(email: string): Promise<number> {
  const me = email.toLowerCase();
  const seats = await db.select().from(threadMembers)
    .where(and(eq(threadMembers.email, me), isNull(threadMembers.leftAt)))
    .catch(() => []);
  if (!seats.length) return 0;
  // One query for every thread, then counted per seat: a person is in a
  // handful of conversations, and this runs on every page render.
  const rows = await db.select({
    threadId: messages.threadId, authorEmail: messages.authorEmail, createdAt: messages.createdAt,
  }).from(messages)
    .where(inArray(messages.threadId, seats.map((s) => s.threadId)))
    .catch(() => []);
  let n = 0;
  for (const seat of seats) {
    for (const m of rows) {
      if (m.threadId !== seat.threadId) continue;
      if (m.authorEmail.toLowerCase() === me) continue;
      if (!seat.lastReadAt || m.createdAt > seat.lastReadAt) n++;
    }
  }
  return n;
}
