import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { deviceLockouts, remoteDevices } from "@/db/schema";
import { lockoutPlan, type LockoutPlan } from "@/lib/deviceLockout";
import { pushLockoutTo } from "@/lib/remote";

/**
 * The database half of lib/deviceLockout: read the open lockout on a machine
 * and make the machine act on it.
 *
 * Kept apart from lib/fleetNoticeData deliberately. The two look alike and are
 * not: a notice is something a machine SAYS and is re-asserted quietly, while a
 * lockout is something done TO a machine and must be re-applied on every pass
 * to have any force at all. Merging them would put an hourly logoff one
 * refactor away from every device carrying a notice.
 */

/** The open lockout on this machine, resolved to a plan, or null. */
export async function lockoutForDevice(
  deviceId: number,
): Promise<{ nodeId: string; plan: LockoutPlan } | null> {
  const [device] = await db.select().from(remoteDevices)
    .where(eq(remoteDevices.id, deviceId)).catch(() => []);
  if (!device || !device.nodeId) return null;

  const [row] = await db.select().from(deviceLockouts)
    .where(and(eq(deviceLockouts.deviceId, deviceId), isNull(deviceLockouts.releasedAt)))
    .catch(() => []);
  if (!row) return null;

  // No permitted() here, and that is the point: custody does not weaken a
  // lockout. lib/deviceLockout.lockoutSurvivesCustody carries the argument -
  // a shipped system is precisely the case this exists for.
  const plan = lockoutPlan({
    reference: row.reference, decidedBy: row.decidedBy, contact: row.contact,
    force: row.force as "notify" | "logoff" | "shutdown",
  });
  return plan ? { nodeId: device.nodeId, plan } : null;
}

/**
 * Apply the lockout, and write down what happened.
 *
 * Recorded rather than returned, for the same reason notice delivery is: a
 * lockout nobody could deliver and one that landed must not look alike on the
 * page. This one matters more - somebody may be deciding whether to call the
 * police based on whether the machine has been reached.
 */
export async function enforceDeviceLockout(deviceId: number): Promise<{ error?: string; applied: boolean }> {
  const open = await lockoutForDevice(deviceId);
  if (!open) return { applied: false };

  const res = await pushLockoutTo(open.nodeId, open.plan);
  await db.update(deviceLockouts).set({
    ...(res.error ? {} : { lastEnforcedAt: new Date() }),
    enforceError: res.error ?? "",
  }).where(and(eq(deviceLockouts.deviceId, deviceId), isNull(deviceLockouts.releasedAt))).catch(() => {});

  return { error: res.error, applied: !res.error };
}
