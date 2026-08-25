import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, eq, isNull, and, gte } from "drizzle-orm";
import { db } from "@/db";
import { clientAllowlist, expenses, orgs, payroll, timeEntries } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { myTenantOrgId } from "@/lib/authz";
import { forTenant } from "@/lib/tenancy";
import { shopToday } from "@/lib/shopday";
import {
  loadedHourlyCents, maySeePayroll, mayEditPayroll, payrollForMonth, recentMonths,
  visibleRows, type PayRow, type PayrollViewer,
} from "@/lib/payroll";
import PayrollPanel from "@/components/PayrollPanel";
import { EmptyState, PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * What an organization pays its own people.
 *
 * One route for everybody, showing the payroll of whichever organization the
 * READER belongs to - the shop's for the shop's owner, their own for a client
 * manager. That is deliberate: a page that took an org id would be a page
 * somebody could point at somebody else's, and the whole value of this table
 * is that it cannot be pointed at.
 *
 * The access rule lives in lib/payroll and runs the other way from the rest of
 * the app: an operator's staff read everything in their workspace EXCEPT this.
 * Somebody with no right to the register still gets their own row, because a
 * payroll you cannot check is a payroll kept about you rather than for you.
 */
export default async function PayrollPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }

  // Whose payroll this reader is looking at: their own company's, always.
  const mine = user.orgId ?? myTenantOrgId(user);
  if (mine === null) redirect("/");

  const [row] = user.orgId === null ? [] : await db
    .select({ canSeePayroll: clientAllowlist.canSeePayroll }).from(clientAllowlist)
    .where(eq(clientAllowlist.entry, user.email.trim().toLowerCase()));
  const viewer: PayrollViewer = {
    email: user.email, role: user.role, orgId: user.orgId,
    operatorOrgId: myTenantOrgId(user), canSeePayroll: row?.canSeePayroll ?? false,
  };

  const whole = maySeePayroll(viewer, mine);
  const all = (await db.select().from(payroll).where(eq(payroll.orgId, mine))
    .orderBy(asc(payroll.name), asc(payroll.effectiveOn))) as PayRow[];
  const rows = visibleRows(viewer, mine, all);
  // Nothing to show and no right to the register: this page does not exist for
  // them, which is the same answer they get about anything else that isn't
  // theirs.
  if (!whole && rows.length === 0) redirect("/");

  const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, mine));
  const today = shopToday();
  const months = recentMonths(today, 6);

  // What else the month cost, and what sold in it - only for the organization
  // that runs the workspace, because only they have jobs and an overhead
  // ledger here. A client's register is payroll and nothing else.
  const isHouseOfThis = user.orgId === null && myTenantOrgId(user) === mine;
  const since = `${months[months.length - 1]}-01`;
  const [overheadRows, hourRows] = isHouseOfThis && whole
    ? await Promise.all([
        db.select({ incurredOn: expenses.incurredOn, amountCents: expenses.amountCents })
          .from(expenses).where(and(
            isNull(expenses.workOrderId), gte(expenses.incurredOn, since),
            forTenant(expenses.tenantOrgId, mine),
          )),
        db.select({ date: timeEntries.date, minutes: timeEntries.minutes, billable: timeEntries.billable })
          .from(timeEntries).where(gte(timeEntries.date, since)),
      ])
    : [[], []];

  const monthly = months.map((ym) => {
    const pay = payrollForMonth(rows, ym);
    const otherCents = overheadRows
      .filter((r) => r.incurredOn.startsWith(ym))
      .reduce((n, r) => n + r.amountCents, 0);
    const billedMinutes = hourRows
      .filter((h) => h.billable && h.date.startsWith(ym))
      .reduce((n, h) => n + h.minutes, 0);
    const totalCents = pay.totalCents + otherCents;
    return {
      ym,
      payrollCents: pay.totalCents,
      otherCents,
      totalCents,
      headcount: pay.headcount,
      billedMinutes,
      loadedCents: loadedHourlyCents(totalCents, billedMinutes),
      people: pay.people.map((p) => ({
        id: p.row.id, name: p.row.name, title: p.row.title, kind: p.row.kind,
        monthlyCents: p.monthlyCents, ftePct: p.row.ftePct,
      })),
    };
  });

  return (
    <div className="container page">
      <PageHead
        title="Payroll"
        sub={whole
          ? <>What {org?.name ?? "this organization"} pays its people, and what that makes a month cost.
              {isHouseOfThis && <> Running costs with a receipt live in <Link href="/money/expenses">Overhead</Link>.</>}</>
          : <>Your own pay, as it is recorded. Nobody else&apos;s is shown here.</>}
      />
      {all.length === 0 && whole ? (
        <EmptyState title="Nobody on the payroll yet"
          body="Add the first person below. Pay is dated, so a raise later does not rewrite what this month cost." />
      ) : null}
      <PayrollPanel
        orgId={mine}
        orgName={org?.name ?? ""}
        rows={rows.map((r) => ({
          id: r.id, name: r.name, title: r.title, personEmail: r.personEmail,
          kind: r.kind, amountCents: r.amountCents, hoursPerWeek: r.hoursPerWeek,
          ftePct: r.ftePct, burdenPct: r.burdenPct,
          effectiveOn: r.effectiveOn, endsOn: r.endsOn, note: r.note,
        }))}
        months={monthly}
        today={today}
        whole={whole}
        mayEdit={mayEditPayroll(viewer, mine)}
        showRate={isHouseOfThis && whole}
      />
    </div>
  );
}
