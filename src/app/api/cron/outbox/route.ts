import { NextResponse } from "next/server";
import { flushOutbox, pruneOutbox } from "@/lib/outboxData";

export const dynamic = "force-dynamic";

/**
 * The backstop under the held-email queue.
 *
 * The queue's real driver is the bell poller: every open tab asks
 * /api/notifications/poll about every forty-five seconds, and that call
 * flushes anything due. In practice the person who just assigned five tasks
 * still has the app open, so the engineer's one email lands within a minute or
 * so of them stopping.
 *
 * This exists for the case where nobody does - the last assignment of the day,
 * then the laptop shuts. Without it a held email would sit in the table until
 * somebody opened the app again, which for a Friday evening means Monday.
 *
 * Hourly, because that is the schedule every plan can run and because it is a
 * BACKSTOP: the fast path is already covered. Moving it to every minute in
 * vercel.json tightens the worst case from an hour to a minute and changes
 * nothing else.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sent = await flushOutbox();
  await pruneOutbox();
  // Nothing to send is the ordinary outcome and a success, exactly as it is
  // for the digest: this does nothing at all most hours.
  return NextResponse.json({ sent });
}
