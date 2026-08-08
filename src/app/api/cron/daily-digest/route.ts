import { NextResponse } from "next/server";
import { getModules } from "@/lib/flags";
import { runDailyDigest } from "@/lib/digest";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await getModules()).digest) {
    return NextResponse.json({ skipped: true, reason: "the daily digest module is off for this instance" });
  }
  try {
    const result = await runDailyDigest();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
