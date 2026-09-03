import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgs } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import { seesBooksFor } from "@/lib/financeData";
import { readTenant } from "@/lib/tenancy";
import { quoteById, qtyOf, quoteSubtotal } from "@/lib/invoiceData";
import {
  addressedTo, commentRows, discountLabel, discountOf, greetingLine, specRows,
} from "@/lib/quotes";
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

  /* The shop's own words first, the standing terms after them, and the last
     row held for the terms so a long note cannot push the deposit off a
     document somebody is about to sign. See commentRows. */
  const comments = commentRows(full.row.note, [
    full.row.depositPct > 0 ? `${full.row.depositPct}% deposit due on approval` : "",
    full.row.expiresOn ? `Quote good through ${full.row.expiresOn}` : "",
  ].filter(Boolean), 5);

  // Where it is addressed, and to whom - the quote's own address when it has
  // one, the client's accounts-payable address when it has not.
  const to = addressedTo(full.row, org);
  const subtotal = quoteSubtotal(full);

  const buf = await fillQuoteXlsx({
    number: full.row.number,
    date: full.row.sentOn || shopToday(),
    customer: { name: to.name, address: to.address },
    title: full.row.title,
    greeting: greetingLine(full.row),
    // The shape of the offer, in the template's own two columns. Capped by
    // specRows: there is nowhere for an eighth line to go.
    specs: {
      left: specRows(full.row.specsLeft),
      right: specRows(full.row.specsRight),
    },
    discount: discountOf(subtotal, full.row) / 100,
    discountLabel: discountLabel(full.row),
    comments,
    contactLine: docContactLine(brand),
    lines: invoiceLinesForXlsx(full.lines.map((l) => ({
      kind: l.kind, description: l.description, detail: l.detail, partNumber: l.partNumber,
      qty: qtyOf(l), unitCents: l.unitCents, covered: l.covered, coveredBy: l.coveredBy,
    }))),
  });
  return new NextResponse(new Uint8Array(buf), { headers: xlsxHeaders(full.row.number) });
}
