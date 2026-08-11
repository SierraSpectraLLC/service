import { NextResponse } from "next/server";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { currentUser } from "@/lib/authz";

export const dynamic = "force-dynamic";

/**
 * The live half of the inbox. Vercel functions can't hold a WebSocket open,
 * so "live" here is honest polling: the bell asks every ~45 seconds (and on
 * tab-focus) for anything newer than the last id it saw. Own inbox only -
 * the email comes from the session, so there is nothing to probe - and the
 * response is deliberately tiny: two indexed queries, a handful of rows.
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const email = user.email.toLowerCase();

  const after = parseInt(new URL(req.url).searchParams.get("after") ?? "0", 10) || 0;

  const [unreadRows, fresh] = await Promise.all([
    db.select({ id: notifications.id }).from(notifications)
      .where(and(eq(notifications.email, email), isNull(notifications.readAt)))
      .catch(() => []),
    db.select({
      id: notifications.id, kind: notifications.kind, title: notifications.title, href: notifications.href,
    }).from(notifications)
      .where(and(eq(notifications.email, email), gt(notifications.id, after)))
      .orderBy(desc(notifications.id)).limit(10)
      .catch(() => []),
  ]);

  // `cursor` advances even when `after` was 0 (first poll), so the first
  // response never toasts the whole backlog - only what arrives after it.
  const cursor = fresh[0]?.id ?? after;
  return NextResponse.json(
    { unread: unreadRows.length, cursor, fresh: after > 0 ? fresh.reverse() : [] },
    { headers: { "Cache-Control": "no-store" } },
  );
}
