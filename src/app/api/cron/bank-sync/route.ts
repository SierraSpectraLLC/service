import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cronAuth";
import { plaidConfigured, syncAllBanks } from "@/lib/bank/sync";

/**
 * The bank feed, hourly, beside sheet-sync and behind the same bearer
 * secret. Read-only: it pulls lines into bank_transactions and stops. The
 * Cash page is where a line gets a home. See lib/bank/sync.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!plaidConfigured()) {
    return NextResponse.json({ skipped: true, reason: "the bank feed is not configured on this instance" });
  }
  try {
    return NextResponse.json(await syncAllBanks());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
