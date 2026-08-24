import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { shelfFor } from "@/lib/storeData";
import StoreFront from "@/components/StoreFront";
import { PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The parts store, for a signed-in client. Everything on this page crossed
 * the client boundary already priced: lib/storeData builds the shelf from
 * staff data (catalog, price book, markup, stock) and only resale figures
 * make it into props. Vendors, costs and margins have no field to travel in.
 */
export default async function StorePage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  // Staff order through Purchasing; this door is the client's.
  if (isStaffRole(user.role) && user.orgId === null) redirect("/purchasing");
  if (user.orgId === null) redirect("/");
  const [org] = await db.select().from(orgs).where(eq(orgs.id, user.orgId));
  if (!org || org.kind !== "client") redirect("/");

  const { items, termsDays } = await shelfFor(org);

  return (
    <div className="container wide">
      <PageHead title="Parts"
        sub={`Stocked and serviced by us, priced for ${org.name}. Your equipment is already on file.`}
        actions={<Link href="/orders" className="btn sm" style={{ textDecoration: "none" }}>Your orders →</Link>} />
      <StoreFront items={items} orgName={org.name}
        hasYours={items.some((i) => i.fitsYours)}
        termsDays={termsDays} />
    </div>
  );
}
