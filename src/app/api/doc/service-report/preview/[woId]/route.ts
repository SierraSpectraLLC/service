import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { workOrders } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import { readTenant } from "@/lib/tenancy";
import { docFileName, docHeaders } from "@/lib/docStyle";
import { brandForTenant } from "@/lib/brand";
import { reportLogo, serviceReportDraft } from "@/lib/serviceReportData";
import { buildServiceReport } from "@/lib/serviceReport";

export const dynamic = "force-dynamic";

/**
 * The report a job WOULD issue, drawn now and numbered DRAFT.
 *
 * For the engineer at the bench who wants to see the checklist and the tune
 * tables on the page before putting a number on it. Nothing is written: no
 * number is minted and no hours are marked as reported, so previewing ten
 * times costs the series nothing. Same door as an issued report - staff of
 * the job's own workspace.
 */
export async function GET(req: Request, ctx: { params: Promise<{ woId: string }> }) {
  let user;
  try { user = await requireStaff(); } catch { return NextResponse.json({ error: "Staff only" }, { status: 403 }); }
  const woId = parseInt((await ctx.params).woId, 10);
  if (!Number.isInteger(woId)) return NextResponse.json({ error: "Bad id" }, { status: 400 });

  const [wo] = await db.select({ tenantOrgId: workOrders.tenantOrgId, number: workOrders.number })
    .from(workOrders).where(eq(workOrders.id, woId));
  const t = readTenant(user);
  if (!wo || (t !== null && wo.tenantOrgId !== t)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const notes = (new URL(req.url).searchParams.get("notes") ?? "").slice(0, 4000);
  const draft = await serviceReportDraft(woId, { visitNotes: notes });
  if (!draft) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const logo = await reportLogo(await brandForTenant(wo.tenantOrgId));
  const bytes = await buildServiceReport({ ...draft.report, reportNumber: "DRAFT", logo });
  const name = docFileName("Report", `${wo.number}-DRAFT`, draft.report.customer.name, "pdf");
  return new NextResponse(new Uint8Array(bytes), { headers: docHeaders(name, "pdf") });
}
