import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { deviceLeases, remoteDevices } from "@/db/schema";
import { clampLeaseDays, renewalDecision, type RenewalDecision } from "@/lib/leaseGuard";
import {
  deriveMachineSecret, offlineUnlockCode, signLease, signRelease,
} from "@/lib/leaseGuardCrypto";

/**
 * The database and key-holding half of lib/leaseGuard. Server-only: the private
 * signing key and the master secret live here and nowhere a browser can reach.
 *
 * Kept apart from the pure module for the usual reason - what a lease SAYS is
 * arguable in a test without a database or a key, and the decision to renew or
 * not is pinned there. This file is only the wiring: read the row, ask
 * lib/leaseGuard what to do, and if the answer is grant, put our name on a
 * fresh signature.
 */

export type LeaseConfig = { privateKeyB64: string; masterSecretB64: string; publicKeyB64: string };

/**
 * The keys, or null when lease enforcement is not set up. Separate from the
 * remote-support config on purpose: an instance can run remote support without
 * ever arming a lease, and the page should say "not configured" rather than
 * break. Generate the pair with lib/leaseGuardCrypto.generateLeaseKeypair and a
 * master with generateMasterSecret; store the private key and master as secrets.
 */
export function leaseConfig(): LeaseConfig | null {
  const privateKeyB64 = process.env.LEASE_SIGNING_KEY ?? "";
  const masterSecretB64 = process.env.LEASE_MASTER_SECRET ?? "";
  const publicKeyB64 = process.env.LEASE_PUBLIC_KEY ?? "";
  if (!privateKeyB64 || !masterSecretB64) return null;
  return { privateKeyB64, masterSecretB64, publicKeyB64 };
}

export const LEASE_NOT_CONFIGURED =
  "Lease enforcement has no signing key yet - set LEASE_SIGNING_KEY and LEASE_MASTER_SECRET.";

/** What a guard's check-in is answered with. A grant carries a fresh signed lease. */
export type RenewalResult =
  | { decision: "grant"; lease: string; expiresAt: number; graceDays: number; force: "notify" | "lock" }
  | { decision: Exclude<RenewalDecision, "grant">; release?: string };

/**
 * Answer one machine's check-in.
 *
 * The decision is lib/leaseGuard's, taking only standing - armed, suspended,
 * released - and never a balance. Only a grant touches the database, advancing
 * the counter and the expiry and recording that the guard was heard from, which
 * is the signal api/cron/lease-watch reads to notice when renewals stop.
 *
 * Authentication of the caller is the endpoint's job, not this function's: by
 * the time we are here, the guard has already proved it holds the machine
 * secret. See app/api/remote/lease.
 */
export async function issueRenewal(deviceId: number, cfg: LeaseConfig): Promise<RenewalResult | null> {
  const [device] = await db.select().from(remoteDevices).where(eq(remoteDevices.id, deviceId)).catch(() => []);
  if (!device || !device.nodeId) return null;

  const [row] = await db.select().from(deviceLeases)
    .where(eq(deviceLeases.deviceId, deviceId)).catch(() => []);
  if (!row) return { decision: "disarmed" };

  const decision = renewalDecision({
    armed: row.armed, releasedAt: row.releasedAt, suspendedAt: row.suspendedAt,
  });

  if (decision === "released") {
    // Hand the guard the signed proof so it can stand down offline too.
    return { decision, release: signRelease(cfg.privateKeyB64, device.nodeId) };
  }
  if (decision !== "grant") return { decision };

  const leaseDays = clampLeaseDays(row.leaseDays);
  const counter = row.counter + 1;
  const expiresAt = Date.now() + leaseDays * 24 * 60 * 60 * 1000;
  const lease = signLease(cfg.privateKeyB64, { machineId: device.nodeId, expiresAt, counter });

  await db.update(deviceLeases).set({
    counter, expiresAt: new Date(expiresAt), lastRenewedAt: new Date(),
  }).where(eq(deviceLeases.deviceId, deviceId)).catch(() => {});

  return {
    decision: "grant", lease, expiresAt,
    graceDays: row.graceDays, force: row.force as "notify" | "lock",
  };
}

/**
 * The 12-digit code that extends a lease with no network in the loop.
 *
 * Stateless here: the engineer reads the guard's current counter aloud, this
 * computes the code for the next one, and the guard advances its own counter
 * when it accepts - so nothing in our database moves, and a code works exactly
 * once on exactly the machine whose secret derives it. Reading this out is
 * sensitive, so its only caller is an owner-gated, audited action.
 */
export function offlineCodeFor(nodeId: string, guardCounter: number, cfg: LeaseConfig): string {
  const secret = deriveMachineSecret(cfg.masterSecretB64, nodeId);
  return offlineUnlockCode(secret, guardCounter + 1);
}

/** The open (unreleased) lease on a device, or null. */
export async function openLease(deviceId: number) {
  const [row] = await db.select().from(deviceLeases)
    .where(and(eq(deviceLeases.deviceId, deviceId), isNull(deviceLeases.releasedAt))).catch(() => []);
  return row ?? null;
}
