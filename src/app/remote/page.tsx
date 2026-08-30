import { redirect } from "next/navigation";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { deviceLeases, deviceLockouts, deviceNotices, instruments, orgs, remoteDevices, safetyHolds } from "@/db/schema";
import { requireUser, viewContext } from "@/lib/authz";
import { getModules } from "@/lib/flags";
import { shopTime } from "@/lib/shopday";
import { consentModeFor, remoteAbility } from "@/lib/remoteAccess";
import { listGroupDevices, NOT_CONFIGURED, reconcileOrgDevices, remoteConfigured } from "@/lib/remote";
import { leaseState } from "@/lib/leaseGuard";
import { leaseConfig } from "@/lib/leaseGuardData";
import { forTenant, readTenant, visibleOrgs, visibleSystemIds } from "@/lib/tenancy";
import RemoteDevicesPanel from "@/components/RemoteDevicesPanel";
import { PageHead } from "@/components/ui";

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
  const orgRows = await visibleOrgs(user).catch(() => []);
  const orgsInView = isHouseUser
    ? orgRows
    : orgRows.filter((o) => o.id === user.orgId && o.remoteAccessEnabled);

  if (!isHouseUser && orgsInView.length === 0) redirect("/");

  // Refresh the cache from the engine where we can. A failure here is expected
  // and silent: the cached rows below are what the page actually renders.
  let engineReachable = configured;
  if (configured) {
    for (const o of orgsInView) {
      if (!o.remoteGroupId) continue;
      const live = await listGroupDevices(o.remoteGroupId);
      if (live === null) { engineReachable = false; continue; }
      await reconcileOrgDevices(o.id, live).catch(() => {});
    }
  }

  const orgIds = orgsInView.map((o) => o.id);
  const deviceRows = await db.select().from(remoteDevices)
    .where(isHouseUser
      // The house also sees machines that enrolled before anyone assigned them -
      // its own, though: an unassigned machine still carries the workspace whose
      // installer created it.
      ? and(
        forTenant(remoteDevices.tenantOrgId, readTenant(user)),
        or(orgIds.length ? inArray(remoteDevices.orgId, orgIds) : sql`false`, isNull(remoteDevices.orgId)),
      )
      : orgIds.length ? inArray(remoteDevices.orgId, orgIds) : sql`false`)
    // Sorted by what the list actually shows: a machine somebody named should
    // sort under that name, not under the hostname nobody reads.
    .orderBy(asc(sql`coalesce(nullif(${remoteDevices.nickname}, ''), ${remoteDevices.name})`), asc(remoteDevices.id))
    .catch(() => []);

  // What each machine is currently saying about itself. Two queries for the
  // whole page rather than two per row, and only the OPEN ones - a cleared
  // notice is history, and history belongs in the audit trail rather than on
  // a device list.
  const deviceIds = deviceRows.map((d) => d.id);
  const [noticeRows, holdRows, lockoutRows, leaseRows] = deviceIds.length === 0 ? [[], [], [], []] : await Promise.all([
    db.select().from(deviceNotices)
      .where(and(inArray(deviceNotices.deviceId, deviceIds), isNull(deviceNotices.clearedAt)))
      .catch(() => []),
    db.select().from(safetyHolds)
      .where(and(inArray(safetyHolds.deviceId, deviceIds), isNull(safetyHolds.clearedAt)))
      .catch(() => []),
    db.select().from(deviceLockouts)
      .where(and(inArray(deviceLockouts.deviceId, deviceIds), isNull(deviceLockouts.releasedAt)))
      .catch(() => []),
    db.select().from(deviceLeases)
      .where(and(inArray(deviceLeases.deviceId, deviceIds), isNull(deviceLeases.releasedAt)))
      .catch(() => []),
  ]);
  const noticeByDevice = new Map(noticeRows.map((n) => [n.deviceId, n]));
  const holdByDevice = new Map(holdRows.map((h) => [h.deviceId, h]));
  const lockoutByDevice = new Map(lockoutRows.map((l) => [l.deviceId, l]));
  const leaseByDevice = new Map(leaseRows.map((l) => [l.deviceId, l]));
  const leaseReady = leaseConfig() !== null;

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
  const orgById = new Map(orgsInView.map((o) => [o.id, o]));

  const devices = deviceRows.map((d) => {
    const org = d.orgId === null ? null : orgById.get(d.orgId) ?? null;
    const system = d.instrumentId === null ? null : systemById.get(d.instrumentId) ?? null;
    const ability = remoteAbility(
      user, { moduleOn, personaActive: persona !== null },
      { orgId: d.orgId, tenantOrgId: d.tenantOrgId }, { remoteAccessEnabled: org?.remoteAccessEnabled ?? false },
    );
    const consent = consentModeFor(d, system ? { ownerOrgId: system.ownerOrgId, stages: system.stages } : null);
    const notice = noticeByDevice.get(d.id) ?? null;
    const hold = holdByDevice.get(d.id) ?? null;
    const lockout = lockoutByDevice.get(d.id) ?? null;
    return {
      id: d.id,
      name: d.name,
      nickname: d.nickname,
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
      notice: notice ? {
        body: notice.body, approvedBy: notice.approvedBy,
        rung: notice.rung as "notice" | "prominent" | "at_login",
        posted: shopTime(notice.createdAt),
      } : null,
      hold: hold ? {
        reason: hold.reason, decidedBy: hold.decidedBy,
        effect: hold.effect as "advise" | "hold" | "lock",
        contact: hold.contact, faultSource: hold.faultSource,
        dispatchedTo: hold.dispatchedTo, raised: shopTime(hold.createdAt),
      } : null,
      // A notice is the owner's to post and a hold is any engineer's to raise -
      // the same split the two server actions enforce, said here so the button
      // is absent rather than refused.
      canPostNotice: ability.unlink && user.role === "owner",
      canRaiseHold: ability.unlink && isHouseUser,
      // Whether the machine has actually been told. A notice nobody could
      // deliver is the failure mode this page exists to make visible.
      noticePushed: d.noticePushedAt ? shopTime(d.noticePushedAt) : "",
      noticeError: d.noticeError,
      lockout: lockout ? {
        reference: lockout.reference, reason: lockout.reason, contact: lockout.contact,
        force: lockout.force as "notify" | "logoff" | "shutdown",
        decidedBy: lockout.decidedBy, raised: shopTime(lockout.createdAt),
        lastEnforced: lockout.lastEnforcedAt ? shopTime(lockout.lastEnforcedAt) : "",
        enforceError: lockout.enforceError,
      } : null,
      // Reporting a machine stolen is the owner's call alone, matching the
      // action's own gate.
      canLock: ability.unlink && user.role === "owner",
      lease: (() => {
        const l = leaseByDevice.get(d.id);
        if (!l) return null;
        const state = leaseState(
          { armed: l.armed, expiresAt: l.expiresAt, graceDays: l.graceDays, releasedAt: l.releasedAt, force: l.force as "notify" | "lock" },
          new Date(),
        );
        return {
          armed: l.armed, force: l.force as "notify" | "lock",
          leaseDays: l.leaseDays, graceDays: l.graceDays, state,
          expires: l.expiresAt ? shopTime(l.expiresAt) : "",
          lastRenewed: l.lastRenewedAt ? shopTime(l.lastRenewedAt) : "",
          suspended: l.suspendedAt !== null, suspendReason: l.suspendReason,
        };
      })(),
      // Arming and releasing a lease is owner-only, and only when the signing
      // key exists - otherwise the controls promise something that cannot be sent.
      canManageLease: ability.unlink && user.role === "owner" && leaseReady,
    };
  }).filter((d) => d.canConnect || d.canManage || d.refusal !== "" || isHouseUser);

  return (
    <div className="container page">
      <PageHead
        crumb={<>Operations › <b>Remote support</b></>}
        title="Remote support"
        sub={devices.length === 0 ? "No machines enrolled yet."
          : `${devices.length} machine${devices.length === 1 ? "" : "s"} enrolled.`}
      />

      {!configured && (
        <div className="card" style={{ borderLeft: "4px solid #8A5410" }}>
          <div className="t-body" style={{ fontWeight: 700, color: "var(--navy)", marginBottom: 4 }}>
            No support host configured yet
          </div>
          <div className="mut t-small">{NOT_CONFIGURED}</div>
        </div>
      )}
      {configured && !engineReachable && (
        <div className="card" style={{ borderLeft: "4px solid #8A5410" }}>
          <div className="t-body" style={{ fontWeight: 700, color: "var(--navy)", marginBottom: 4 }}>
            Can&apos;t reach the support host
          </div>
          <div className="mut t-small">
            Showing the last known state. Connecting may still work.
          </div>
        </div>
      )}

      <RemoteDevicesPanel
        devices={devices}
        systems={systemRows.map((s) => ({ id: s.id, label: `${s.externalId}${s.client ? ` · ${s.client}` : ""}` }))}
        enrollOrgs={isHouseUser ? orgsInView.map((o) => ({ id: o.id, name: o.name })) : []}
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
