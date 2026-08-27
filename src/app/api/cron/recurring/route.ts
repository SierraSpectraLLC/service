import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cronAuth";
import { runRecurring } from "@/lib/recurringRun";

/**
 * The retainer pass, run once a day.
 *
 * Daily rather than hourly because a cycle is a DAY, not an hour: there is no
 * per-client send time to respect here, since nothing is sent. The lead time
 * on the agreement is what decides how early the draft appears.
 *
 * It raises drafts and nothing else - no send, no card charge, no fee. Every
 * one of those is a decision, and a decision that happens because a job fired
 * overnight is a decision nobody made.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await runRecurring());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
