import { redirect } from "next/navigation";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import OperatorOwnerView from "./OperatorOwnerView";
import ClientOwnerView from "./ClientOwnerView";

export const dynamic = "force-dynamic";

/**
 * The owner view: what somebody who OWNS a business needs from this portal,
 * rather than what somebody working a job in it needs.
 *
 * Two owners, and they want different things. The operator's owner runs the
 * service company - what is owed, what is stuck, what needs deciding. The
 * client's owner runs a lab that BUYS the service - what it is costing, what
 * is covered, what is waiting on them. Neither is a work queue.
 *
 * WHY TWO FILES BEHIND ONE ROUTE. allInvoices(tenantOrgId) and
 * invoicesForOrg(orgId) have the same shape and the same return type, and
 * exactly one of them is safe to render to a client. Nothing in the type
 * system separates them; the only enforcement this repo has is which file
 * calls which, checked by a grep in tests/invoiceIsolation. A page that forked
 * by role inside one file would make that check unexpressible - it would see
 * the workspace-wide reader in a file that also renders to clients and could
 * not tell whether the branch was reachable. So the fork happens here, in a
 * file that reads nothing, and each view keeps its own doors.
 *
 * This page is a SUMMARY. Every figure links into the section that owns it -
 * /money, /work, the system record - rather than being reproduced here. There
 * is one set of totals in this application and it lives in lib/financeData; a
 * second page computing its own would be two answers to one question.
 */
export default async function OwnerPage({ searchParams }: {
  searchParams: Promise<{ period?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { period } = await searchParams;

  // Staff get the operator view; everybody else is reading their own
  // organization's account. The books gate is NOT re-derived here - each view
  // calls the same booksContext / maySeeOrgMoney the rest of the application
  // does, and a viewer who may not read money gets a page without those bands
  // rather than a redirect into nowhere.
  return isStaffRole(user.role)
    ? <OperatorOwnerView user={user} periodParam={period} />
    : <ClientOwnerView user={user} />;
}
