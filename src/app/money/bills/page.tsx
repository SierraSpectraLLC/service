import { redirect } from "next/navigation";
import { asc, and, ne } from "drizzle-orm";
import { db } from "@/db";
import { bills, expenseCategories, houseMembers } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { forTenant, readTenant } from "@/lib/tenancy";
import { isStaffRole } from "@/lib/tenants";
import { booksContext } from "@/lib/financeData";
import { billsDueSoon, nextBillCycle } from "@/lib/bills";
import FinanceShell from "@/components/FinanceShell";
import BillsPanel from "@/components/BillsPanel";

export const dynamic = "force-dynamic";

/**
 * The bills desk: what the company pays to exist, on a cycle, and where to
 * go and pay each one.
 *
 * A room of the books - it names what the shop pays for insurance and what
 * each person's benefits cost - so booksContext is the gate, as it is for
 * Overhead next door. The owner sets bills up (they are standing company
 * money, the stipend's rule); anyone who may read the books may read them.
 */
export default async function BillsPage({ searchParams }: {
  searchParams: Promise<{ period?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const { period, today, seesPayroll, figures: fig } =
    await booksContext(user, (await searchParams).period);
  const t = readTenant(user);

  const [rows, categoryRows, members] = await Promise.all([
    db.select().from(bills).where(forTenant(bills.tenantOrgId, t))
      .orderBy(asc(bills.name)),
    db.select().from(expenseCategories)
      .where(forTenant(expenseCategories.tenantOrgId, t))
      .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.id)),
    db.select({ name: houseMembers.name }).from(houseMembers)
      .where(and(forTenant(houseMembers.orgId, t), ne(houseMembers.role, "none")))
      .orderBy(asc(houseMembers.name)),
  ]);

  const soon = billsDueSoon(rows, today);

  return (
    <FinanceShell
      rail={{ active: "bills", amounts: fig.amounts, seesBooks: true, seesPayroll }}
      period={period}
      path="/money/bills"
      title="Bills"
      sub="Insurance, benefits, the phone line, the lease: what comes due on a cycle, and where to go and pay it. Each posts to Overhead on its day."
    >
      <BillsPanel
        today={today}
        isOwner={user.role === "owner"}
        categories={categoryRows.map((c) => c.name)}
        roster={members.filter((m) => m.name.trim()).map((m) => ({ name: m.name }))}
        soon={soon.cycles.map((c) => ({ billId: c.bill.id, on: c.on }))}
        rows={rows.map((r) => ({
          id: r.id, name: r.name, payee: r.payee, kind: r.kind, amountCents: r.amountCents,
          cadence: r.cadence, everyMonths: r.everyMonths, dayOfMonth: r.dayOfMonth,
          everyWeeks: r.everyWeeks, weekday: r.weekday,
          startsOn: r.startsOn, endsOn: r.endsOn, active: r.active, lastOn: r.lastOn,
          /* Asked of the same rule the pass obeys, so the row and the pass
             cannot disagree about when it next posts. */
          nextOn: nextBillCycle(r, today),
          portalUrl: r.portalUrl, accountRef: r.accountRef, person: r.person,
          autopay: r.autopay, note: r.note,
        }))} />
    </FinanceShell>
  );
}
