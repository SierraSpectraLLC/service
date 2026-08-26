import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { instruments, orgs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { visibleSystemIds } from "@/lib/tenancy";
import { systemLabel } from "@/lib/systemLabel";
import { EmptyState, Id, PageHead, Panel, Pill } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * A reseller's own listings, and what a buyer sees of each.
 *
 * Every listing is a public page carrying its own token: the sign-off packet
 * and the service history a buyer would ask for, already attached, and nothing
 * about any other unit reachable from it. This page is the index that did not
 * exist - the tokens were mintable per unit from the record page, but their
 * owner had nowhere to see all of them at once or check what a buyer actually
 * gets.
 *
 * Resellers only. For a lab client this concept does not exist, and for staff
 * the same units are on the board.
 */
export default async function ListingsPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (isStaffRole(user.role) || user.orgId === null) redirect("/");

  const [org] = await db.select({ name: orgs.name, resale: orgs.resaleEnabled })
    .from(orgs).where(eq(orgs.id, user.orgId));
  // Not a door this account has. Same posture as every other nav gate here:
  // a page that would only redirect is a page nobody should be able to reach.
  if (!org?.resale) redirect("/");

  const visible = await visibleSystemIds(user);
  const rows = visible === null || visible.length === 0
    ? []
    : (await db.select().from(instruments)
        .where(and(eq(instruments.archived, false), eq(instruments.forSale, true)))
        .orderBy(asc(instruments.externalId)))
      .filter((i) => visible.includes(i.id));

  return (
    <div className="container wide">
      <PageHead
        title="Listings"
        sub={`Units ${org.name} has listed for sale, and the page a buyer sees of each.`}
      />
      <Panel title="Live listings" count={rows.length}
        empty="Nothing is listed for sale right now.">
        {rows.length > 0 && rows.map((i) => (
          <div key={i.id} className="ledger">
            <span className="grow">
              <Link href={`/instruments/${i.id}`} className="plain" style={{ fontWeight: 600 }}>
                <Id>{i.externalId}</Id>
              </Link>
              <span className="sub">
                {systemLabel(i, [])}
                {i.saleNote ? ` · ${i.saleNote}` : ""}
              </span>
            </span>
            {i.stages.includes("Waiting to ship")
              ? <Pill tone="warn">Sold, waiting to ship</Pill>
              : <Pill tone="good">Listed</Pill>}
            {i.listingToken
              ? <Link className="btn sm" href={`/listing/${i.listingToken}`}>Buyer&apos;s view</Link>
              : <span className="mut t-small">No public link yet</span>}
          </div>
        ))}
      </Panel>
      {rows.length === 0 && (
        <EmptyState
          title="List a unit from its own page."
          body="Open any unit and turn on its listing. It gets a public link of its own, with its sign-off packet and service history attached." />
      )}
    </div>
  );
}
