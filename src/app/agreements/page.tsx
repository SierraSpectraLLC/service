import { asc, desc, eq, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { agreements, orgs } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import { isPlatformStaff, tenantViewer } from "@/lib/tenants";
import { forTenant, readTenant, visibleOrgs } from "@/lib/tenancy";
import { needsAttention } from "@/lib/agreements";
import { usageForAll } from "@/lib/agreementUsage";
import { shopToday } from "@/lib/shopday";
import SettingsTabs from "@/components/SettingsTabs";
import AgreementsPanel from "@/components/AgreementsPanel";

export const dynamic = "force-dynamic";

/**
 * The paper behind the work, across every client: what is in force, what is up
 * for renewal, and how much of each allowance is left.
 *
 * Staff only, and deliberately so. A client sees their own agreement on their
 * own organization page; this is the book of business, and one client reading
 * another's contract terms is the worst leak this application could have.
 */
export default async function AgreementsPage() {
  let user;
  try { user = await requireStaff(); } catch { redirect("/"); }
  const today = shopToday();
  const tenant = readTenant(user);

  const rows = await db.select().from(agreements)
    .where(forTenant(agreements.tenantOrgId, tenant))
    .orderBy(asc(agreements.endsOn), desc(agreements.id));

  const orgIds = [...new Set(rows.map((r) => r.orgId))];
  const [orgRows, allOrgs] = await Promise.all([
    orgIds.length ? db.select({ id: orgs.id, name: orgs.name }).from(orgs).where(inArray(orgs.id, orgIds)) : [],
    visibleOrgs(user),
  ]);
  const name = new Map(orgRows.map((o) => [o.id, o.name]));

  // Drawn down from the work itself, every time this page renders. One pass per
  // agreement; a shop with hundreds would want this batched, and would also
  // want a different page.
  const usage = await usageForAll(rows);
  const nothing = { partsCents: 0, visits: 0, laborMinutes: 0 };

  const shaped = rows.map((r) => ({
    id: r.id, orgId: r.orgId, orgName: name.get(r.orgId) ?? "an organization",
    kind: r.kind, number: r.number, title: r.title, status: r.status,
    startsOn: r.startsOn, endsOn: r.endsOn, renewNoticeDays: r.renewNoticeDays,
    visitsIncluded: r.visitsIncluded, partsAllowanceCents: r.partsAllowanceCents,
    laborIncludedMinutes: r.laborIncludedMinutes, valueCents: r.valueCents, note: r.note,
    used: usage.get(r.id) ?? nothing,
  }));

  const chase = needsAttention(shaped, today);
  const rest = shaped.filter((r) => !chase.includes(r));

  return (
    <div className="container settings">
      <SettingsTabs active="agreements" isOwner={user.role === "owner"} isPlatform={isPlatformStaff(tenantViewer(user))} />

      {chase.length > 0 && (
        <AgreementsPanel rows={chase} today={today}
          orgs={allOrgs.map((o) => ({ id: o.id, name: o.name }))} canEdit
          title={`Needs attention · ${chase.length}`} />
      )}

      <AgreementsPanel rows={rest} today={today}
        orgs={allOrgs.map((o) => ({ id: o.id, name: o.name }))} canEdit
        title={chase.length ? "Everything else" : "Agreements"} />

      <div className="mut" style={{ fontSize: 12, padding: "0 4px" }}>
        Allowances are summed from the work every time this page loads - parts fitted on
        their systems inside the term, closed work orders, hours logged - so what you see
        here is what the record says rather than a balance somebody kept by hand.
        Add an agreement from the organization&apos;s own settings page.
      </div>
    </div>
  );
}
