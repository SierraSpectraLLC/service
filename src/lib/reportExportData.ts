// Fetching what an export needs, once, for whichever format asked.
//
// Split from lib/reportExport (pure rows) and lib/reportPdf (pure drawing) so
// the three download routes below cannot drift about WHICH reports a person
// may take away. That question has exactly two answers in this app, and they
// are the ones the pages already use: lib/expenseReports.mayWorkReport for a
// single claim, and lib/hr.mayAdminPeople for everybody's.
//
// The tenant test is the other half and is not optional: expense_reports is
// one instance-wide table and `person` is free text, so a name match is not a
// scope. Every read here is stamped before a name is looked at, the same order
// app/actions.workableReport uses and for the reason spelled out there.

import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { expenseReports, expenses, houseMembers, orgSites, workOrders } from "@/db/schema";
import type { SessionUser } from "@/lib/authz";
import { houseOf } from "@/lib/authz";
import { mayAdminPeople } from "@/lib/hr";
import { mayWorkReport, reportTitle } from "@/lib/expenseReports";
import { forTenant, readTenant } from "@/lib/tenancy";
import type { ExportReport } from "@/lib/reportExport";

/** Everything the formats need, shaped once. */
async function shape(
  rows: (typeof expenseReports.$inferSelect)[], tenant: number | null,
): Promise<ExportReport[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [expenseRows, roster] = await Promise.all([
    db.select().from(expenses).where(inArray(expenses.reportId, ids))
      .orderBy(asc(expenses.incurredOn), asc(expenses.id)),
    db.select({ email: houseMembers.email, name: houseMembers.name }).from(houseMembers)
      .where(forTenant(houseMembers.orgId, tenant)),
  ]);
  const woIds = [...new Set([
    ...rows.map((r) => r.workOrderId), ...expenseRows.map((e) => e.workOrderId),
  ].filter((x): x is number => x !== null))];
  const siteIds = [...new Set(expenseRows.map((e) => e.siteId).filter((x): x is number => x !== null))];
  const [wos, sites] = await Promise.all([
    woIds.length
      ? db.select({ id: workOrders.id, number: workOrders.number }).from(workOrders).where(inArray(workOrders.id, woIds))
      : Promise.resolve([]),
    siteIds.length
      ? db.select({ id: orgSites.id, name: orgSites.name }).from(orgSites).where(inArray(orgSites.id, siteIds))
      : Promise.resolve([]),
  ]);
  const woNumber = (id: number | null) => (id === null ? "" : wos.find((w) => w.id === id)?.number ?? "");
  const siteName = (id: number | null) => (id === null ? "" : sites.find((s) => s.id === id)?.name ?? "");
  /* Addresses become names where the roster knows one. An accountant reading
     "opened by hr@sierra.test" has to go and ask who that is. */
  const who = (email: string) => {
    const e = email.trim().toLowerCase();
    if (!e) return "";
    return roster.find((m) => m.email.trim().toLowerCase() === e)?.name || email;
  };

  return rows.map((r) => {
    const mine = expenseRows.filter((e) => e.reportId === r.id);
    return {
      id: r.id,
      // The claim's own name, with the person-and-span fallback for anything
      // filed before names were required. One authority, so the download and
      // the page it came from cannot call the same claim two things.
      title: reportTitle(r, mine),
      person: r.person,
      purpose: r.purpose,
      status: r.status,
      workOrderNumber: woNumber(r.workOrderId),
      openedBy: who(r.openedBy),
      submittedOn: r.submittedAt.toISOString().slice(0, 10),
      paidOn: r.paidOn,
      paidRef: r.paidRef,
      expenses: mine.map((e) => ({
        incurredOn: e.incurredOn, kind: e.kind, description: e.description,
        amountCents: e.amountCents, billable: e.billable,
        workOrderNumber: woNumber(e.workOrderId), siteName: siteName(e.siteId),
        receiptName: e.receiptName || (e.receiptUrl ? "receipt" : ""),
        allowanceState: e.allowanceState, allowanceNote: e.allowanceNote,
        allowanceBy: who(e.allowanceBy),
      })),
    };
  });
}

/**
 * One claim, if this reader may take it away.
 *
 * Exactly the gate the record page runs - whose claim it is, inside the
 * tenant - because a download is a read, and a second, laxer rule on the
 * export route is how a report nobody may open leaves the building as a PDF.
 */
export async function exportableReport(
  u: SessionUser, id: number,
): Promise<{ report: ExportReport; receipts: { index: number; url: string; name: string }[] } | null> {
  const [row] = await db.select().from(expenseReports).where(eq(expenseReports.id, id));
  if (!row || !houseOf(u, row.tenantOrgId)) return null;
  const adminsPeople = await mayAdminPeople(u);
  if (!mayWorkReport({ name: u.name, adminsPeople }, row)) return null;

  const [report] = await shape([row], readTenant(u));
  const urls = await db.select().from(expenses).where(eq(expenses.reportId, id))
    .orderBy(asc(expenses.incurredOn), asc(expenses.id));
  return {
    report,
    receipts: urls
      .map((e, index) => ({ index, url: e.receiptUrl, name: e.receiptName || `receipt-${index + 1}` }))
      .filter((r) => r.url),
  };
}

/**
 * Every claim SETTLED in one month, for the accountant's monthly packet.
 *
 * Dated by the payout, not by submission or by the receipts: an expense report
 * hits the books when the shop paid it, so a claim submitted in July and paid
 * in August belongs in August's file. Getting that wrong is how a bookkeeper
 * accrues the same money twice.
 *
 * Whoever administers the people - which is HR and the owner - because this is
 * every engineer's spending in one download.
 */
export async function exportableMonth(u: SessionUser, month: string): Promise<ExportReport[] | null> {
  if (!(await mayAdminPeople(u))) return null;
  const t = readTenant(u);
  const rows = await db.select().from(expenseReports).where(and(
    forTenant(expenseReports.tenantOrgId, t),
    eq(expenseReports.status, "paid"),
    gte(expenseReports.paidOn, `${month}-01`),
    lte(expenseReports.paidOn, `${month}-31`),
  )).orderBy(asc(expenseReports.paidOn), asc(expenseReports.id));
  return shape(rows, t);
}

/** The months a monthly export would find anything in, newest first. */
export async function paidMonths(u: SessionUser): Promise<string[]> {
  if (!(await mayAdminPeople(u))) return [];
  const rows = await db.select({ paidOn: expenseReports.paidOn }).from(expenseReports)
    .where(and(forTenant(expenseReports.tenantOrgId, readTenant(u)), eq(expenseReports.status, "paid")))
    .orderBy(desc(expenseReports.paidOn));
  return [...new Set(rows.map((r) => r.paidOn.slice(0, 7)).filter((m) => /^\d{4}-\d{2}$/.test(m)))];
}
