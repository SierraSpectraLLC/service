// The database half of house-role resolution. lib/houseRole holds the rules;
// this fetches the rows they need. Separate so the rules stay testable and so
// nothing on the sign-in path imports more than it must.
import { db } from "@/db";
import { houseMembers } from "@/db/schema";
import { parseList } from "@/lib/allowMatch";
import { houseEmailsFrom, houseRoleFor, rootOwner, type HouseRole, type MemberRow } from "@/lib/houseRole";

const envStaff = () => parseList(process.env.STAFF_EMAILS);

/**
 * Every managed row. Wrapped in a catch because this is read on the sign-in
 * path: a deploy that lands before the schema sync must degrade to "env only"
 * rather than locking the whole instance out.
 */
export async function houseMemberRows(): Promise<MemberRow[]> {
  return db.select({ email: houseMembers.email, role: houseMembers.role })
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

/** Who gets staff mail: digests, gas alerts, access requests, house queue kicks. */
export async function houseEmails(): Promise<string[]> {
  return houseEmailsFrom(envStaff(), await houseMemberRows());
}
