import { NextResponse } from "next/server";
import { getModules } from "@/lib/flags";
import { runDailyDigest } from "@/lib/digest";

/**
 * The digest pass, run every hour.
 *
 * Hourly rather than once at a fixed time because the send hour is a setting
 * each organization keeps (orgs.digest_hour), and a Vercel cron expression
 * lives in vercel.json - a deploy artifact nobody should need a pull request
 * to change. This wakes up, sends whatever is due and has not gone today, and
 * on twenty-three hours out of twenty-four does nothing at all: a run that
 * sends nothing is a success.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await getModules()).digest) {
    return NextResponse.json({ skipped: true, reason: "the daily digest module is off for this instance" });
  }
  try {
    return NextResponse.json(await runDailyDigest());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
