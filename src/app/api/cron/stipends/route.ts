import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cronAuth";
import { runStipends } from "@/lib/stipendRun";

/**
 * The stipend pass, run once a day.
 *
 * Daily rather than hourly because a cycle is a DAY, not an hour: nothing here
 * is sent, and an internet stipend does not care which minute of the 1st it
 * was raised on.
 *
 * It raises rows onto a submitted perks claim and stops. The money still does
 * not move until an owner marks that report paid - the same wall every other
 * reimbursement stands behind - so the automation removes the filing, not the
 * decision to pay. See lib/stipendRun for why this submits where the retainer
 * pass only drafts.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await runStipends());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
