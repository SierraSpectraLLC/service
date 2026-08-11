import { redirect } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { instruments, orgs, systemShares, assets, accessRequests, engagementRecords } from "@/db/schema";
import { currentUser } from "@/lib/authz";
import { shopTime } from "@/lib/shopday";
import { systemLabel } from "@/lib/systemLabel";
import SharePanel from "@/components/SharePanel";
import AccessRequestsPanel from "@/components/AccessRequestsPanel";
import SettingsTabs from "@/components/SettingsTabs";
import HouseMembersPanel from "@/components/HouseMembersPanel";
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

  const [rows, orgRows, assetRows, shareRows, requestRows, recordRows] = await Promise.all([
    db.select().from(instruments).orderBy(asc(instruments.archived), asc(instruments.externalId)),
    db.select({ id: orgs.id, name: orgs.name, kind: orgs.kind }).from(orgs).orderBy(asc(orgs.name)),
    db.select({ instrumentId: assets.instrumentId, kind: assets.kind, model: assets.model, sortOrder: assets.sortOrder }).from(assets),
    db.select({ instrumentId: systemShares.instrumentId, orgId: systemShares.orgId, access: systemShares.access, name: orgs.name, kind: orgs.kind })
      .from(systemShares).innerJoin(orgs, eq(orgs.id, systemShares.orgId)).orderBy(asc(orgs.name)),
    db.select({ id: accessRequests.id, instrumentId: accessRequests.instrumentId, kind: accessRequests.kind, requestedBy: accessRequests.requestedBy, message: accessRequests.message, createdAt: accessRequests.createdAt, orgName: orgs.name, orgKind: orgs.kind })
      .from(accessRequests).innerJoin(orgs, eq(orgs.id, accessRequests.orgId))
      .where(eq(accessRequests.status, "pending")).orderBy(asc(accessRequests.createdAt)),
    // Current records only: a superseded one is still on disk and still reads
    // at its URL, but "who holds a frozen copy" is answered by the live set.
    db.select({ id: engagementRecords.id, instrumentId: engagementRecords.instrumentId, kind: engagementRecords.kind, externalId: engagementRecords.externalId, revokedAt: engagementRecords.revokedAt, orgName: orgs.name })
      .from(engagementRecords).innerJoin(orgs, eq(orgs.id, engagementRecords.orgId))
      .where(isNull(engagementRecords.supersededAt))
      .orderBy(asc(engagementRecords.revokedAt)),
  ]);

  // Who we are, before who owns what: this is the list that decides who can
  // change everything else on this page.
  const houseRows = await listHouseMembers();

  const byId = new Map(rows.map((i) => [i.id, i]));
  const pendingBySystem = new Map<number, typeof requestRows>();
  for (const r of requestRows) {
    if (!pendingBySystem.has(r.instrumentId)) pendingBySystem.set(r.instrumentId, []);
    pendingBySystem.get(r.instrumentId)!.push(r);
  }

  return (
    <div className="container page">
      <SettingsTabs active="admin" />

      <HouseMembersPanel members={houseRows} myEmail={user.email} />

      <div className="card">
        <div className="card-title">Access &amp; ownership</div>
        <div className="mut" style={{ fontSize: 12 }}>
          Every system, who owns it, and who can see it. An ownership claim granted in error is undone by
          reassigning the owner and withdrawing the share.
        </div>
      </div>

      {requestRows.length > 0 && (
        <div className="card">
          <div className="card-title">Waiting on a decision ({requestRows.length})</div>
          {requestRows.map((r) => {
            const inst = byId.get(r.instrumentId);
            return (
              <div key={r.id} style={{ borderTop: "1px solid var(--line)", paddingTop: 8, marginTop: 8 }}>
                <Link href={`/instruments/${r.instrumentId}`} className="mono" style={{ fontSize: 12, fontWeight: 700, textDecoration: "none", color: "var(--navy)" }}>
                  {inst?.externalId ?? `system ${r.instrumentId}`}
                </Link>
                <AccessRequestsPanel isOperator requests={[{
                  id: r.id, orgName: r.orgName, orgKind: r.orgKind, kind: r.kind,
                  requestedBy: r.requestedBy, message: r.message, when: shopTime(r.createdAt),
                }]} />
              </div>
            );
          })}
        </div>
      )}

      {rows.map((inst) => {
        const shares = shareRows.filter((s) => s.instrumentId === inst.id);
        const label = systemLabel(inst, assetRows.filter((a) => a.instrumentId === inst.id));
        const records = recordRows.filter((r) => r.instrumentId === inst.id);
        return (
          <div className="card" key={inst.id}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <Link href={`/instruments/${inst.id}`} className="mono" style={{ fontSize: 13, fontWeight: 700, textDecoration: "none", color: "var(--navy)" }}>
                {inst.externalId}
              </Link>
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--navy)" }}>
                {label || <span className="mut" style={{ fontWeight: 400, fontSize: 13 }}>No assets listed</span>}
              </span>
              {inst.client && <span className="mut" style={{ fontSize: 12 }}>· {inst.client}</span>}
              {inst.archived && <span className="pill" style={{ background: "#E2E8F0", color: "#475569" }}>archived</span>}
              {inst.ownerOrgId === null && (
                <span className="pill" style={{ background: "#FAF0DC", color: "#8A5410" }}>unclaimed</span>
              )}
              {(pendingBySystem.get(inst.id)?.length ?? 0) > 0 && (
                <span className="pill" style={{ background: "#F2E0CC", color: "#8A5410" }}>
                  {pendingBySystem.get(inst.id)!.length} waiting
                </span>
              )}
            </div>
            <SharePanel targetId={inst.id} shares={shares.map((s) => ({ orgId: s.orgId, name: s.name, kind: s.kind, access: s.access }))}
              orgOptions={orgRows} ownerOrgId={inst.ownerOrgId} canManageAll canAddProvider={false} />
            {records.length > 0 && (
              <div className="mut" style={{ fontSize: 11, marginTop: 8 }}>
                Frozen records held by: {records.map((r) => `${r.orgName} (${r.kind === "handoff" ? "handed on" : "access ended"} ${shopTime(r.revokedAt)})`).join(", ")}
              </div>
            )}
          </div>
        );
      })}

      {rows.length === 0 && (
        <div className="card"><div className="mut" style={{ fontSize: 13 }}>No systems yet.</div></div>
      )}
    </div>
  );
}
