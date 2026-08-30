import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, expenseCategories, expenseReports, expenses, houseMembers, workOrders } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { forTenant, readTenant } from "@/lib/tenancy";
import {
  REPORT_LABEL, mayWorkReport, reimbursementPool, reportSpan, reportTitle, reportTotalCents,
} from "@/lib/expenseReports";
import { mayAdminPeople, reportSubjectFor } from "@/lib/hr";
import { resolveExpensePolicy } from "@/lib/expensePolicy";
import { workOrderTrip } from "@/lib/tripMiles";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { WO_LABEL } from "@/lib/workOrders";
import ExpenseReportDetail from "@/components/ExpenseReportDetail";
import { PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * One expense report, as a record page: fill it, submit it, watch it land.
 *
 * Visible to the person whose claim it is, and to whoever administers the
 * people - HR or the owner. Another engineer's claim is not anybody else's
 * business. lib/expenseReports.mayWorkReport is the rule; the tenant test above
 * it is the other half, because `person` is free text and a name is not a scope.
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
  const adminsPeople = await mayAdminPeople(user);
  const mayWork = mayWorkReport({ name: user.name, adminsPeople }, report);
  if (!mayWork) notFound();
  const mine = report.person === user.name;

  const [rows, categoryRows, allWos, myExpenses, roster] = await Promise.all([
    db.select().from(expenses).where(eq(expenses.reportId, id))
      .orderBy(desc(expenses.incurredOn), desc(expenses.id)),
    db.select().from(expenseCategories).where(forTenant(expenseCategories.tenantOrgId, t))
      .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.id)),
    db.select({ id: workOrders.id, number: workOrders.number, title: workOrders.title, state: workOrders.state })
      .from(workOrders).where(forTenant(workOrders.tenantOrgId, t))
      .orderBy(desc(workOrders.id)).limit(200),
    db.select().from(expenses).where(forTenant(expenses.tenantOrgId, t))
      .orderBy(desc(expenses.incurredOn), desc(expenses.id)),
    /* Addresses to names, for "opened by". The report's own workspace only -
       openedBy holds a login, and an address with no row here simply shows as
       nothing rather than as somebody else's colleague. */
    db.select({ email: houseMembers.email, name: houseMembers.name }).from(houseMembers)
      .where(and(forTenant(houseMembers.orgId, t), ne(houseMembers.role, "none"))),
  ]);
  const woNumber = new Map(allWos.map((w) => [w.id, w.number]));
  /*
   * The report's OWN job, which need not be among the 200 most recent orders
   * the picker offers: that limit is a list length, not a rule about which
   * jobs a claim may name, and a report filed against a long-closed one would
   * otherwise render its select with nothing chosen and read as overhead.
   * Fetched by id and put at the head of the list when it is missing.
   */
  const missing = report.workOrderId !== null && !woNumber.has(report.workOrderId)
    ? await db.select({ id: workOrders.id, number: workOrders.number, title: workOrders.title, state: workOrders.state })
      .from(workOrders).where(eq(workOrders.id, report.workOrderId))
    : [];
  const pickable = [...missing, ...allWos];
  const reportWoNumber = report.workOrderId === null ? ""
    : (pickable.find((w) => w.id === report.workOrderId)?.number ?? "");
  const openedByName = report.openedBy.trim()
    ? (roster.find((m) => m.email.trim().toLowerCase() === report.openedBy.trim().toLowerCase())?.name ?? "")
    : "";
  /* WHOSE unclaimed receipts, which is the report's person and not the reader.
     For an engineer filling their own the two are the same set; for HR filling
     a colleague's they are not, and computing it from the reader would offer
     the office manager their own receipts to put on somebody else's claim. */
  const subject = mine
    ? { name: user.name, email: user.email }
    : await reportSubjectFor(report);
  const pool = reimbursementPool(myExpenses, subject);

  /*
   * The travel rulebook, and this claim's trip under it.
   *
   * Both are needed by the add-expense dialog so it can answer the per diem
   * question the moment somebody picks the category, instead of asking for a
   * distance the app already knows. The miles are measured from the SUBJECT's
   * home - the person the money is owed to - which is why this waits for the
   * subject lookup above rather than using the reader's address.
   *
   * Only for a claim that names a job: no job, no site, no distance, and the
   * dialog is the plain one it has always been.
   */
  const [policyRow, trip] = await Promise.all([
    db.select({ expensePolicy: appSettings.expensePolicy }).from(appSettings).where(eq(appSettings.id, 1)),
    report.workOrderId !== null && subject.email
      ? workOrderTrip(subject.email, report.workOrderId).catch(() => null)
      : Promise.resolve(null),
  ]);

  const total = reportTotalCents(rows);
  return (
    <div className="container">
      <PageHead
        crumb={<><Link href="/money">Financial</Link> › <Link href="/money/reimbursements">Reimbursements</Link> › <b>Report</b></>}
        /* The claim's own name leads - every report opened since the form
           insisted on one has it. lib/expenseReports.reportTitle carries the
           person-and-span fallback for the ones filed before that, so this
           page and the desk that links here cannot call a claim two things. */
        title={reportTitle(report, rows)}
        sub={(report.title ? `${report.person} · ${reportSpan(rows) || "no dated rows"} · ` : "")
          + `${reportWoNumber || "overhead"} · `
          + `${REPORT_LABEL[report.status] ?? report.status}${total ? ` · ${formatCents(total)}` : ""}${report.status === "paid" ? ` · paid ${report.paidOn}${report.paidRef ? ` (${report.paidRef})` : ""}` : ""}`}
      />
      <ExpenseReportDetail
        report={{
          id: report.id, person: report.person, status: report.status,
          title: report.title, purpose: report.purpose,
          workOrderId: report.workOrderId, workOrderNumber: reportWoNumber,
          openedByName,
          submittedAt: report.submittedAt.toISOString().slice(0, 10),
          paidOn: report.paidOn, paidRef: report.paidRef, returnedReason: report.returnedReason,
        }}
        rows={rows.map((r) => ({
          id: r.id, kind: r.kind, description: r.description, amountCents: r.amountCents,
          incurredOn: r.incurredOn, workOrderId: r.workOrderId,
          workOrderNumber: r.workOrderId !== null ? (woNumber.get(r.workOrderId) ?? "") : "",
          receiptUrl: r.receiptUrl, receiptName: r.receiptName,
          /* The trip behind the row, so opening it again reopens the same
             trip rather than resetting it to the job's default lab and a day
             out - which would re-price somebody's two nights away the moment
             they came back to fix a typo. */
          siteId: r.siteId, nights: r.allowanceNights,
          allowanceState: r.allowanceState, allowanceNote: r.allowanceNote,
          allowanceByName: r.allowanceBy.trim()
            ? (roster.find((m) => m.email.trim().toLowerCase() === r.allowanceBy.trim().toLowerCase())?.name
              ?? r.allowanceBy)
            : "",
        }))}
        mayWork={mayWork} mine={mine} isOwner={isOwner} today={shopToday()}
        adminsPeople={adminsPeople}
        policy={resolveExpensePolicy(policyRow[0]?.expensePolicy ?? null)}
        tripSites={trip?.sites ?? []}
        defaultSiteId={trip?.defaultSiteId ?? null}
        categories={categoryRows.map((c) => c.name)}
        workOrders={pickable.map((w) => ({
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
