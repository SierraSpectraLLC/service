import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { expenseReports, expenses, houseMembers, payroll } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { forTenant, readTenant } from "@/lib/tenancy";
import { mayAdminPeople, seesPayrollFor } from "@/lib/hr";
import { editableReport, reimbursementPool, reportTotalCents } from "@/lib/expenseReports";
import { payrollForMonth, type PayRow } from "@/lib/payroll";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { PageHead, Panel } from "@/components/ui";
import PeopleDesk, { type RosterRow } from "@/app/people/PeopleDesk";

export const dynamic = "force-dynamic";

/**
 * The HR room.
 *
 * A distinct route rather than a widened Settings page, for the same reason
 * /owner is one: the questions are different questions. Settings › Our people
 * is administration - who has a login, what it can reach, how to get them back
 * in when mail stops arriving. This is the people themselves: who is on the
 * roster, what each of them is owed and has not been paid, and who is allowed
 * to sort that out.
 *
 * WHO GETS IN. mayAdminPeople - the owner, and whoever the owner has made HR.
 * Not the books: every figure on this page is a payroll or a reimbursement
 * figure, which is what an HR flag buys, and there is deliberately nothing
 * here about what the shop invoiced. See lib/hr and lib/books.
 *
 * WHOSE PEOPLE. One workspace's, from house_members.org_id. house_members is a
 * single instance-wide table and this page names people by name beside what
 * they are owed - reading all of it would put one company's engineers on
 * another company's roster, which is the bug Settings › Our people already had
 * once. Platform staff read the instance, which is the support path readTenant
 * returns null for.
 */
export default async function PeoplePage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  if (!(await mayAdminPeople(user))) redirect("/");

  const t = readTenant(user);
  const today = shopToday();
  const isOwner = user.role === "owner";

  const [members, reportRows, expenseRows, seesPay] = await Promise.all([
    db.select().from(houseMembers)
      .where(and(forTenant(houseMembers.orgId, t), ne(houseMembers.role, "none")))
      .orderBy(asc(houseMembers.name), asc(houseMembers.email)),
    db.select().from(expenseReports).where(forTenant(expenseReports.tenantOrgId, t))
      .orderBy(desc(expenseReports.submittedAt)),
    db.select().from(expenses).where(forTenant(expenses.tenantOrgId, t)),
    seesPayrollFor(user),
  ]);

  /*
   * What the company pays per month, for the one line at the bottom. Fetched
   * only for a reader who may read a register - mayAdminPeople and
   * maySeePayroll are separate rules and could in principle disagree, and when
   * they do the answer is the stricter one. Nobody's individual pay appears on
   * this page either way; that is /money/payroll, one click away.
   */
  const payRows: PayRow[] = seesPay && t !== null
    ? (await db.select().from(payroll).where(eq(payroll.orgId, t))) as PayRow[]
    : [];
  const month = payrollForMonth(payRows, today.slice(0, 7));

  const open = reportRows.filter((r) => r.status !== "paid");
  const awaiting = reportRows.filter((r) => r.status === "submitted");
  /* A report never stores a total - it is summed from its rows, so an edit
     before payout can never leave a stale number for the payout to trust. The
     same rule the desk and the payout action follow. */
  const awaitingCents = reportTotalCents(
    expenseRows.filter((e) => e.reportId !== null && awaiting.some((r) => r.id === e.reportId)),
  );

  const roster: RosterRow[] = members.map((m) => {
    /* Their pool, by the same rule the desk uses - the row NAMES them, or they
       logged it against a job without naming anyone else. Asking
       reimbursementPool rather than filtering on the name here is the point:
       one authority, so this page and the claim it links to cannot disagree
       about what somebody is owed. */
    const pool = reimbursementPool(expenseRows, { name: m.name, email: m.email });
    const theirs = open.filter((r) => r.person === m.name);
    return {
      email: m.email,
      name: m.name,
      role: m.role,
      isHr: m.canAdminPeople,
      /* Somebody with no name set cannot be the subject of a report at all -
         expense_reports.person is a directory name. Worth saying on the row,
         because the alternative is a picker that quietly omits them. */
      nameable: m.name.trim() !== "",
      unclaimedCents: reportTotalCents(pool),
      unclaimedCount: pool.length,
      draftCount: theirs.filter((r) => editableReport(r.status)).length,
      submittedCount: theirs.filter((r) => r.status === "submitted").length,
    };
  });

  const owedCents = roster.reduce((n, r) => n + r.unclaimedCents, 0);

  return (
    <div className="container wide">
      <PageHead
        title="People"
        sub="Your roster, what each person is out of pocket for, and who is allowed to sort it out."
      />

      <Panel
        title="What the shop owes its own people"
        hint="Money somebody has fronted and not been paid back for. The pool is what has not been claimed yet; a claim awaiting payout is money the owner has been asked for."
        actions={<Link className="btn sm" href="/money/reimbursements">Reimbursements</Link>}
      >
        <div className="lanes">
          <div className="ledger">
            <div className="mut t-small">Unclaimed, across everybody</div>
            <div className="t-figure">{formatCents(owedCents)}</div>
          </div>
          <div className="ledger">
            <div className="mut t-small">Claims awaiting payout</div>
            <div className="t-figure">{formatCents(awaitingCents)}</div>
            <div className="mut t-small">
              {awaiting.length === 0
                ? "Nothing waiting"
                : `${awaiting.length} claim${awaiting.length === 1 ? "" : "s"}`}
            </div>
          </div>
          {seesPay && (
            <div className="ledger">
              <div className="mut t-small">Payroll, per month</div>
              <div className="t-figure">{formatCents(month.totalCents)}</div>
              <div className="mut t-small">
                {month.headcount ? `${Math.round(month.headcount * 10) / 10} FTE · ` : ""}
                <Link href="/money/payroll">the register</Link>
              </div>
            </div>
          )}
        </div>
      </Panel>

      <PeopleDesk roster={roster} isOwner={isOwner} />
    </div>
  );
}
