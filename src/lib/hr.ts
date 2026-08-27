// HR: who administers the people, and how the app finds out.
//
// One question - "does this person's own row say they administer their
// colleagues" - and one place that asks it. That is the entire reason this
// file exists. Before it, `seesPayroll` was computed in five places from four
// different sets of facts (the layout said `role === "owner" || allowRow`, the
// rail said maySeePayroll, financeFigures hardcoded the flag to false), and
// lib/financeData already had a comment warning that "a page that computed
// seesPayroll slightly differently from the rail beside it is exactly the leak
// this section had to be built around". Adding a second way to earn the
// privilege would have turned that warning into an incident.
//
// The rule itself is not here. lib/payroll.maySeePayroll decides; this only
// fetches the two facts it cannot know without a database.

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { clientAllowlist, houseMembers } from "@/db/schema";
import { maySeePayroll, type PayrollViewer } from "@/lib/payroll";
import { forTenant } from "@/lib/tenancy";

/**
 * The session facts this needs, structurally rather than as a SessionUser.
 *
 * Deliberately not importing lib/authz: that reaches @/auth, which reaches
 * Auth.js and next/server, and a helper the PGlite tests cannot import is a
 * helper the PGlite tests will not use. Same shape and same reasoning as
 * lib/storeUsage.storeTenantFor.
 */
export type HouseUser = {
  email: string;
  role: string;
  orgId: number | null;
  operatorOrgId: number | null;
  rootOperatorOrgId: number | null;
};

/** lib/authz.myTenantOrgId, inlined for the reason above. Never null on a configured instance. */
const myTenant = (u: HouseUser): number | null => u.operatorOrgId ?? u.rootOperatorOrgId;

/**
 * Is this person HR in their own workspace?
 *
 * False for a client, whatever their allowlist says: HR is a fact about the
 * house's own roster, and a client contact has no row on it. False for anyone
 * with no house row at all, which is how a STAFF_EMAILS break-glass session
 * lands here - break-glass is a way in, not a promotion.
 */
export async function isHouseHr(u: HouseUser): Promise<boolean> {
  if (u.orgId !== null) return false;
  const [row] = await db.select({ can: houseMembers.canAdminPeople })
    .from(houseMembers).where(eq(houseMembers.email, u.email.trim().toLowerCase()));
  return row?.can ?? false;
}

/**
 * Everything lib/payroll needs to know about whoever is asking.
 *
 * The flag comes from whichever roster this person is actually on - the
 * client allowlist for a client, house_members for the house - and
 * maySeePayroll reads one field either way. An owner's answer does not depend
 * on it, so their row is not fetched.
 */
export async function payrollViewerFor(u: HouseUser): Promise<PayrollViewer> {
  const shared = { email: u.email, role: u.role, orgId: u.orgId, operatorOrgId: myTenant(u) };
  // An owner's answer does not depend on the flag - maySeePayroll grants them
  // the register on the role alone - so their row is not fetched, and `true`
  // here is the honest value rather than a shortcut.
  if (u.role === "owner") return { ...shared, canSeePayroll: true };
  if (u.orgId !== null) {
    const [row] = await db.select({ canSeePayroll: clientAllowlist.canSeePayroll })
      .from(clientAllowlist).where(eq(clientAllowlist.entry, u.email.trim().toLowerCase()));
    return { ...shared, canSeePayroll: row?.canSeePayroll ?? false };
  }
  return { ...shared, canSeePayroll: await isHouseHr(u) };
}

/**
 * The one flag the nav, the rail and every room in the section share: may this
 * person read THEIR OWN organization's payroll register.
 *
 * "Their own" is the client's org for a client and the workspace they are
 * staff of for the house - the same id lib/payroll would be handed by the
 * page, asked once here so the word in the menu and the page behind it cannot
 * disagree.
 */
export async function seesPayrollFor(u: HouseUser): Promise<boolean> {
  const mine = u.orgId ?? myTenant(u);
  if (mine === null) return false;
  return maySeePayroll(await payrollViewerFor(u), mine);
}

/**
 * May this person administer their colleagues - file a claim for one, open a
 * report in their name, read the roster as a roster?
 *
 * The owner of the workspace, and whoever they have made HR. A client never,
 * whatever flags their allowlist row carries: those are privileges over their
 * OWN organization's records, and their organization has no house.
 */
export async function mayAdminPeople(u: HouseUser): Promise<boolean> {
  if (u.orgId !== null) return false;
  return u.role === "owner" || await isHouseHr(u);
}

/**
 * Whose claim this is, as somebody a reimbursement pool can be computed for.
 *
 * expense_reports.person is a directory NAME - see the column - so the address
 * has to be looked up, and lib/expenseReports.reimbursementPool needs it: a
 * receipt logged against a job with nobody named belongs to whoever LOGGED it,
 * and matching those rows is the difference between HR finding a colleague's
 * road expenses and finding half of them. Not finding an address is not an
 * error; plenty of names on a report belong to somebody who has never signed
 * in, and an empty string matches no row rather than every row.
 *
 * Scoped to the report's own workspace, because `person` is free text and two
 * service companies can genuinely both employ a Steve Jones.
 */
export async function reportSubjectFor(
  report: { person: string; tenantOrgId: number | null },
): Promise<{ name: string; email: string }> {
  const [row] = await db.select({ email: houseMembers.email }).from(houseMembers)
    .where(and(eq(houseMembers.name, report.person), forTenant(houseMembers.orgId, report.tenantOrgId)));
  return { name: report.person, email: row?.email ?? "" };
}
