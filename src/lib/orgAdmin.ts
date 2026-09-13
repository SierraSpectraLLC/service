// Who may open "My organization", and whose organization that is.
//
// One gate for the hub and every room in it, so the section a person sees in
// their account menu and the pages behind it cannot disagree about who gets
// in. The rule is lib/hr.mayAdminPeople - the owner, and whoever they have
// made HR - which is the same rule the roster page has always enforced; this
// only adds the answer to "which company", which the roster page computes on
// its own and the sites page had never asked.
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { orgs } from "@/db/schema";
import { myTenantOrgId, requireUser, type SessionUser } from "@/lib/authz";
import { mayAdminPeople } from "@/lib/hr";
import { isStaffRole } from "@/lib/tenants";

export type OrgAdmin = {
  user: SessionUser;
  /** The workspace's own organization - the company whose people and sites these are. */
  org: typeof orgs.$inferSelect;
  isOwner: boolean;
};

/**
 * The reader, their company, or a redirect.
 *
 * WHOSE company: the workspace this person is staff of, by the same
 * arithmetic /money/payroll and /people use (myTenantOrgId), so the roster,
 * the register and the sites all name one organization. Deliberately not
 * readTenant, which is null for the root operator's own staff - the platform
 * support path - and the root owner is exactly the person this section is
 * for.
 */
export async function requireOrgAdmin(): Promise<OrgAdmin> {
  let user: SessionUser;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  if (!(await mayAdminPeople(user))) redirect("/");
  const orgId = user.orgId ?? myTenantOrgId(user);
  const [org] = orgId === null ? [] : await db.select().from(orgs).where(eq(orgs.id, orgId));
  // A staff account with no company is lib/tenants' "sees nothing" case;
  // there is no organization page to show them.
  if (!org) redirect("/");
  return { user, org, isOwner: user.role === "owner" };
}
