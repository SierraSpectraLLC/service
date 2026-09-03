import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgs } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import { seesBooksFor } from "@/lib/financeData";
import { readTenant } from "@/lib/tenancy";
import { quoteById, qtyOf } from "@/lib/invoiceData";
import { getBrand } from "@/lib/brand";
import { xlsxHeaders, docContactLine, invoiceLinesForXlsx } from "@/lib/xlsxDocData";
import { fillQuoteXlsx } from "@/lib/xlsxDocs";
import { shopToday } from "@/lib/shopday";

export const dynamic = "force-dynamic";

/** The quote, in the shop's own Excel layout - templates/QuoteTemplate.xlsx. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireStaff(); } catch { return NextResponse.json({ error: "Staff only" }, { status: 403 }); }
  /* A spreadsheet of what a client was charged is the books in one file, and a
     URL with an id in it is guessable in a way the page it hangs off is not.
     Same rule as the page - see lib/books. */
  if (!(await seesBooksFor(user))) return NextResponse.json({ error: "Owner only" }, { status: 403 });
  const id = parseInt((await ctx.params).id, 10);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });

  const full = await quoteById(id);
  const t = readTenant(user);
  if (!full || (t !== null && full.row.tenantOrgId !== t)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const [org, brand] = await Promise.all([
    db.select().from(orgs).where(eq(orgs.id, full.row.orgId)).then((r) => r[0] ?? null),
    getBrand(),
  ]);

  const comments = [
    full.row.note,
    full.row.depositPct > 0 ? `${full.row.depositPct}% deposit due on approval` : "",
    full.row.expiresOn ? `Quote good through ${full.row.expiresOn}` : "",
  ].filter(Boolean);

  const buf = await fillQuoteXlsx({
    number: full.row.number,
    date: full.row.sentOn || shopToday(),
    customer: { name: org?.name ?? "", address: org?.billingAddress ?? "" },
    title: full.row.title,
    comments,
    contactLine: docContactLine(brand),
    lines: invoiceLinesForXlsx(full.lines.map((l) => ({
      kind: l.kind, description: l.description, detail: l.detail, partNumber: l.partNumber,
      qty: qtyOf(l), unitCents: l.unitCents, covered: l.covered, coveredBy: l.coveredBy,
    }))),
  });
  return new NextResponse(new Uint8Array(buf), { headers: xlsxHeaders(full.row.number) });
}
