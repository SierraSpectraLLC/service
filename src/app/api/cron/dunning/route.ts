import { NextResponse } from "next/server";
import { runDunning } from "@/lib/dunningRun";

/**
 * The collections pass, run every hour.
 *
 * Hourly for the same reason the digest is: the send hour is a per-client
 * setting, and a cron expression lives in vercel.json where changing it needs
 * a deploy. Twenty-three hours out of twenty-four this does nothing, and a run
 * that sends nothing is a success.
 *
 * It never refers an account and never posts a fee on its own - both are
 * decisions, and a decision that happens because a job fired at seven in the
 * morning is a decision nobody made.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await runDunning());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
