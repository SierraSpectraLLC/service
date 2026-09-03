import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cronAuth";
import { runClaimResolutions } from "@/lib/custody/claims";

/**
 * The claim window, closing. Daily: a window is CLAIM_NOTICE_DAYS long and
 * nobody is owed a machine at 03:17 rather than 09:00. Resolving is the
 * silent path in lib/custody/claims - an objection parks a claim before this
 * ever sees it.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await runClaimResolutions(new Date()));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
