// Whose queue a system sits in, and how long it's been there. A third axis,
// independent of ownership (custody) and visibility (shares): who is expected
// to make the next move. Pure, so the dashboard, the system page and the
// reports all answer the question the same way.
import type { Role } from "@/lib/authz";
import { houseOfRecord } from "@/lib/tenants";

export type QueueState = {
  /** Null = the operator's own queue. */
  queueOrgId: number | null;
  queueReason: string;
  /** Null = never moved; callers pass the system's createdAt instead. */
  queueSince: Date | null;
};

export const DAY_MS = 86400000;

/** Whole days, floored - "in your queue 0 days" reads better than "0.4". */
export function daysSince(since: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY_MS));
}

/**
 * How a viewer should read the queue: their move, someone else's, or a third
 * party's. The distinction is the whole point of the feature - a system parked
 * with the client must not read as work sitting on the shop's bench.
 */
export function queueView(
  viewer: { role: Role; orgId: number | null; operatorOrgId?: number | null; rootOperatorOrgId?: number | null },
  state: Pick<QueueState, "queueOrgId"> & { tenantOrgId?: number | null },
): "mine" | "elsewhere" {
  // An empty queue means "with the service company whose system this is", which
  // is one company - not every company with staff.
  if (state.queueOrgId === null) return houseOfRecord(viewer, state.tenantOrgId) ? "mine" : "elsewhere";
  return viewer.orgId !== null && viewer.orgId === state.queueOrgId ? "mine" : "elsewhere";
}

/**
 * Who may move a system between queues: the house, whoever currently holds it
 * (so it can always be handed back), and the owning organization (pulling your
 * own system back is an owner's prerogative). Viewers never can - parking a
 * system is a decision about work, not a read.
 */
export function canKick(
  viewer: { role: Role; orgId: number | null; operatorOrgId?: number | null; rootOperatorOrgId?: number | null },
  system: { queueOrgId: number | null; ownerOrgId: number | null; archived: boolean; tenantOrgId?: number | null },
): boolean {
  if (system.archived) return false;
  if (houseOfRecord(viewer, system.tenantOrgId)) return true;
  if (viewer.role !== "client_editor" || viewer.orgId === null) return false;
  return viewer.orgId === system.queueOrgId || viewer.orgId === system.ownerOrgId;
}

/**
 * A wait nobody owes a move on.
 *
 * The shop's own screen had no word for this. queueView says who HOLDS it and
 * queueNeedsThem says whether anything is owed, but the record's top line only
 * ever asked the first - so a system we had finished, handed back, and had no
 * further move on was announced as "Waiting on Modesto Irrigation District" in
 * amber, and stayed there for nineteen days. The banner described the shop as
 * blocked by the one fact that means it isn't.
 *
 * Staff only, and deliberately. A client whose machine is at the shop wants
 * "with Sierra Spectra" at the top of their record: that is the answer to
 * where is my instrument, not a chore they are being nagged about. The
 * mirror-image case on their side is the dismissible handback line.
 *
 * `pendingOnHolder` is queueNeedsThem asked about the HOLDER rather than the
 * viewer - see the call site, which is the only place that can resolve it.
 */
export function settledWait(s: {
  isStaff: boolean;
  /** The viewer holds it - queueView() === "mine". */
  isMine: boolean;
  pendingOnHolder: boolean;
}): boolean {
  return s.isStaff && !s.isMine && !s.pendingOnHolder;
}

export type QueueLeg = { toOrgId: number | null; at: Date };

/**
 * Days this system spent in somebody else's queue, up to `until`. Each event
 * marks a move INTO a queue, so a leg runs from one event to the next (or to
 * `until`), and only legs held by a non-house queue count.
 *
 * This exists so turnaround can be honest. Three weeks waiting on a client's
 * nitrogen contractor is three weeks nobody at the shop could have shortened,
 * and reporting it as shop time would make the one number a buyer cares about
 * a lie in the operator's own disfavour.
 */
export function parkedDaysBefore(legs: QueueLeg[], until: Date): number {
  const sorted = [...legs].sort((a, b) => a.at.getTime() - b.at.getTime());
  let ms = 0;
  for (let i = 0; i < sorted.length; i++) {
    const leg = sorted[i];
    if (leg.toOrgId === null) continue;          // our queue - our time to own
    if (leg.at >= until) break;                  // hasn't happened yet in this window
    const ends = sorted[i + 1]?.at ?? until;
    ms += Math.min(ends.getTime(), until.getTime()) - leg.at.getTime();
  }
  return Math.max(0, Math.round(ms / DAY_MS));
}
