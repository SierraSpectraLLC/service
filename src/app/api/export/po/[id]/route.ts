import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { poLines, purchaseOrders } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import { readTenant } from "@/lib/tenancy";
import { getBrand } from "@/lib/brand";
import { xlsxHeaders, docContactLine } from "@/lib/xlsxDocData";
import { fillPoXlsx } from "@/lib/xlsxDocs";
import { shopToday } from "@/lib/shopday";

export const dynamic = "force-dynamic";

/** The purchase order, in the shop's own Excel layout - templates/POTemplate.xlsx. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireStaff(); } catch { return NextResponse.json({ error: "Staff only" }, { status: 403 }); }
  const id = parseInt((await ctx.params).id, 10);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });

  const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
  const t = readTenant(user);
  if (!po || (t !== null && po.tenantOrgId !== t)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const [lines, brand] = await Promise.all([
    db.select().from(poLines).where(eq(poLines.poId, id)).orderBy(asc(poLines.id)),
    getBrand(),
  ]);

  const buf = await fillPoXlsx({
    number: po.number,
    date: shopToday(),
    // The vendor book stores a name; the address is the vendor's to know.
    vendor: { name: po.vendor, address: "" },
    orderedBy: po.createdBy,
    reference: po.reference,
    shipVia: "",
    terms: "",
    comments: po.note ? [po.note] : [],
    contactLine: docContactLine(brand),
    lines: lines.map((l) => ({
      description: l.name || l.partNumber,
      partNumber: l.partNumber,
      qty: l.qtyOrdered,
      unitPrice: (l.unitCents ?? 0) / 100,
    })),
  });
  return new NextResponse(new Uint8Array(buf), { headers: xlsxHeaders(po.number) });
}
