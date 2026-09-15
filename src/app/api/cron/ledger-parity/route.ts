import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cronAuth";
import { recordParity } from "@/lib/ledger/parity";
import { shopToday } from "@/lib/shopday";

/**
 * Ledger parity, hourly, beside sheet-sync: every workspace's money computed
 * the old way and the ledger's way, the diffs stored for the Ledger parity
 * view. Nothing is changed by it; it is the record the dual-write period is
 * judged on. See lib/ledger/parity.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const runs = await recordParity(shopToday());
    return NextResponse.json({
      workspaces: runs.length,
      nonzero: runs.flatMap((r) => r.figures).filter((f) => f.diffCents !== 0).length,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
