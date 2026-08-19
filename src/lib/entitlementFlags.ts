// The flag at the moment of commitment.
//
// Usage is derived, never stored (lib/agreementUsage): every closed work order
// IS a visit, every fitted part IS spend, unlimited contracts and capped ones
// alike - which is what makes annual visits-per-client a query rather than a
// counter to maintain. What was missing is the WARNING at the moment somebody
// commits the shop: opening a job for a client who is out of included visits,
// or recording a part against an allowance that cannot absorb it.
//
// These are flags, not gates - the 2am rule again. The client's instrument is
// down and the job happens either way; what must not happen silently is the
// shop eating a billable visit because nobody knew the contract was spent.
// "" means nothing worth saying: no client, no live agreement, no cap, or
// room to spare. Silence is deliberate on the no-agreement case - pure
// time-and-materials clients are normal, not a warning.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agreements } from "@/db/schema";
import { standing } from "@/lib/agreements";
import { usageFor } from "@/lib/agreementUsage";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";

type Row = typeof agreements.$inferSelect;

/**
 * The live paper covering this system for this org: active (or inside its
 * renewal notice), and either org-wide or scoped to include the system.
 */
async function covering(orgId: number, instrumentId: number | null): Promise<Row[]> {
  const today = shopToday();
  const rows = await db.select().from(agreements).where(eq(agreements.orgId, orgId));
  return rows.filter((a) => {
    const st = standing(a, today);
    if (st !== "active" && st !== "expiring") return false;
    return a.instrumentIds.length === 0
      || (instrumentId !== null && a.instrumentIds.includes(instrumentId));
  });
}

const label = (a: Row) => a.title.trim() || a.number.trim() || "their agreement";

/**
 * Opening a job: is there an included visit left to spend?
 *
 * The MOST generous covering contract answers, so the flag fires only when no
 * paper has room. Two things it can say: the tank is empty (this job is
 * billable), or this is the last one (so the renewal conversation starts a
 * visit early, not a visit late). Unlimited anywhere = silence.
 */
export async function visitFlag(orgId: number | null, instrumentId: number | null): Promise<string> {
  if (orgId === null) return "";
  const covers = await covering(orgId, instrumentId);
  if (!covers.length || covers.some((a) => a.visitsUnlimited)) return "";
  const withVisits = covers.filter((a) => a.visitsIncluded > 0);
  if (!withVisits.length) return "";
  let best: { a: Row; used: number; remaining: number } | null = null;
  for (const a of withVisits) {
    const u = await usageFor(a, orgId);
    const remaining = a.visitsIncluded - u.visits;
    if (!best || remaining > best.remaining) best = { a, used: u.visits, remaining };
  }
  if (!best) return "";
  if (best.remaining <= 0) {
    return `Out of included visits: ${best.used} of ${best.a.visitsIncluded} already used on "${label(best.a)}" - this job is billable.`;
  }
  if (best.remaining === 1) {
    return `This uses the last included visit on "${label(best.a)}" (${best.a.visitsIncluded - 1} of ${best.a.visitsIncluded} used so far).`;
  }
  return "";
}

/**
 * Recording or ordering a part: can the allowance absorb it?
 *
 * `addCents` is the cost being committed right now; null when nobody typed
 * one, in which case only an already-empty allowance speaks up. PM-covered
 * parts are excluded from spend exactly as the drawdown itself excludes them
 * (usageFor), so this warns off the same number the entitlement bar shows.
 */
export async function partsFlag(
  orgId: number | null, instrumentId: number | null, addCents: number | null,
): Promise<string> {
  if (orgId === null) return "";
  const covers = await covering(orgId, instrumentId);
  if (!covers.length || covers.some((a) => a.partsUnlimited)) return "";
  const withParts = covers.filter((a) => a.partsAllowanceCents > 0);
  if (!withParts.length) return "";
  let best: { a: Row; spent: number; remaining: number } | null = null;
  for (const a of withParts) {
    const u = await usageFor(a, orgId);
    const remaining = a.partsAllowanceCents - u.partsCents;
    if (!best || remaining > best.remaining) best = { a, spent: u.partsCents, remaining };
  }
  if (!best) return "";
  if (best.remaining <= 0) {
    return `Parts allowance exhausted on "${label(best.a)}": ${formatCents(best.spent)} of ${formatCents(best.a.partsAllowanceCents)} spent - this part is billable.`;
  }
  if (addCents !== null && addCents > best.remaining) {
    return `This part (${formatCents(addCents)}) goes past the allowance on "${label(best.a)}" - ${formatCents(best.remaining)} left of ${formatCents(best.a.partsAllowanceCents)}.`;
  }
  return "";
}
