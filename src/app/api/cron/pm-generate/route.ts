import { NextResponse } from "next/server";
import { shopToday } from "@/lib/shopday";
import { generateDuePmTasks } from "@/lib/pmGenerate";

// Preventive maintenance is core product, not an optional module: with no
// schedules defined this is a no-op, so there is nothing to switch off.
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await generateDuePmTasks(shopToday(), "pm-cron");
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
