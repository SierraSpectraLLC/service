import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { deviceNotices, instruments, remoteDevices, safetyHolds } from "@/db/schema";
import { consentModeFor } from "@/lib/remoteAccess";
import { noticesFor, permitted, type Notice } from "@/lib/fleetNotice";
import { pushNoticesTo } from "@/lib/remote";

/**
 * The database half of lib/fleetNotice: read what a machine should be saying,
 * and make it say so.
 *
 * Server-only, and separate from the pure module for the usual reason - what a
 * notice says is worth arguing with in a test, and this part needs rows. Both
 * the server actions and api/cron/notices come through here so that a notice
 * posted by hand and a notice re-asserted at 3am are computed by one piece of
 * code rather than two that agree until they don't.
 */

/** Exactly what this machine should be showing, or [] for "say nothing". */
export async function noticesForDevice(deviceId: number): Promise<{ nodeId: string; notices: Notice[] } | null> {
  const [device] = await db.select().from(remoteDevices).where(eq(remoteDevices.id, deviceId)).catch(() => []);
  if (!device || !device.nodeId) return null;

  const [notice] = await db.select().from(deviceNotices)
    .where(and(eq(deviceNotices.deviceId, deviceId), isNull(deviceNotices.clearedAt))).catch(() => []);
  const [hold] = await db.select().from(safetyHolds)
    .where(and(eq(safetyHolds.deviceId, deviceId), isNull(safetyHolds.clearedAt))).catch(() => []);

  const [system] = device.instrumentId === null ? [] : await db
    .select({ ownerOrgId: instruments.ownerOrgId, stages: instruments.stages })
    .from(instruments).where(eq(instruments.id, device.instrumentId)).catch(() => []);

  // The custody rule that decides whether a support session may be silent also
  // decides whether a safety rung may lock. On this engine the lock is never
  // taken up either way - see lib/remote.pushNoticesTo for why - so this is
  // currently belt and braces, and stays because the rule is the rule.
  const { mode } = consentModeFor(device, system ?? null);

  return {
    nodeId: device.nodeId,
    notices: permitted(
      noticesFor(
        notice ? {
          noticeText: notice.body, approvedBy: notice.approvedBy,
          rung: notice.rung as "notice" | "prominent" | "at_login",
        } : null,
        hold ? {
          reason: hold.reason, decidedBy: hold.decidedBy,
          contact: hold.contact, effect: hold.effect as "advise" | "hold" | "lock",
        } : null,
      ),
      mode,
    ),
  };
}

/**
 * Push one machine to its current state. Best-effort by contract: the rows are
 * the record, this is one attempt at delivery, and api/cron/notices is what
 * makes a failed attempt not matter. Callers on a mutation path should ignore
 * the result rather than fail a write that has already happened.
 */
export async function syncDeviceNotices(deviceId: number): Promise<{ error?: string }> {
  const state = await noticesForDevice(deviceId);
  if (!state) return { error: "That machine is not enrolled." };
  return pushNoticesTo(state.nodeId, state.notices);
}
