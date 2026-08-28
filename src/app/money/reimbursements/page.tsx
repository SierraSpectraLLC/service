import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, desc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { expenseCategories, expenseReports, expenses, workOrders } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { forTenant, readTenant } from "@/lib/tenancy";
import { reimbursementPool } from "@/lib/expenseReports";
import { mayAdminPeople } from "@/lib/hr";
import { listReportSubjects } from "@/app/actions";
import { shopToday } from "@/lib/shopday";
import { WO_LABEL } from "@/lib/workOrders";
import ExpenseReportsPanel, { type ReportRow } from "@/components/ExpenseReportsPanel";
import FinanceShell from "@/components/FinanceShell";
import { railContext } from "@/lib/financeData";

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
 * job, at Financial › Overhead for the rest. This page only claims them.
 */
export default async function ExpensesPage({ searchParams }: {
  searchParams: Promise<{ period?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const { period, seesBooks, seesPayroll, amounts } =
    await railContext(user, (await searchParams).period);
  const isOwner = user.role === "owner";
  /* HR reads the queue too - somebody has to chase the claims that are sitting
     there - and may open one in a colleague's name. Paying stays the owner's,
     which is why this is a second flag and not a widened `isOwner`. */
  const adminsPeople = await mayAdminPeople(user);
  const t = readTenant(user);

  const [expenseRows, reportRows, categoryRows, allWos] = await Promise.all([
    db.select().from(expenses).where(forTenant(expenses.tenantOrgId, t))
      .orderBy(desc(expenses.incurredOn), desc(expenses.id)),
    db.select().from(expenseReports).where(forTenant(expenseReports.tenantOrgId, t))
      .orderBy(desc(expenseReports.submittedAt)),
    db.select().from(expenseCategories).where(forTenant(expenseCategories.tenantOrgId, t))
      .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.id)),
    // Every job, open or closed, newest first - the picker for a receipt that
    // surfaced after its job wrapped.
    db.select({ id: workOrders.id, number: workOrders.number, title: workOrders.title, state: workOrders.state })
      .from(workOrders).where(forTenant(workOrders.tenantOrgId, t))
      .orderBy(desc(workOrders.id)).limit(200),
  ]);
  const woIds = [...new Set(expenseRows.map((e) => e.workOrderId).filter((x): x is number => x !== null))];
  const wos = woIds.length
    ? await db.select({ id: workOrders.id, number: workOrders.number }).from(workOrders).where(inArray(workOrders.id, woIds))
    : [];
  const woNumber = new Map(wos.map((w) => [w.id, w.number]));

  // Empty for anybody who is not HR - the action refuses on the same rule, so
  // this only decides whether the control is drawn.
  const subjects = await listReportSubjects();

  const pool = reimbursementPool(expenseRows, { name: user.name, email: user.email })
    .map((e) => ({
      id: e.id, kind: e.kind, description: e.description, amountCents: e.amountCents,
      incurredOn: e.incurredOn, billable: e.billable,
      workOrderNumber: e.workOrderId !== null ? (woNumber.get(e.workOrderId) ?? "") : "",
    }));

  const shape = (r: typeof reportRows[number]): ReportRow => ({
    id: r.id, person: r.person, title: r.title, status: r.status,
    submittedAt: r.submittedAt.toISOString().slice(0, 10),
    paidOn: r.paidOn, paidRef: r.paidRef, returnedReason: r.returnedReason, note: r.note,
    expenses: expenseRows.filter((e) => e.reportId === r.id).map((e) => ({
      id: e.id, kind: e.kind, description: e.description, amountCents: e.amountCents, incurredOn: e.incurredOn,
    })),
  });

  return (
    <FinanceShell
      rail={{ active: "reimbursements", amounts, seesBooks, seesPayroll }}
      period={period}
      path="/money/reimbursements"
      title="Reimbursements"
      sub={<>
        Out-of-pocket spend, attached to the job it was spent on: log what you have fronted,
        claim it, and watch the payout land. What the business spends on itself is
        <Link href="/money/expenses"> Overhead</Link>.
      </>}
    >
      <ExpenseReportsPanel
        pool={pool}
        mine={reportRows.filter((r) => r.person === user.name).map(shape)}
        queue={adminsPeople ? reportRows.map(shape) : []}
        adminsPeople={adminsPeople}
        isOwner={isOwner}
        subjects={subjects}
        today={shopToday()}
        categories={categoryRows.map((c) => c.name)}
        workOrders={allWos.map((w) => ({
          id: w.id,
          label: `${w.number} - ${w.title}`.slice(0, 70)
            + (["closed", "resolved", "cancelled"].includes(w.state) ? ` (${WO_LABEL[w.state] ?? w.state})` : ""),
        }))}
      />
    </FinanceShell>
  );
}
