import { redirect } from "next/navigation";
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { instruments, orgSites, workOrders } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole, mayCreateOrgs, tenantViewer } from "@/lib/tenants";
import { forTenant, readTenant, visibleOrgs } from "@/lib/tenancy";
import { clientRoster, filterRoster } from "@/lib/clientRoster";
import { PageHead } from "@/components/ui";
import ClientRosterPanel from "@/components/ClientRosterPanel";

export const dynamic = "force-dynamic";

/** Work orders that have not been put away. lib/workOrders.woSettled, as SQL. */
const SETTLED = ["closed", "cancelled"];

/**
 * The client roster.
 *
 * "Who are our clients" is a daily question in a service company and the only
 * room that answered it was Settings > Clients & orgs, which is owner-only -
 * so an engineer could work on a client's system all week without being able
 * to look the company up, and an engineer who picked up a new client had to
 * find somebody with the rights to type the name in.
 *
 * STAFF, then, and adding is staff too. That is not a loosening: addOrg has
 * been requireStaff since it was written - "their clients are theirs to
 * create" - and the only thing that gated it in practice was which page the
 * form happened to sit on.
 *
 * What is NOT here is the configuration: who may sign in, what has been shared
 * with them, where their reports go. Those stay the owner's, in the Settings
 * room, which this page links to for the reader who has it. Two rooms because
 * they are two questions, not one question told twice - see lib/clientRoster.
 */
export default async function ClientsPage({ searchParams }: {
  searchParams: Promise<{ q?: string; kind?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const { q = "", kind = "" } = await searchParams;

  const t = readTenant(user);
  const [orgRows, systemRows, siteRows, workRows] = await Promise.all([
    // The same scope the Settings list uses, so the two rooms cannot disagree
    // about which companies exist.
    visibleOrgs(user),
    db.select({ ownerOrgId: instruments.ownerOrgId }).from(instruments)
      .where(and(eq(instruments.archived, false), forTenant(instruments.tenantOrgId, t))),
    db.select({ orgId: orgSites.orgId }).from(orgSites)
      .where(and(eq(orgSites.archived, false), forTenant(orgSites.tenantOrgId, t))),
    /* Still going, rather than every work order ever raised: a lifetime count
       only grows, so it says the same thing about a client the shop finished
       with in March as about the one it is on site at today. */
    db.select({ orgId: workOrders.orgId }).from(workOrders)
      .where(and(notInArray(workOrders.state, SETTLED), forTenant(workOrders.tenantOrgId, t))),
  ]);

  /* The shop itself is not one of its own clients. visibleOrgs includes it -
     tenantOf() resolves an operator to itself, and every other caller wants it
     in the picker - and a shop listed among the companies it works for reads
     as a mistake. isOperator is the test rather than the reader's own org id,
     because a staff member's orgId is null: they belong to the workspace
     through operatorOrgId, so comparing ids here would have filtered nothing. */
  const roster = clientRoster(
    orgRows
      .filter((o) => !o.isOperator)
      .map((o) => ({ id: o.id, name: o.name, kind: o.kind, themeColor: o.themeColor, prospect: o.prospect })),
    systemRows, siteRows, workRows,
  ).sort((a, b) => a.name.localeCompare(b.name));

  const shown = filterRoster(roster, { q, kind });
  const clients = roster.filter((o) => o.kind === "client").length;

  return (
    <div className="container">
      <PageHead title="Clients"
        sub={clients
          ? `${clients} compan${clients === 1 ? "y" : "ies"} the shop works for, and what of theirs it looks after.`
          : "The companies the shop works for, and what of theirs it looks after."} />
      <div className="card">
        <ClientRosterPanel
          rows={shown}
          filter={{ q, kind }}
          /* The organization record is the owner's room. Everybody else reads
             the row, which is why the row carries the counts. */
          canOpen={user.role === "owner"}
          canAdd={mayCreateOrgs(tenantViewer(user))}
        />
      </div>
    </div>
  );
}
