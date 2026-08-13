// The database half of house-role resolution. lib/houseRole holds the rules;
// this fetches the rows they need. Separate so the rules stay testable and so
// nothing on the sign-in path imports more than it must.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, houseMembers } from "@/db/schema";
import { parseList } from "@/lib/allowMatch";
import {
  houseEmailsFrom, houseIdentityFor, houseRoleFor, rootOwner,
  type HouseRole, type MemberRow,
} from "@/lib/houseRole";

const envStaff = () => parseList(process.env.STAFF_EMAILS);

/**
 * The operator that runs this instance. Its staff support every tenant, so this
 * one id decides who is platform staff and who is boxed into their own workspace
 * (see lib/tenants).
 *
 * Null means no operator has been named yet, which lib/tenants reads as "one
 * house, no tenancy" - the world before this existed. Caught rather than thrown
 * because it is read on the sign-in path.
 */
export async function rootOperatorOrgId(): Promise<number | null> {
  const [s] = await db.select({ operatorOrgId: appSettings.operatorOrgId })
    .from(appSettings).where(eq(appSettings.id, 1)).catch(() => []);
  return s?.operatorOrgId ?? null;
}

/**
 * Every managed row. Wrapped in a catch because this is read on the sign-in
 * path: a deploy that lands before the schema sync must degrade to "env only"
 * rather than locking the whole instance out.
 */
export async function houseMemberRows(): Promise<MemberRow[]> {
  return db.select({ email: houseMembers.email, role: houseMembers.role, orgId: houseMembers.orgId })
    .from(houseMembers)
    .catch(() => [] as MemberRow[]);
}

/**
 * The house role for an email, or null. The root owner short-circuits with no
 * query at all - it keeps the owner's own sign-in as cheap as it was before
 * roles moved into the database, and it means the break-glass login doesn't
 * depend on this table being readable.
 */
export async function houseRoleForEmail(email: string): Promise<HouseRole | null> {
  const env = envStaff();
  if (rootOwner(env) === email.trim().toLowerCase()) return "owner";
  return houseRoleFor(email, env, await houseMemberRows());
}

/**
 * The house role and the service company it is held at, for the session. One
 * round trip for the rows plus one for the root operator, both on the sign-in
 * path, so they go together rather than in sequence.
 */
export async function houseIdentityForEmail(email: string): Promise<{
  role: HouseRole; orgId: number | null; rootOrgId: number | null;
} | null> {
  const [members, rootOrgId] = await Promise.all([houseMemberRows(), rootOperatorOrgId()]);
  const id = houseIdentityFor(email, envStaff(), members, rootOrgId);
  return id && { ...id, rootOrgId };
}

/**
 * Who gets staff mail: digests, gas alerts, access requests, queue kicks.
 *
 * `tenantOrgId` names the workspace it concerns, and passing it is what stops one
 * operator's engineers being emailed about another operator's instrument. Leave it
 * out only for a message about the instance itself.
 */
export async function houseEmails(tenantOrgId?: number | null): Promise<string[]> {
  const [members, rootOrgId] = await Promise.all([houseMemberRows(), rootOperatorOrgId()]);
  return houseEmailsFrom(envStaff(), members, tenantOrgId, rootOrgId);
}
