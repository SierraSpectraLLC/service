import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cronAuth";
import { getModules } from "@/lib/flags";
import { runSheetSync } from "@/lib/sheetSync";

export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await getModules()).sheetSync) {
    return NextResponse.json({ skipped: true, reason: "the sheet sync module is off for this instance" });
  }
  try {
    const result = await runSheetSync();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
