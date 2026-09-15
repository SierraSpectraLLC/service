import { NextResponse } from "next/server";
import { requireUser, myTenantOrgId } from "@/lib/authz";
import { moneyViewer } from "@/lib/financeData";
import { accountName, entries } from "@/lib/ledger";
import { shopToday } from "@/lib/shopday";
import { ledgerCsv, ledgerIif } from "@/lib/ledger/exports";

export const dynamic = "force-dynamic";

/**
 * The journal, row for row, as a file. Owner only. Downloads, not previews:
 * the point of sending the journal rather than a report is that every line
 * can be traced back to a row on the Ledger page.
 */
export async function GET(req: Request) {
  let user;
  try { user = await requireUser(); } catch { return new NextResponse("Sign in", { status: 401 }); }
  const { seesBooks } = await moneyViewer(user);
  const mine = myTenantOrgId(user);
  if (!seesBooks || user.role !== "owner" || mine === null) return new NextResponse("Owner only", { status: 403 });
  const url = new URL(req.url);
  const format = url.searchParams.get("format") === "iif" ? "iif" : "csv";
  const rows = (await entries({ tenant: mine }, 100000)).reverse();   // oldest first
  const body = format === "iif" ? ledgerIif(rows, accountName) : ledgerCsv(rows, accountName);
  const name = `ledger-${shopToday()}.${format}`;
  return new NextResponse(body, {
    headers: {
      "Content-Type": format === "iif" ? "application/octet-stream" : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
