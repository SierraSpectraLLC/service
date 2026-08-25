import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, desc, eq, isNull, and } from "drizzle-orm";
import { db } from "@/db";
import { expenseCategories, expenses, payroll } from "@/db/schema";
import { myTenantOrgId, requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { forTenant, readTenant } from "@/lib/tenancy";
import { visibleDirectory } from "@/lib/directory";
import { shopToday } from "@/lib/shopday";
import { payrollForMonth, recentMonths, type PayRow } from "@/lib/payroll";
import FinanceShell from "@/components/FinanceShell";
import { financeContext } from "@/lib/financeData";
import OverheadPanel from "@/components/OverheadPanel";
import { PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The overhead ledger: expenses with no work order behind them. What it cost
 * to exist this month, as opposed to what any job cost - the job answer lives
 * in Costing, and the two deliberately never mix.
 */
export default async function OverheadExpensesPage({ searchParams }: {
  searchParams: Promise<{ period?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const { period, seesPayroll, figures: fig } =
    await financeContext(user, (await searchParams).period);

  const [rows, people, categoryRows] = await Promise.all([
    db.select().from(expenses)
      .where(and(isNull(expenses.workOrderId), forTenant(expenses.tenantOrgId, readTenant(user))))
      .orderBy(desc(expenses.incurredOn), desc(expenses.id)),
    visibleDirectory(user),
    db.select().from(expenseCategories)
      .where(forTenant(expenseCategories.tenantOrgId, readTenant(user)))
      .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.id)),
  ]);

  // Payroll is the other half of a month, and the bigger half - a ledger of
  // receipts that leaves out the wages is a number somebody will believe. It
  // is read here ONLY for the reader's own company and only for somebody who
  // may read a register at all. That question is asked once, in
  // lib/financeData, and every page in the section reads the same answer: a
  // page that worked it out for itself could disagree with the rail beside it.
  const mine = myTenantOrgId(user);
  const payRows = seesPayroll && mine !== null
    ? (await db.select().from(payroll).where(eq(payroll.orgId, mine))) as PayRow[]
    : [];
  const payByMonth: Record<string, number> = {};
  if (payRows.length) {
    for (const ym of recentMonths(shopToday(), 24)) {
      const cents = payrollForMonth(payRows, ym).totalCents;
      if (cents > 0) payByMonth[ym] = cents;
    }
  }

  return (
    <FinanceShell
      rail={{ active: "overhead", amounts: fig.amounts, seesPayroll }}
      period={period}
      path="/money/expenses"
      title="Overhead"
      sub={<>What no job caused: running costs, by month. Job expenses live on their work orders;
        engineers claim their own at <Link href="/expenses">Reimbursements</Link>.</>}
    >
      <OverheadPanel today={shopToday()} me={user.name}
        payrollByMonth={payByMonth}
        payrollHref={seesPayroll ? "/payroll" : ""}
        categories={categoryRows.map((c) => c.name)}
        people={people.map((p) => ({ name: p.name, org: p.org }))}
        rows={rows.map((r) => ({
          id: r.id, kind: r.kind, description: r.description,
          amountCents: r.amountCents, incurredOn: r.incurredOn, person: r.person,
        }))} />
    </FinanceShell>
  );
}
