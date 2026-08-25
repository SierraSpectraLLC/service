import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, desc, isNull, and } from "drizzle-orm";
import { db } from "@/db";
import { expenseCategories, expenses } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { forTenant, readTenant } from "@/lib/tenancy";
import { visibleDirectory } from "@/lib/directory";
import { shopToday } from "@/lib/shopday";
import MoneyTabs from "@/components/MoneyTabs";
import OverheadPanel from "@/components/OverheadPanel";
import { PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The overhead ledger: expenses with no work order behind them. What it cost
 * to exist this month, as opposed to what any job cost - the job answer lives
 * in Costing, and the two deliberately never mix.
 */
export default async function OverheadExpensesPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");

  const [rows, people, categoryRows] = await Promise.all([
    db.select().from(expenses)
      .where(and(isNull(expenses.workOrderId), forTenant(expenses.tenantOrgId, readTenant(user))))
      .orderBy(desc(expenses.incurredOn), desc(expenses.id)),
    visibleDirectory(user),
    db.select().from(expenseCategories)
      .where(forTenant(expenseCategories.tenantOrgId, readTenant(user)))
      .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.id)),
  ]);

  return (
    <div className="container wide">
      <PageHead
        crumb={<><Link href="/money">Billing</Link> › <b>Overhead</b></>}
        title="Overhead"
        sub={<>What no job caused: running costs, by month. Job expenses live on their work orders;
          engineers claim payouts at <Link href="/expenses">Reimbursements</Link>.</>}
      />
      <MoneyTabs active="overhead" />
      <OverheadPanel today={shopToday()} me={user.name}
        categories={categoryRows.map((c) => c.name)}
        people={people.map((p) => ({ name: p.name, org: p.org }))}
        rows={rows.map((r) => ({
          id: r.id, kind: r.kind, description: r.description,
          amountCents: r.amountCents, incurredOn: r.incurredOn, person: r.person,
        }))} />
    </div>
  );
}
