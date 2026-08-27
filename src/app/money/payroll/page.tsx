import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, eq, inArray, isNull, and, gte, ne } from "drizzle-orm";
import { db } from "@/db";
import { clientAllowlist, expenses, houseMembers, orgs, payroll, timeEntries, users } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import FinanceShell from "@/components/FinanceShell";
import { railContext } from "@/lib/financeData";
import { myTenantOrgId } from "@/lib/authz";
import { forTenant } from "@/lib/tenancy";
import { shopToday } from "@/lib/shopday";
import {
  loadedHourlyCents, maySeePayroll, mayEditPayroll, payrollForMonth, recentMonths,
  visibleRows, type PayRow,
} from "@/lib/payroll";
import { payrollViewerFor } from "@/lib/hr";
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
export default async function PayrollPage({ searchParams }: {
  searchParams: Promise<{ period?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }

  // Whose payroll this reader is looking at: their own company's, always.
  const mine = user.orgId ?? myTenantOrgId(user);
  if (mine === null) redirect("/");

  // Assembled by lib/hr, which is the only place that reads either roster.
  // This page used to build the viewer itself from the client allowlist alone,
  // which meant the shop's own HR read `canSeePayroll: false` here and the
  // whole register on the rail beside it.
  const viewer = await payrollViewerFor(user);

  const whole = maySeePayroll(viewer, mine);
  /* The rail belongs here only for somebody for whom this page IS the
     section's payroll room. Everyone else who can reach it is reading their
     OWN row - a client contact with the flag, or a staff member who may not
     read the register but may always check their own pay - and a rail into
     the operator's books does not belong beside a pay stub. It would also be
     nine links that redirect them. */
  const fin = isStaffRole(user.role)
    ? await railContext(user, (await searchParams).period)
    : null;
  const inSection = fin?.seesPayroll === true;
  const all = (await db.select().from(payroll).where(eq(payroll.orgId, mine))
    .orderBy(asc(payroll.name), asc(payroll.effectiveOn))) as PayRow[];
  const rows = visibleRows(viewer, mine, all);
  // Nothing to show and no right to the register: this page does not exist for
  // them, which is the same answer they get about anything else that isn't
  // theirs.
  if (!whole && rows.length === 0) redirect("/");

  const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, mine));
  const today = shopToday();

  // Who this organization's payroll could be about, so nobody retypes a name
  // the app already knows. The shop's own house list, or a client's own
  // people - the same wall as everything else on this page.
  const candidates = whole
    ? user.orgId === null
      ? await db.select({ email: houseMembers.email, name: houseMembers.name })
          .from(houseMembers).where(and(eq(houseMembers.orgId, mine), ne(houseMembers.role, "none")))
          .orderBy(asc(houseMembers.name))
      : await db.select({ email: clientAllowlist.entry, name: clientAllowlist.entry })
          .from(clientAllowlist).where(eq(clientAllowlist.orgId, mine))
          .orderBy(asc(clientAllowlist.entry))
    : [];
  // Their profile fills the rest of the form: the name they are called and the
  // job they do are already on their account.
  const profiles = candidates.length
    ? await db.select({
        email: users.email, name: users.name, firstName: users.firstName,
        lastName: users.lastName, title: users.title,
      }).from(users).where(inArray(users.email, candidates.map((c) => c.email.toLowerCase())))
    : [];
  const profileOf = new Map(profiles.map((p) => [p.email.toLowerCase(), p]));
  const onPayroll = new Set(all.filter((r) => !r.endsOn || r.endsOn >= today)
    .map((r) => r.personEmail.toLowerCase()).filter(Boolean));
  const staff = candidates
    // A whole-domain allowlist rule is a door, not a person, so it is nobody
    // to put on a payroll.
    .filter((c) => !c.email.trim().startsWith("@"))
    .map((c) => {
      const p = profileOf.get(c.email.toLowerCase());
      const named = p ? [p.firstName, p.lastName].filter(Boolean).join(" ") || p.name || "" : "";
      return {
        email: c.email,
        name: named || c.name || c.email.split("@")[0],
        title: p?.title ?? "",
        already: onPayroll.has(c.email.toLowerCase()),
      };
    });
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
    <FinanceShell
      rail={inSection && fin
        ? { active: "payroll", amounts: fin.amounts, seesBooks: fin.seesBooks, seesPayroll: fin.seesPayroll }
        : null}
      period={fin?.period ?? "month"}
      path="/money/payroll"
      title="Payroll"
      sub={whole
        ? <>What {org?.name ?? "this organization"} pays its people, and what that makes a month cost.
            {isHouseOfThis && <> Running costs with a receipt live in <Link href="/money/expenses">Overhead</Link>.</>}</>
        : <>Your own pay, as it is recorded. Nobody else&apos;s is shown here.</>}
    >
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
        staff={staff}
      />
    </FinanceShell>
  );
}
