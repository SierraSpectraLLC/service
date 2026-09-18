import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/authz";
import { readTenant } from "@/lib/tenancy";
import { docFileName, docHeaders } from "@/lib/docStyle";
import { brandForTenant } from "@/lib/brand";
import { issuedReport, reportLogo } from "@/lib/serviceReportData";
import { buildServiceReport } from "@/lib/serviceReport";

export const dynamic = "force-dynamic";

/**
 * An issued service report, as the PDF it was issued as.
 *
 * Drawn from the frozen copy rather than from today's rows, so the file a
 * client countersigned in March is the file that comes back in November.
 *
 * Staff, not owner-only like the quote and invoice doors next to it. The money
 * on a service report is there to show what the agreement absorbed, and the
 * engineer who did the work is the person who hands it over - a report only
 * the owner can print is a report nobody hands over.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireStaff(); } catch { return NextResponse.json({ error: "Staff only" }, { status: 403 }); }
  const id = parseInt((await ctx.params).id, 10);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });

  const found = await issuedReport(id);
  const t = readTenant(user);
  if (!found || (t !== null && found.row.tenantOrgId !== t)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // The mark is not part of the frozen report - see ServiceReport.logo.
  const logo = await reportLogo(await brandForTenant(found.row.tenantOrgId));
  const bytes = await buildServiceReport({ ...found.report, logo });
  const name = docFileName("Report", found.row.number, found.report.customer.name, "pdf");
  return new NextResponse(new Uint8Array(bytes), { headers: docHeaders(name, "pdf") });
}
