import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/authz";
import { seesBooksFor } from "@/lib/financeData";
import { readTenant } from "@/lib/tenancy";
import { proposalDocSpec } from "@/lib/docData";
import { docFileName, docHeaders } from "@/lib/docStyle";
import { renderDocx } from "@/lib/docxRender";
import { renderPdf } from "@/lib/pdfRender";

export const dynamic = "force-dynamic";

/**
 * The proposal behind a quote, as paper: ?format=pdf or ?format=docx. The id
 * is the QUOTE's, as every proposal door is. Same gate as the quote's own
 * documents.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireStaff(); } catch { return NextResponse.json({ error: "Staff only" }, { status: 403 }); }
  if (!(await seesBooksFor(user))) return NextResponse.json({ error: "Owner only" }, { status: 403 });
  const id = parseInt((await ctx.params).id, 10);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });

  const doc = await proposalDocSpec(id);
  const t = readTenant(user);
  if (!doc || (t !== null && doc.tenantOrgId !== t)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const format = new URL(req.url).searchParams.get("format") === "docx" ? "docx" : "pdf";
  const bytes = format === "docx" ? await renderDocx(doc.spec) : await renderPdf(doc.spec);
  return new NextResponse(new Uint8Array(bytes), {
    headers: docHeaders(docFileName(doc.spec.type, doc.spec.number, doc.spec.client, format), format),
  });
}
