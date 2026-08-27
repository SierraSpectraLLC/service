import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cronAuth";
import { shopToday } from "@/lib/shopday";
import { generateDuePmTasks } from "@/lib/pmGenerate";

// Preventive maintenance is core product, not an optional module: with no
// schedules defined this is a no-op, so there is nothing to switch off.
export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await generateDuePmTasks(shopToday(), "pm-cron");
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
