import { NextResponse } from "next/server";
import { db } from "@/db";
import { orgs, workOrders } from "@/db/schema";
import { requireOwner } from "@/lib/authz";
import { allInvoices, qtyOf } from "@/lib/invoiceData";
import { forTenant, readTenant } from "@/lib/tenancy";
import {
  exportFileName, feesCsv, inMonth, invoicesCsv, paymentsCsv,
} from "@/lib/accountingExport";

export const dynamic = "force-dynamic";

/**
 * The month's books, as three files an accounting package will take.
 *
 * Owner only: this is every client's money in one download, which is the
 * single most sensitive thing this application can emit.
 */
export async function GET(req: Request) {
  let u;
  try { u = await requireOwner(); } catch { return NextResponse.json({ error: "Owner only" }, { status: 403 }); }

  const url = new URL(req.url);
  const month = (url.searchParams.get("month") ?? "").slice(0, 7);
  const what = url.searchParams.get("what") ?? "invoices";
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "Pass a month as YYYY-MM" }, { status: 400 });
  }

  const [full, orgRows, woRows] = await Promise.all([
    allInvoices(readTenant(u)),
    db.select({ id: orgs.id, name: orgs.name }).from(orgs),
    db.select({ id: workOrders.id, number: workOrders.number }).from(workOrders)
      .where(forTenant(workOrders.tenantOrgId, readTenant(u))),
  ]);
  const orgName = (id: number) => orgRows.find((o) => o.id === id)?.name ?? "";
  const woNumber = (id: number | null) => woRows.find((w) => w.id === id)?.number ?? "";

  let body: string;
  if (what === "payments") {
    body = paymentsCsv(full.flatMap((f) => f.payments
      .filter((p) => inMonth(p.receivedOn, month))
      .map((p) => ({
        invoiceNumber: f.row.number, orgName: orgName(f.row.orgId),
        method: p.method, amountCents: p.amountCents,
        reference: p.reference, receivedOn: p.receivedOn,
      }))));
  } else if (what === "fees") {
    body = feesCsv(full.flatMap((f) => f.fees
      .filter((x) => inMonth(x.postedOn, month))
      .map((x) => ({
        invoiceNumber: f.row.number, orgName: orgName(f.row.orgId),
        amountCents: x.amountCents, basis: x.basis, postedOn: x.postedOn,
        waived: x.waived, waivedReason: x.waivedReason,
      }))));
  } else {
    body = invoicesCsv(full
      // Drafts are not books. An invoice nobody has sent is not revenue and
      // exporting it is how a bookkeeper accrues something that never existed.
      .filter((f) => f.row.status !== "draft" && inMonth(f.row.issuedOn, month))
      .map((f) => ({
        number: f.row.number, orgName: orgName(f.row.orgId), status: f.row.status,
        issuedOn: f.row.issuedOn, dueOn: f.row.dueOn, poNumber: f.row.poNumber,
        workOrder: woNumber(f.row.workOrderId),
        lines: f.lines.map((l) => ({
          kind: l.kind, description: l.description, qty: qtyOf(l),
          unitCents: l.unitCents, covered: l.covered,
        })),
      })));
  }

  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFileName(what, month)}"`,
    },
  });
}
