import { NextResponse } from "next/server";
import { gt, isNull, or } from "drizzle-orm";
import { cronAuthorized } from "@/lib/cronAuth";
import { db } from "@/db";
import { deviceLockouts, deviceNotices, safetyHolds } from "@/db/schema";
import { noticesForDevice } from "@/lib/fleetNoticeData";
import { enforceDeviceLockout } from "@/lib/deviceLockoutData";
import { pushNoticesTo, remoteConfigured } from "@/lib/remote";

/**
 * Re-assert what every machine should be saying about itself, and re-apply
 * every theft lockout.
 *
 * Needed because the agent holds its message list in memory (see
 * lib/remote.pushNoticesTo): a PC that reboots overnight comes back with a
 * clean tray and no idea it was carrying a notice. Posting once would mean the
 * notice quietly lapses on exactly the machines most likely to be power-cycled.
 *
 * Delivery is therefore eventually-consistent rather than once-and-done. The
 * server actions push immediately so the person who posted a notice sees it
 * land; this is what makes the notice still be there tomorrow, and what
 * finally retracts one from a machine that was offline when it was cleared.
 */

/**
 * How long a cleared notice keeps being retracted.
 *
 * A cleared row still has work to do: the machine may have been off when it was
 * cleared and is still showing it. Visiting devices with no open row for a week
 * afterwards covers a PC that spent the weekend switched off, without walking
 * the entire fleet on every run.
 */
const RETRACT_DAYS = 7;

export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Nothing to push to. Not an error: the module runs long before a relay host
  // exists, the same as every other read path here.
  if (!remoteConfigured()) {
    return NextResponse.json({ pushed: 0, reason: "no support host configured" });
  }

  const since = new Date(Date.now() - RETRACT_DAYS * 24 * 60 * 60 * 1000);
  const recent = or(isNull(deviceNotices.clearedAt), gt(deviceNotices.clearedAt, since));
  const recentHold = or(isNull(safetyHolds.clearedAt), gt(safetyHolds.clearedAt, since));

  const [noticeRows, holdRows] = await Promise.all([
    db.select({ deviceId: deviceNotices.deviceId }).from(deviceNotices).where(recent).catch(() => []),
    db.select({ deviceId: safetyHolds.deviceId }).from(safetyHolds).where(recentHold).catch(() => []),
  ]);

  // A cleared row still puts its device on the visit list - the machine may
  // have been off when it was cleared and be showing the notice yet.
  const deviceIds = [...new Set([...noticeRows, ...holdRows].map((r) => r.deviceId))];
  if (deviceIds.length === 0) return NextResponse.json({ pushed: 0, reason: "nothing posted anywhere" });

  let pushed = 0, cleared = 0, failed = 0;
  for (const deviceId of deviceIds) {
    const state = await noticesForDevice(deviceId);
    if (!state) continue;
    const res = await pushNoticesTo(state.nodeId, state.notices);
    if (res.error) failed++;
    else if (state.notices.length === 0) cleared++;
    else pushed++;
  }

  // Lockouts, which are a different job on the same pass. A notice is
  // re-asserted so it survives a reboot; a lockout is re-APPLIED because
  // repetition is the only thing that gives it force - one logoff is a
  // nuisance, a logoff every time the machine appears is a machine that
  // cannot be used. Held open until somebody releases it.
  const locked = await db.select({ deviceId: deviceLockouts.deviceId }).from(deviceLockouts)
    .where(isNull(deviceLockouts.releasedAt)).catch(() => []);
  let enforced = 0, enforceFailed = 0;
  for (const { deviceId } of locked) {
    const res = await enforceDeviceLockout(deviceId);
    if (res.error) enforceFailed++;
    else if (res.applied) enforced++;
  }

  // An offline machine counts as failed and is retried on the next run, which
  // is the whole design rather than a shortfall in it.
  return NextResponse.json({
    pushed, cleared, failed, devices: deviceIds.length,
    lockouts: locked.length, enforced, enforceFailed,
  });
}
