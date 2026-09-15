import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cronAuth";
import { runBills } from "@/lib/billRun";

/**
 * The bills pass, run once a day.
 *
 * Daily, like the stipend pass and for the same reason: a cycle is a DAY, and
 * a liability policy does not care which minute of the 1st it posted on. It
 * writes overhead expenses and stops - nothing is sent, nobody is paid; the
 * ledger simply reads what the month costs. See lib/billRun.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await runBills());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
