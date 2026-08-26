import { redirect } from "next/navigation";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { orgSites, instruments, orgs, systemShares, assets, accessRequests, engagementRecords, users } from "@/db/schema";
import { currentUser } from "@/lib/authz";
import { isPlatformStaff, tenantViewer } from "@/lib/tenants";
import { shopTime } from "@/lib/shopday";
import { systemLabel } from "@/lib/systemLabel";
import { forTenant, readTenant, visibleOrgs } from "@/lib/tenancy";
import { tempState } from "@/lib/tempPassword";
import SharePanel from "@/components/SharePanel";
import AccessRequestsPanel from "@/components/AccessRequestsPanel";
import HouseMembersPanel from "@/components/HouseMembersPanel";
import { PageHead, Panel } from "@/components/ui";
import { listHouseMembers } from "@/app/actions";

export const dynamic = "force-dynamic";

/**
 * Every access decision on one page, for the platform operator. The per-system
 * sharing panel already assigns owners and adds or withdraws organizations;
 * gathering all of them here is what makes a wrongly granted claim fixable
 * without hunting for the system it happened on. Reuses SharePanel rather than
 * duplicating its rules - the server enforces the same ones either way.
 */
export default async function AdminSettingsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  // Owner only: this page can move ownership of anything.
  if (user.role !== "owner") redirect("/");
  const isPlatform = isPlatformStaff(tenantViewer(user));

  /**
   * This page moves ownership, so it lists everything - and "everything" has to
   * mean this workspace's everything. Unscoped, a second service company's owner
   * read the first one's systems by external id and saw who they were shared
   * with. readTenant is null for platform staff, and forTenant then drops the
   * predicate, which is how the instance's own operator keeps seeing all of it.
   */
  const tenant = readTenant(user);
  const siteRows = await db.select({
    name: orgSites.name, address: orgSites.address, orgName: orgs.name,
  }).from(orgSites).innerJoin(orgs, eq(orgs.id, orgSites.orgId))
    .where(and(eq(orgSites.archived, false), forTenant(orgSites.tenantOrgId, tenant)))
    .orderBy(asc(orgs.name), asc(orgSites.name));
  const [rows, orgRows, assetRows, shareRows, requestRows, recordRows] = await Promise.all([
    db.select().from(instruments).where(forTenant(instruments.tenantOrgId, tenant))
      .orderBy(asc(instruments.archived), asc(instruments.externalId)),
    visibleOrgs(user),
    db.select({ instrumentId: assets.instrumentId, kind: assets.kind, model: assets.model, sortOrder: assets.sortOrder })
      .from(assets).where(forTenant(assets.tenantOrgId, tenant)),
    // The share and request rows hang off a system rather than carrying a stamp,
    // so they are scoped through the system they belong to.
    db.select({ instrumentId: systemShares.instrumentId, orgId: systemShares.orgId, access: systemShares.access, name: orgs.name, kind: orgs.kind })
      .from(systemShares)
      .innerJoin(orgs, eq(orgs.id, systemShares.orgId))
      .innerJoin(instruments, eq(instruments.id, systemShares.instrumentId))
      .where(forTenant(instruments.tenantOrgId, tenant))
      .orderBy(asc(orgs.name)),
    db.select({ id: accessRequests.id, instrumentId: accessRequests.instrumentId, kind: accessRequests.kind, requestedBy: accessRequests.requestedBy, message: accessRequests.message, createdAt: accessRequests.createdAt, orgName: orgs.name, orgKind: orgs.kind })
      .from(accessRequests)
      .innerJoin(orgs, eq(orgs.id, accessRequests.orgId))
      .innerJoin(instruments, eq(instruments.id, accessRequests.instrumentId))
      .where(and(eq(accessRequests.status, "pending"), forTenant(instruments.tenantOrgId, tenant)))
      .orderBy(asc(accessRequests.createdAt)),
    // Current records only: a superseded one is still on disk and still reads
    // at its URL, but "who holds a frozen copy" is answered by the live set.
    // Scoped by the ORG that holds it, since the system it froze may be gone.
    db.select({ id: engagementRecords.id, instrumentId: engagementRecords.instrumentId, kind: engagementRecords.kind, externalId: engagementRecords.externalId, revokedAt: engagementRecords.revokedAt, orgName: orgs.name })
      .from(engagementRecords)
      .innerJoin(orgs, eq(orgs.id, engagementRecords.orgId))
      .where(and(
        isNull(engagementRecords.supersededAt),
        tenant === null ? undefined : or(
        // tenantOf(), spelled in SQL: an org belongs to its parent, EXCEPT an
        // operator org, which belongs to itself and is created with a null
        // parent. Matching on parentOrgId alone therefore dropped every
        // operator-held record - including the reading operator's own.
        eq(orgs.parentOrgId, tenant),
        and(eq(orgs.isOperator, true), eq(orgs.id, tenant)),
      ),
      ))
      .orderBy(asc(engagementRecords.revokedAt)),
  ]);

  // Who we are, before who owns what: this is the list that decides who can
  // change everything else on this page.
  const houseRows = await listHouseMembers();
  // Whether a password is standing in for the codes on each of them, and how
  // much longer - the same fact the client people list shows.
  const houseEmailList = houseRows.map((m) => m.email.toLowerCase());
  const houseAccounts = houseEmailList.length
    ? await db.select({
        email: users.email, passwordHash: users.passwordHash, passwordTempUntil: users.passwordTempUntil,
      }).from(users).where(inArray(users.email, houseEmailList))
    : [];
  const nowStamp = new Date();
  const houseAccountOf = new Map(houseAccounts.map((a) => [a.email.toLowerCase(), a]));

  const byId = new Map(rows.map((i) => [i.id, i]));
  const pendingBySystem = new Map<number, typeof requestRows>();
  for (const r of requestRows) {
    if (!pendingBySystem.has(r.instrumentId)) pendingBySystem.set(r.instrumentId, []);
    pendingBySystem.get(r.instrumentId)!.push(r);
  }

  return (
    <div>
      <PageHead title="People & ownership"
        sub="People, access and ownership." />

      <HouseMembersPanel
        members={houseRows.map((m) => {
          const a = houseAccountOf.get(m.email.toLowerCase());
          const st = a ? tempState(a, nowStamp) : { kind: "none" as const };
          return {
            ...m,
            password: st.kind === "none" ? "" : st.kind === "own" ? "their own"
              : st.kind === "expired" ? "expired" : `${st.daysLeft}d left`,
          };
        })}
        myEmail={user.email}
        sites={siteRows.map((x) => {
          const site = x.name || x.address.split("\n")[0] || "site";
          // Some shops name sites with the client already in them.
          return { label: site.startsWith(x.orgName) ? site : `${x.orgName} - ${site}`, address: x.address };
        })} />

      {requestRows.length > 0 && (
        <Panel title="Waiting on a decision" count={requestRows.length}>
          {requestRows.map((r) => {
            const inst = byId.get(r.instrumentId);
            return (
              <div key={r.id} style={{ borderTop: "1px solid var(--line)", paddingTop: 8, marginTop: 8 }}>
                <Link href={`/instruments/${r.instrumentId}`} className="mono t-small" style={{ fontWeight: 700, textDecoration: "none", color: "var(--navy)" }}>
                  {inst?.externalId ?? `system ${r.instrumentId}`}
                </Link>
                <AccessRequestsPanel isOperator requests={[{
                  id: r.id, orgName: r.orgName, orgKind: r.orgKind, kind: r.kind,
                  requestedBy: r.requestedBy, message: r.message, when: shopTime(r.createdAt),
                }]} />
              </div>
            );
          })}
        </Panel>
      )}

      {/* One row per system, closed by default: at a dozen systems the old
          card-per-system layout was three screens of "Not shared with anyone".
          The summary line answers the audit question - who owns it, who sees
          it - and the full sharing panel opens only for the row being worked. */}
      <Panel title="Access &amp; ownership" count={rows.length}
        hint="Open a row to change the owner or sharing.">
        {rows.map((inst) => {
          const shares = shareRows.filter((s) => s.instrumentId === inst.id);
          const label = systemLabel(inst, assetRows.filter((a) => a.instrumentId === inst.id));
          const records = recordRows.filter((r) => r.instrumentId === inst.id);
          const ownerName = inst.ownerOrgId !== null
            ? orgRows.find((o) => o.id === inst.ownerOrgId)?.name ?? "an organization"
            : null;
          return (
            <details key={inst.id} style={{ borderTop: "1px solid var(--line)" }}>
              <summary className="row-hover" style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", padding: "9px 4px", cursor: "pointer", listStyle: "none" }}>
                <span className="mono t-small" style={{ fontWeight: 700, color: "var(--navy)" }}>{inst.externalId}</span>
                <span className="t-body" style={{ flex: "1 1 160px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {label || <span className="mut">No assets listed</span>}
                  {inst.client && <span className="mut"> · {inst.client}</span>}
                </span>
                {inst.archived && <span className="pill neutral">archived</span>}
                {(pendingBySystem.get(inst.id)?.length ?? 0) > 0 && (
                  <span className="pill warn">
                    {pendingBySystem.get(inst.id)!.length} waiting
                  </span>
                )}
                <span className="mut t-small">
                  {ownerName ? `owned by ${ownerName}` : "unclaimed"}
                  {shares.length > 0 && ` · shared with ${shares.length}`}
                </span>
              </summary>
              <div style={{ padding: "0 4px 10px" }}>
                <div style={{ marginBottom: 4 }}>
                  <Link href={`/instruments/${inst.id}`} className="btn link" style={{ fontSize: 12 }}>Open {inst.externalId} →</Link>
                </div>
                <SharePanel targetId={inst.id} shares={shares.map((s) => ({ orgId: s.orgId, name: s.name, kind: s.kind, access: s.access }))}
                  orgOptions={orgRows} ownerOrgId={inst.ownerOrgId} canManageAll canAddProvider={false} />
                {records.length > 0 && (
                  <div className="mut t-meta" style={{ marginTop: 8 }}>
                    Frozen records held by: {records.map((r) => `${r.orgName} (${r.kind === "handoff" ? "handed on" : "access ended"} ${shopTime(r.revokedAt)})`).join(", ")}
                  </div>
                )}
              </div>
            </details>
          );
        })}
        {rows.length === 0 && (
          <div className="empty"><b>No systems yet</b></div>
        )}
      </Panel>
    </div>
  );
}
