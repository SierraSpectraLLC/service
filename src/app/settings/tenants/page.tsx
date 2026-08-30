import { redirect } from "next/navigation";
import { asc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  clientAllowlist, houseMembers, instruments, orgs, remoteDevices, systemShares,
} from "@/db/schema";
import { requirePlatformOwner } from "@/lib/authz";
import { shopTime } from "@/lib/shopday";
import TenantConsole from "@/components/TenantConsole";

export const dynamic = "force-dynamic";

/**
 * The service companies on this instance, and what each of them is using.
 *
 * Two jobs. It is where a workspace is opened for a company that has just bought
 * the product - one form, and they can sign in - and it is the meter: seats,
 * clients, systems and machines per workspace are the numbers any price is built
 * from, so they are counted here rather than reconstructed from the database when
 * an invoice is due.
 *
 * Platform-owner only, and deliberately not a tenant's page: an operator sees
 * their own workspace everywhere else in Settings and has no business knowing who
 * else is on the instance.
 */
export default async function TenantsPage() {
  let user;
  try { user = await requirePlatformOwner(); } catch { redirect("/settings/organizations"); }

  const [operators, staffRows, clientRows, systemRows, deviceRows, shareRows] = await Promise.all([
    db.select().from(orgs).where(eq(orgs.isOperator, true)).orderBy(asc(orgs.name)),
    db.select({ orgId: houseMembers.orgId, role: houseMembers.role, email: houseMembers.email })
      .from(houseMembers).where(ne(houseMembers.role, "none")),
    // A client organization and, separately, the logins that reach it.
    db.select({ parentOrgId: orgs.parentOrgId, id: orgs.id }).from(orgs)
      .where(eq(orgs.isOperator, false)),
    db.select({ tenantOrgId: instruments.tenantOrgId, archived: instruments.archived }).from(instruments),
    db.select({ tenantOrgId: remoteDevices.tenantOrgId }).from(remoteDevices).catch(() => []),
    db.select({ orgId: systemShares.orgId }).from(systemShares),
  ]);

  const logins = await db.select({ orgId: clientAllowlist.orgId }).from(clientAllowlist)
    .where(isNotNull(clientAllowlist.orgId));
  const clientOf = new Map(clientRows.map((c) => [c.id, c.parentOrgId]));

  const count = <T,>(rows: T[], of: (r: T) => number | null | undefined, id: number) =>
    rows.filter((r) => of(r) === id).length;

  const rows = operators.map((o) => ({
    id: o.id,
    name: o.name,
    // Seats: what a per-technician price would read.
    staff: staffRows.filter((s) => s.orgId === o.id).length,
    owners: staffRows.filter((s) => s.orgId === o.id && s.role === "owner").length,
    clients: clientRows.filter((c) => c.parentOrgId === o.id).length,
    // Client logins are free by design - the whole point of the portal - so they
    // are counted to show the value rather than to charge for it.
    clientLogins: logins.filter((l) => clientOf.get(l.orgId!) === o.id).length,
    systems: count(systemRows, (r) => r.tenantOrgId, o.id),
    live: systemRows.filter((r) => r.tenantOrgId === o.id && !r.archived).length,
    machines: count(deviceRows, (r) => r.tenantOrgId, o.id),
    // Work another operator has invited them onto: the collaboration the shared
    // instance exists for, and not something they are charged twice for.
    invitedOnto: shareRows.filter((s) => s.orgId === o.id).length,
    // What they are entitled to. Blank is full and is what every workspace
    // opened through the form on this page has - a free one arrived by
    // accepting somebody's hand-off, which nobody here was asked about. See
    // lib/plan.
    plan: o.plan,
    planSince: o.planSince,
    // Room granted to this one workspace by hand, above the tier. Zero on all
    // but the ones somebody deliberately stretched - see lib/plan.
    freeClients: o.freeClients,
    since: shopTime(o.createdAt),
  }));

  const unassigned = staffRows.filter((s) => s.orgId === null).map((s) => s.email);

  return (
    <div>
      <TenantConsole rows={rows} unassigned={unassigned} rootOrgId={user.rootOperatorOrgId} />
    </div>
  );
}
