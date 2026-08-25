import Link from "next/link";
import { redirect } from "next/navigation";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { expenseReports, expenses, workOrders } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { forTenant, readTenant } from "@/lib/tenancy";
import { reimbursementPool } from "@/lib/expenseReports";
import { shopToday } from "@/lib/shopday";
import ExpenseReportsPanel, { type ReportRow } from "@/components/ExpenseReportsPanel";
import { PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The reimbursement desk.
 *
 * Everyone on staff gets both of their answers here: "what have I spent that
 * nobody has paid me back for" (the pool), and "where is my money" (the
 * reports, each wearing its status). The owner additionally gets the queue -
 * every submitted report, ready to mark paid or send back.
 *
 * Expenses are LOGGED elsewhere, where they happen: on the work order for a
 * job, at Billing › Overhead for the rest. This page only claims them.
 */
export default async function ExpensesPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const isOwner = user.role === "owner";
  const t = readTenant(user);

  const [expenseRows, reportRows] = await Promise.all([
    db.select().from(expenses).where(forTenant(expenses.tenantOrgId, t))
      .orderBy(desc(expenses.incurredOn), desc(expenses.id)),
    db.select().from(expenseReports).where(forTenant(expenseReports.tenantOrgId, t))
      .orderBy(desc(expenseReports.submittedAt)),
  ]);
  const woIds = [...new Set(expenseRows.map((e) => e.workOrderId).filter((x): x is number => x !== null))];
  const wos = woIds.length
    ? await db.select({ id: workOrders.id, number: workOrders.number }).from(workOrders).where(inArray(workOrders.id, woIds))
    : [];
  const woNumber = new Map(wos.map((w) => [w.id, w.number]));

  const pool = reimbursementPool(expenseRows, { name: user.name, email: user.email })
    .map((e) => ({
      id: e.id, kind: e.kind, description: e.description, amountCents: e.amountCents,
      incurredOn: e.incurredOn, billable: e.billable,
      workOrderNumber: e.workOrderId !== null ? (woNumber.get(e.workOrderId) ?? "") : "",
    }));

  const shape = (r: typeof reportRows[number]): ReportRow => ({
    id: r.id, person: r.person, status: r.status,
    submittedAt: r.submittedAt.toISOString().slice(0, 10),
    paidOn: r.paidOn, paidRef: r.paidRef, returnedReason: r.returnedReason, note: r.note,
    expenses: expenseRows.filter((e) => e.reportId === r.id).map((e) => ({
      id: e.id, kind: e.kind, description: e.description, amountCents: e.amountCents, incurredOn: e.incurredOn,
    })),
  });

  return (
    <div className="container wide">
      <PageHead
        title="Reimbursements"
        sub={<>
          Claim what you have fronted, and watch the payout land. Log job expenses on their work
          orders and overhead at <Link href="/money/expenses">Billing › Overhead</Link>.
        </>}
      />
      <ExpenseReportsPanel
        pool={pool}
        mine={reportRows.filter((r) => r.person === user.name).map(shape)}
        queue={isOwner ? reportRows.map(shape) : []}
        isOwner={isOwner}
        today={shopToday()}
      />
    </div>
  );
}
