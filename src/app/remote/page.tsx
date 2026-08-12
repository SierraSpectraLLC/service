import { redirect } from "next/navigation";
import { asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { instruments, orgs, remoteDevices } from "@/db/schema";
import { requireUser, viewContext } from "@/lib/authz";
import { getModules } from "@/lib/flags";
import { shopTime } from "@/lib/shopday";
import { consentModeFor, remoteAbility } from "@/lib/remoteAccess";
import { listGroupDevices, NOT_CONFIGURED, reconcileOrgDevices, remoteConfigured } from "@/lib/remote";
import { visibleSystemIds } from "@/lib/tenancy";
import RemoteDevicesPanel from "@/components/RemoteDevicesPanel";

export const dynamic = "force-dynamic";

/**
 * Remote support: the lab PCs we can reach, and the button that reaches them.
 *
 * Replaces the current arrangement, where a machine runs TeamViewer or
 * UltraViewer permanently and an engineer gets in with the PC's password. Here
 * identity comes from the portal session, so access is per-person, revocable,
 * and written down.
 *
 * Renders usefully in every degraded state, because it will spend its first
 * weeks in them: module on but no host configured, host unreachable, host fine
 * but no machines enrolled yet. None of those is an error page.
 */
export default async function RemotePage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { remote: moduleOn } = await getModules();
  if (!moduleOn) redirect("/");

  const isHouseUser = user.role === "owner" || user.role === "staff";
  const { persona } = await viewContext();
  const configured = remoteConfigured();

  // Which organizations' machines this person may look at.
  const orgRows = await db.select({
    id: orgs.id, name: orgs.name, remoteAccessEnabled: orgs.remoteAccessEnabled, groupId: orgs.remoteGroupId,
  }).from(orgs).orderBy(asc(orgs.name)).catch(() => []);
  const visibleOrgs = isHouseUser
    ? orgRows
    : orgRows.filter((o) => o.id === user.orgId && o.remoteAccessEnabled);

  if (!isHouseUser && visibleOrgs.length === 0) redirect("/");

  // Refresh the cache from the engine where we can. A failure here is expected
  // and silent: the cached rows below are what the page actually renders.
  let engineReachable = configured;
  if (configured) {
    for (const o of visibleOrgs) {
      if (!o.groupId) continue;
      const live = await listGroupDevices(o.groupId);
      if (live === null) { engineReachable = false; continue; }
      await reconcileOrgDevices(o.id, live).catch(() => {});
    }
  }

  const orgIds = visibleOrgs.map((o) => o.id);
  const deviceRows = await db.select().from(remoteDevices)
    .where(isHouseUser
      // The house also sees machines that enrolled before anyone assigned them.
      ? or(orgIds.length ? inArray(remoteDevices.orgId, orgIds) : sql`false`, isNull(remoteDevices.orgId))
      : orgIds.length ? inArray(remoteDevices.orgId, orgIds) : sql`false`)
    .orderBy(asc(remoteDevices.name), asc(remoteDevices.id))
    .catch(() => []);

  // The systems each device could be linked to, and the custody facts that decide
  // whether a session needs somebody at the far end.
  const visible = await visibleSystemIds(user);
  const systemRows = await db.select({
    id: instruments.id, externalId: instruments.externalId, client: instruments.client,
    ownerOrgId: instruments.ownerOrgId, stages: instruments.stages,
  }).from(instruments)
    .where(and0(visible))
    .orderBy(asc(instruments.externalId))
    .catch(() => []);
  const systemById = new Map(systemRows.map((s) => [s.id, s]));
  const orgById = new Map(visibleOrgs.map((o) => [o.id, o]));

  const devices = deviceRows.map((d) => {
    const org = d.orgId === null ? null : orgById.get(d.orgId) ?? null;
    const system = d.instrumentId === null ? null : systemById.get(d.instrumentId) ?? null;
    const ability = remoteAbility(
      user, { moduleOn, personaActive: persona !== null },
      { orgId: d.orgId, tenantOrgId: d.tenantOrgId }, { remoteAccessEnabled: org?.remoteAccessEnabled ?? false },
    );
    const consent = consentModeFor(d, system ? { ownerOrgId: system.ownerOrgId, stages: system.stages } : null);
    return {
      id: d.id,
      name: d.name || "(unnamed machine)",
      orgName: d.orgId === null ? "" : org?.name ?? "another organization",
      platform: d.platform,
      lastSeen: d.lastSeenAt ? shopTime(d.lastSeenAt) : "",
      // "Online" is a cache, not a live fact, whenever the host is unreachable -
      // the panel says which it is rather than showing a confident green dot.
      online: d.lastSeenAt !== null && Date.now() - d.lastSeenAt.getTime() < 3 * 60_000,
      systemId: d.instrumentId,
      systemLabel: system ? `${system.externalId}${system.client ? ` · ${system.client}` : ""}` : "",
      consentMode: consent.mode,
      consentWhy: consent.why,
      consentOverride: d.consentOverride,
      canConnect: ability.connect,
      refusal: ability.refusal,
      canManage: ability.unlink,
    };
  }).filter((d) => d.canConnect || d.canManage || d.refusal !== "" || isHouseUser);

  return (
    <div className="container page">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Remote support</h1>
        <span className="mut" style={{ fontSize: 12 }}>
          {devices.length === 0 ? "no machines enrolled"
            : `${devices.length} machine${devices.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {!configured && (
        <div className="card" style={{ borderLeft: "4px solid #8A5410" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--navy)", marginBottom: 4 }}>
            No support host configured yet
          </div>
          <div className="mut" style={{ fontSize: 12 }}>{NOT_CONFIGURED}</div>
        </div>
      )}
      {configured && !engineReachable && (
        <div className="card" style={{ borderLeft: "4px solid #8A5410" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--navy)", marginBottom: 4 }}>
            Can&apos;t reach the support host
          </div>
          <div className="mut" style={{ fontSize: 12 }}>
            Showing the last known state. Connecting may still work.
          </div>
        </div>
      )}

      <RemoteDevicesPanel
        devices={devices}
        systems={systemRows.map((s) => ({ id: s.id, label: `${s.externalId}${s.client ? ` · ${s.client}` : ""}` }))}
        enrollOrgs={isHouseUser ? visibleOrgs.map((o) => ({ id: o.id, name: o.name })) : []}
        canEnroll={isHouseUser && configured}
        stale={!engineReachable}
      />
    </div>
  );
}

/** Systems this viewer may see; `null` from visibleSystemIds means no restriction. */
function and0(visible: number[] | null) {
  if (visible === null) return undefined;
  return visible.length ? inArray(instruments.id, visible) : sql`false`;
}
