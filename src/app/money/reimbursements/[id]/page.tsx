import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { expenseCategories, expenseReports, expenses, workOrders } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { forTenant, readTenant } from "@/lib/tenancy";
import { REPORT_LABEL, reimbursementPool, reportSpan, reportTotalCents } from "@/lib/expenseReports";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { WO_LABEL } from "@/lib/workOrders";
import ExpenseReportDetail from "@/components/ExpenseReportDetail";
import { PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * One expense report, as a record page: fill it, submit it, watch it land.
 *
 * Visible to its owner-engineer and to the owner; another engineer's claim is
 * not this one's business.
 */
export default async function ExpenseReportPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const id = parseInt((await params).id, 10);
  if (!Number.isInteger(id)) notFound();

  const t = readTenant(user);
  const [report] = await db.select().from(expenseReports)
    .where(eq(expenseReports.id, id));
  if (!report || (t !== null && report.tenantOrgId !== t)) notFound();
  const isOwner = user.role === "owner";
  const mine = report.person === user.name;
  if (!mine && !isOwner) notFound();

  const [rows, categoryRows, allWos, myExpenses] = await Promise.all([
    db.select().from(expenses).where(eq(expenses.reportId, id))
      .orderBy(desc(expenses.incurredOn), desc(expenses.id)),
    db.select().from(expenseCategories).where(forTenant(expenseCategories.tenantOrgId, t))
      .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.id)),
    db.select({ id: workOrders.id, number: workOrders.number, title: workOrders.title, state: workOrders.state })
      .from(workOrders).where(forTenant(workOrders.tenantOrgId, t))
      .orderBy(desc(workOrders.id)).limit(200),
    db.select().from(expenses).where(forTenant(expenses.tenantOrgId, t))
      .orderBy(desc(expenses.incurredOn), desc(expenses.id)),
  ]);
  const woNumber = new Map(allWos.map((w) => [w.id, w.number]));
  const pool = mine ? reimbursementPool(myExpenses, { name: user.name, email: user.email }) : [];

  const total = reportTotalCents(rows);
  return (
    <div className="container">
      <PageHead
        crumb={<><Link href="/money">Financial</Link> › <Link href="/money/reimbursements">Reimbursements</Link> › <b>Report</b></>}
        title={`${report.person} - ${reportSpan(rows) || "expense report"}`}
        sub={`${REPORT_LABEL[report.status] ?? report.status}${total ? ` · ${formatCents(total)}` : ""}${report.status === "paid" ? ` · paid ${report.paidOn}${report.paidRef ? ` (${report.paidRef})` : ""}` : ""}`}
      />
      <ExpenseReportDetail
        report={{
          id: report.id, person: report.person, status: report.status,
          submittedAt: report.submittedAt.toISOString().slice(0, 10),
          paidOn: report.paidOn, paidRef: report.paidRef, returnedReason: report.returnedReason,
        }}
        rows={rows.map((r) => ({
          id: r.id, kind: r.kind, description: r.description, amountCents: r.amountCents,
          incurredOn: r.incurredOn, workOrderId: r.workOrderId,
          workOrderNumber: r.workOrderId !== null ? (woNumber.get(r.workOrderId) ?? "") : "",
          receiptUrl: r.receiptUrl, receiptName: r.receiptName,
        }))}
        mine={mine} isOwner={isOwner} today={shopToday()}
        categories={categoryRows.map((c) => c.name)}
        workOrders={allWos.map((w) => ({
          id: w.id,
          label: `${w.number} - ${w.title}`.slice(0, 70)
            + (["closed", "resolved", "cancelled"].includes(w.state) ? ` (${WO_LABEL[w.state] ?? w.state})` : ""),
        }))}
        pool={pool.map((p) => ({
          id: p.id, kind: p.kind, description: p.description,
          amountCents: p.amountCents, incurredOn: p.incurredOn,
        }))}
      />
    </div>
  );
}
