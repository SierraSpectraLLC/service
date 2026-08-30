// Reading a workspace's entitlement. The rules are lib/plan and stay pure;
// this is the one query behind them.

import { and, count, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { clientShares, orgs } from "@/db/schema";
import { cleanPlan, type Plan } from "@/lib/plan";

export type WorkspacePlan = {
  plan: Plan;
  /** Client organizations this workspace holds - what the free tier bounds. */
  clients: number;
  /**
   * Room granted to THIS workspace by hand, above the tier. Zero for almost
   * every workspace; lib/plan decides what it is worth. See orgs.freeClients.
   */
  granted: number;
};

/**
 * What this workspace is on, and how much of it is used.
 *
 * A missing workspace reads as FULL with nothing in it, which is the same
 * direction every other default here leans: an entitlement check that cannot
 * find the row must not be the thing that stops somebody working. Whether the
 * caller may act at all is decided before this is ever asked.
 */
export async function planFor(tenantOrgId: number | null): Promise<WorkspacePlan> {
  if (tenantOrgId === null) return { plan: "", clients: 0, granted: 0 };
  const [[row], [tally]] = await Promise.all([
    db.select({ plan: orgs.plan, granted: orgs.freeClients }).from(orgs).where(eq(orgs.id, tenantOrgId)),
    db.select({ n: count() }).from(orgs).where(and(
      eq(orgs.parentOrgId, tenantOrgId),
      eq(orgs.isOperator, false),
    )),
  ]);
  return {
    plan: cleanPlan(row?.plan),
    clients: Number(tally?.n ?? 0),
    granted: Number(row?.granted ?? 0),
  };
}

/** Invitations this workspace has out and unanswered - see plan.OPEN_INVITES. */
export async function openInvites(tenantOrgId: number | null): Promise<number> {
  if (tenantOrgId === null) return 0;
  const [tally] = await db.select({ n: count() }).from(clientShares).where(and(
    eq(clientShares.tenantOrgId, tenantOrgId),
    eq(clientShares.status, "pending"),
    isNull(clientShares.toOrgId),          // invitations, not in-network offers
  ));
  return Number(tally?.n ?? 0);
}
