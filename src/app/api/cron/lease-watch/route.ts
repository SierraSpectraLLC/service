import { NextResponse } from "next/server";
import { and, eq, isNull, lt } from "drizzle-orm";
import { cronAuthorized } from "@/lib/cronAuth";
import { db } from "@/db";
import { deviceLeases, remoteDevices } from "@/db/schema";
import { houseEmails } from "@/lib/house";
import { sendEmail } from "@/lib/email";
import { leaseConfig } from "@/lib/leaseGuardData";

/**
 * The dead-man's switch on OUR side.
 *
 * A lease guard locks when it hears nothing, and the header of lib/leaseGuard
 * names the real hazard: the commonest cause of a guard hearing nothing is our
 * own outage - a broken renew endpoint, an expired key, a bad deploy - not
 * theft. If that happens quietly, every armed system in the field lapses at
 * once, none of them stolen, and we find out when a customer calls.
 *
 * This is how we find out first. A lease whose expiry has passed while it is
 * still armed, unreleased and unsuspended has gone a full lease period with no
 * successful renewal. A handful of those is ordinary - machines get switched
 * off. A whole fleet at once is us, and the mail says which it looks like.
 *
 * It only reports; it never renews or unlocks. Fixing our pipeline is a
 * person's job, and a cron that tried to paper over a broken key by minting
 * leases would be defeating the point of having one.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!leaseConfig()) {
    return NextResponse.json({ watched: 0, reason: "lease enforcement not configured" });
  }

  const now = new Date();
  // Armed, not released, not deliberately suspended, and past its expiry: a
  // lease that should have renewed and did not.
  const quiet = await db.select({
    deviceId: deviceLeases.deviceId,
    tenantOrgId: deviceLeases.tenantOrgId,
    expiresAt: deviceLeases.expiresAt,
    lastRenewedAt: deviceLeases.lastRenewedAt,
    name: remoteDevices.nickname,
    hostname: remoteDevices.name,
  }).from(deviceLeases)
    .leftJoin(remoteDevices, eq(remoteDevices.id, deviceLeases.deviceId))
    .where(and(
      eq(deviceLeases.armed, true),
      isNull(deviceLeases.releasedAt),
      isNull(deviceLeases.suspendedAt),
      lt(deviceLeases.expiresAt, now),
    ))
    .catch(() => []);

  if (quiet.length === 0) return NextResponse.json({ watched: 0, quiet: 0 });

  // One report per operator, its own machines only - the same posture as the
  // usage cron. Each operator hears about its own fleet, never another's.
  const byTenant = new Map<number, typeof quiet>();
  for (const q of quiet) {
    if (q.tenantOrgId === null) continue;
    const list = byTenant.get(q.tenantOrgId) ?? [];
    list.push(q);
    byTenant.set(q.tenantOrgId, list);
  }

  let sent = 0;
  for (const [tenantOrgId, list] of byTenant) {
    const to = await houseEmails(tenantOrgId).catch(() => []);
    if (!to.length) continue;
    const rows = list.map((q) => {
      const label = q.name || q.hostname || `device ${q.deviceId}`;
      const since = q.lastRenewedAt ? q.lastRenewedAt.toISOString().slice(0, 10) : "never";
      return `<tr><td style="padding:4px 10px;border-top:1px solid #E2E8F0;">${esc(label)}</td>`
        + `<td style="padding:4px 10px;border-top:1px solid #E2E8F0;font-family:monospace;">last renewed ${since}</td></tr>`;
    }).join("");
    const body = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#1E293B;">`
      + `<p><strong>${list.length}</strong> armed ${list.length === 1 ? "lease has" : "leases have"} gone a full lease period `
      + `without renewing.</p>`
      + `<p style="color:#64748B;">A few usually means machines switched off. A large share at once usually means the `
      + `renewal path is broken on our side - check the key and <code>/api/remote/lease</code> before these lapse into `
      + `locks on working systems.</p>`
      + `<table style="border-collapse:collapse;">${rows}</table></div>`;
    await sendEmail(to, `Lease guard: ${list.length} system${list.length === 1 ? "" : "s"} not renewing`, body)
      .catch(() => {});
    sent++;
  }

  return NextResponse.json({ quiet: quiet.length, reportsSent: sent });
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
