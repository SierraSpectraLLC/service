// What the guard on a shipped system asks for, and all it is ever told.
//
// This IS a pull endpoint, unlike the notice route (which pushes) - a guard
// must be able to renew itself the moment it gets online, with nobody at a
// portal. The asymmetry that keeps that safe is the machine secret: the reply
// carries a lease ONLY to a caller that proves it holds the per-machine secret,
// so this is not a lease-dispenser for anyone who learns a node id.
//
// The reply carries no invoice, no balance, no account status - a lease is
// identity and time and a signature, nothing else. lib/leaseGuard is why.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { remoteDevices } from "@/db/schema";
import { deriveMachineSecret, verifyGuardProof } from "@/lib/leaseGuardCrypto";
import { issueRenewal, leaseConfig } from "@/lib/leaseGuardData";

export async function GET(req: Request) {
  const cfg = leaseConfig();
  // No keys means no enforcement anywhere; say nothing rather than error, the
  // same posture every unconfigured read path in the app takes.
  if (!cfg) return Response.json({ decision: "disarmed" });

  const url = new URL(req.url);
  const nodeId = url.searchParams.get("nodeId")?.trim() ?? "";
  const ts = Number(url.searchParams.get("ts"));
  const proof = url.searchParams.get("proof")?.trim() ?? "";
  if (!nodeId || !proof || !Number.isFinite(ts)) {
    return Response.json({ error: "nodeId, ts and proof required" }, { status: 400 });
  }

  // Prove the caller holds this machine's secret before anything is looked up.
  const secret = deriveMachineSecret(cfg.masterSecretB64, nodeId);
  if (!verifyGuardProof(secret, nodeId, ts, proof)) {
    // An unproven caller is told nothing about the machine, not even whether it
    // exists - the same silence the notice route keeps.
    return Response.json({ decision: "disarmed" }, { status: 401 });
  }

  const [device] = await db.select({ id: remoteDevices.id }).from(remoteDevices)
    .where(eq(remoteDevices.nodeId, nodeId));
  if (!device) return Response.json({ decision: "disarmed" });

  const result = await issueRenewal(device.id, cfg);
  return Response.json(result ?? { decision: "disarmed" }, {
    headers: { "cache-control": "no-store" },
  });
}
