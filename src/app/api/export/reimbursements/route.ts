import { NextResponse } from "next/server";
import { currentUser } from "@/lib/authz";
import { exportName, reportsCsv } from "@/lib/reportExport";
import { exportableMonth } from "@/lib/reportExportData";

export const dynamic = "force-dynamic";

/**
 * A month of reimbursements, as one sheet for the bookkeeper.
 *
 *   /api/export/reimbursements?month=2026-08
 *
 * PAID reports only, dated by the payout. An expense report hits the books
 * when the shop paid it, so a claim submitted in July and paid in August
 * belongs in August's file - and a claim nobody has paid is not an expense
 * yet, the same rule /api/export/billing follows when it refuses to export a
 * draft invoice as revenue.
 *
 * Whoever administers the people, which is HR and the owner: this is every
 * engineer's spending in one download.
 */
export async function GET(req: Request) {
  const u = await currentUser();
  if (!u) return new NextResponse(null, { status: 404 });
  const month = (new URL(req.url).searchParams.get("month") ?? "").slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "Pass a month as YYYY-MM" }, { status: 400 });
  }
  const reports = await exportableMonth(u, month);
  if (reports === null) return new NextResponse(null, { status: 404 });

  return new NextResponse(reportsCsv(reports), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${exportName(`reimbursements-${month}`, "csv")}"`,
    },
  });
}
