import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, desc, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { expenseCategories, expenseReports, expenses, houseMembers, workOrders } from "@/db/schema";
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
 * nobody has paid me back for" (the pool), and "where is my money" (my
 * reports, each wearing its status).
 *
 * The owner and HR get the whole shop's claims - EVERY status, drafts
 * included. That is deliberate and it is the thing this page did not do:
 * `queue` was already the full list, and the panel rendered only the submitted
 * ones, so an owner asking what their people had open was shown what had been
 * handed to them. A claim nobody has sent is still money the shop owes.
 *
 * Expenses are LOGGED elsewhere, where they happen: on the work order for a
 * job, at Financial › Overhead for the rest. This page claims them.
 */
export default async function ExpensesPage({ searchParams }: {
  searchParams: Promise<{ period?: string; for?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const sp = await searchParams;
  const { period, seesBooks, seesPayroll, amounts } = await railContext(user, sp.period);
  const isOwner = user.role === "owner";
  /* HR reads the desk too - somebody has to chase the claims sitting on it -
     and may open one in a colleague's name. Paying stays the owner's, which is
     why this is a second flag and not a widened `isOwner`. */
  const adminsPeople = await mayAdminPeople(user);
  const t = readTenant(user);

  const [expenseRows, reportRows, categoryRows, allWos, roster] = await Promise.all([
    db.select().from(expenses).where(forTenant(expenses.tenantOrgId, t))
      .orderBy(desc(expenses.incurredOn), desc(expenses.id)),
    db.select().from(expenseReports).where(forTenant(expenseReports.tenantOrgId, t))
      .orderBy(desc(expenseReports.submittedAt)),
    db.select().from(expenseCategories).where(forTenant(expenseCategories.tenantOrgId, t))
      .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.id)),
    // Every job, open or closed, newest first - the picker for a report whose
    // receipts surfaced after its job wrapped.
    db.select({ id: workOrders.id, number: workOrders.number, title: workOrders.title, state: workOrders.state })
      .from(workOrders).where(forTenant(workOrders.tenantOrgId, t))
      .orderBy(desc(workOrders.id)).limit(200),
    /* Addresses to names, for "opened by". Only the house's own roster: an
       expense report is filed inside one workspace and the column holds a
       login, so an unmatched address simply shows as nothing. */
    db.select({ email: houseMembers.email, name: houseMembers.name }).from(houseMembers)
      .where(and(forTenant(houseMembers.orgId, t), ne(houseMembers.role, "none"))),
  ]);
  const woIds = [...new Set([
    ...expenseRows.map((e) => e.workOrderId),
    ...reportRows.map((r) => r.workOrderId),
  ].filter((x): x is number => x !== null))];
  const wos = woIds.length
    ? await db.select({ id: workOrders.id, number: workOrders.number }).from(workOrders).where(inArray(workOrders.id, woIds))
    : [];
  const woNumber = new Map(wos.map((w) => [w.id, w.number]));
  const nameOf = new Map(roster.map((m) => [m.email.trim().toLowerCase(), m.name]));

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
    workOrderId: r.workOrderId,
    workOrderNumber: r.workOrderId !== null ? (woNumber.get(r.workOrderId) ?? "") : "",
    openedByName: nameOf.get(r.openedBy.trim().toLowerCase()) ?? "",
    submittedAt: r.submittedAt.toISOString().slice(0, 10),
    paidOn: r.paidOn, paidRef: r.paidRef, returnedReason: r.returnedReason, note: r.note,
    expenses: expenseRows.filter((e) => e.reportId === r.id).map((e) => ({
      id: e.id, kind: e.kind, description: e.description, amountCents: e.amountCents, incurredOn: e.incurredOn,
    })),
  });

  /* Arriving from the People desk with a person to file for. Checked against
     the roster the picker is built from, so a name in a URL cannot put
     somebody who does not work here into the form - and the ACTION checks it
     again, because a disabled control is not a rule. */
  const openFor = subjects.some((s) => s.name === (sp.for ?? "")) ? (sp.for ?? "") : "";

  return (
    <FinanceShell
      rail={{ active: "reimbursements", amounts, seesBooks, seesPayroll }}
      period={period}
      path="/money/reimbursements"
      title="Reimbursements"
      sub={<>
        Out-of-pocket spend, attached to the job it was spent on: open a report, add what you have
        fronted, submit it, and watch the payout land. What the business spends on itself is
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
        me={user.name}
        openFor={openFor}
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
