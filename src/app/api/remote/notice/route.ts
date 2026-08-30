// What the agent on a lab PC asks for, and all it is ever told.
//
// The portal stays out of the media path here exactly as it does for sessions
// (see lib/remote): there is no push, no command channel, no socket held open.
// The machine checks in and is handed a short list of things to say on its own
// screen. That asymmetry is the security model - a portal that cannot command a
// lab PC cannot be made to command one.
//
// The reply carries no invoice, no balance, no account status and no customer
// data. It is the smallest thing that renders a notice, because it lands on a
// machine we do not control and should assume we cannot keep a secret on.
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { deviceNotices, instruments, remoteDevices, safetyHolds } from "@/db/schema";
import { consentModeFor } from "@/lib/remoteAccess";
import { noticesFor, permitted } from "@/lib/fleetNotice";

/** Bounds how long a machine that has gone quiet keeps repeating itself. */
const GRACE_SECONDS = 60 * 60 * 24 * 3;

export async function GET(req: Request) {
  const nodeId = new URL(req.url).searchParams.get("nodeId")?.trim() ?? "";
  if (!nodeId) return Response.json({ error: "nodeId required" }, { status: 400 });

  const [device] = await db.select().from(remoteDevices).where(eq(remoteDevices.nodeId, nodeId));
  // An unknown machine is told nothing at all, and is not told that it is
  // unknown either - the same posture every read path in the app takes.
  if (!device) return Response.json({ notices: [], graceSeconds: GRACE_SECONDS });

  // Checking in is how we learn it is alive; the engine remains the authority.
  await noteCheckIn(device.id);

  const [notice] = await db.select().from(deviceNotices)
    .where(and(eq(deviceNotices.deviceId, device.id), isNull(deviceNotices.clearedAt)));
  const [hold] = await db.select().from(safetyHolds)
    .where(and(eq(safetyHolds.deviceId, device.id), isNull(safetyHolds.clearedAt)));

  const [system] = device.instrumentId === null ? [] : await db
    .select({ ownerOrgId: instruments.ownerOrgId, stages: instruments.stages })
    .from(instruments).where(eq(instruments.id, device.instrumentId));

  // The same custody rule that decides whether a support session may be silent
  // decides whether a safety rung may lock: once a system has shipped or changed
  // hands, the lock degrades to advice.
  const { mode } = consentModeFor(device, system ?? null);

  const notices = permitted(
    noticesFor(
      notice ? { noticeText: notice.body, approvedBy: notice.approvedBy, rung: notice.rung as "notice" } : null,
      hold ? {
        reason: hold.reason, decidedBy: hold.decidedBy,
        contact: hold.contact, effect: hold.effect as "advise" | "hold" | "lock",
      } : null,
    ),
    mode,
  );

  return Response.json({ notices, graceSeconds: GRACE_SECONDS }, {
    headers: { "cache-control": "no-store" },
  });
}

/**
 * The check-in timestamp, and nothing else. There is no session on this
 * endpoint and no tenant in hand - the nodeId is the authorization, the same
 * doctrine as the hand-off token, and the write touches only the row that
 * nodeId fetched. Reviewed as such in tests/tenantWriteScoping.
 */
async function noteCheckIn(deviceId: number): Promise<void> {
  await db.update(remoteDevices).set({ lastSeenAt: new Date() }).where(eq(remoteDevices.id, deviceId));
}
