import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/authz";
import { seesBooksFor } from "@/lib/financeData";
import { readTenant } from "@/lib/tenancy";
import { quoteDocSpec } from "@/lib/docData";
import { docFileName, docHeaders } from "@/lib/docStyle";
import { renderDocx } from "@/lib/docxRender";
import { renderPdf } from "@/lib/pdfRender";

export const dynamic = "force-dynamic";

/**
 * The quote as paper, in the house style: ?format=pdf (the copy a client is
 * sent) or ?format=docx (the copy the shop edits). Same gate as the Excel
 * export next door - a priced document is the books in one file.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireStaff(); } catch { return NextResponse.json({ error: "Staff only" }, { status: 403 }); }
  if (!(await seesBooksFor(user))) return NextResponse.json({ error: "Owner only" }, { status: 403 });
  const id = parseInt((await ctx.params).id, 10);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });

  const doc = await quoteDocSpec(id);
  const t = readTenant(user);
  if (!doc || (t !== null && doc.tenantOrgId !== t)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const format = new URL(req.url).searchParams.get("format") === "docx" ? "docx" : "pdf";
  const bytes = format === "docx" ? await renderDocx(doc.spec) : await renderPdf(doc.spec);
  return new NextResponse(new Uint8Array(bytes), {
    headers: docHeaders(docFileName(doc.spec.type, doc.spec.number, doc.spec.client, format), format),
  });
}
