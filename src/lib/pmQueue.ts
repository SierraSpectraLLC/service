// Who a system should be waiting on once its maintenance falls due.
//
// A client's instrument sitting on their bench under contract is in their queue
// while it is working: nothing is owed. The day a schedule comes due, the next
// move is ours, and the queue should say so without anybody remembering to move
// it - a system that needs a visit and shows as the client's problem is how a
// contract quietly lapses.
//
// Pure, because this runs from a cron with nobody watching. The rules are worth
// reading in one place rather than inferring from a loop.
export type QueueShare = { orgId: number; kind: string };

export type HandoffContext = {
  /** Who holds the next move now. `null` is the house's own queue. */
  queueOrgId: number | null;
  /** The organization this instance's own engineers sign in as, if it has one. */
  operatorOrgId: number | null;
  /** Organizations the system is shared with, and what kind each is. */
  shares: QueueShare[];
  archived: boolean;
};

export type Handoff =
  | { move: true; toOrgId: number | null; why: string }
  | { move: false; why: string };

/**
 * `toOrgId` follows the same convention as the rest of the queue: an org id, or
 * `null` for the house. `move: false` carries the reason it stayed put, which is
 * what makes the audit trail readable when nothing happened.
 */
export function pmHandoff(ctx: HandoffContext): Handoff {
  if (ctx.archived) return { move: false, why: "the system is archived" };

  const providers = ctx.shares.filter((s) => s.kind === "provider");

  // Already with somebody who can act on it. The house's own queue counts:
  // `null` means us, and we are the provider of last resort.
  if (ctx.queueOrgId === null) return { move: false, why: "already in our queue" };
  if (providers.some((p) => p.orgId === ctx.queueOrgId)) {
    return { move: false, why: "already with a provider" };
  }

  // The operator's own organization wins when it is one of the shares: those are
  // the accounts our engineers actually sign in as, so a system parked there
  // appears on their dashboard rather than on the platform owner's.
  if (ctx.operatorOrgId !== null && providers.some((p) => p.orgId === ctx.operatorOrgId)) {
    return { move: true, toOrgId: ctx.operatorOrgId, why: "maintenance is due" };
  }

  if (providers.length === 1) return { move: true, toOrgId: providers[0].orgId, why: "maintenance is due" };

  // Two providers and no way to tell which one services this system: guessing
  // would put a client's instrument in a competitor's queue. The maintenance task
  // still exists and still shows as overdue; only the queue stays where it was.
  if (providers.length > 1) return { move: false, why: "more than one provider has access" };

  return { move: false, why: "no provider has access" };
}
