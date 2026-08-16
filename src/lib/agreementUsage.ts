// What has actually been drawn down against an agreement.
//
// The database half of lib/agreements, which holds the rules and the arithmetic
// but deliberately stores no balance. This is the query that answers "how much
// of their $5,000 have they spent" from the work itself, every time it is asked.
//
// Three sums, and each one is picked for a reason worth stating:
//
//   Parts follow parts.owner_org_id, not the system's current owner. That column
//   is stamped when the part is bought, so a system changing hands mid-term
//   cannot retroactively move spend onto or off somebody's allowance - which is
//   the same rule lib/redact uses to decide who may see a price at all.
//
//   Visits are CLOSED work orders, excluding questions. A job that is still open
//   has not been delivered, and a question answered on the phone is not a visit;
//   counting either would burn a client's entitlement on something they did not
//   get. See countsAsVisit.
//
//   Labour is time logged against their systems inside the term. Not against
//   their work orders, because plenty of real work predates anybody opening one.

import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { instruments, parts, timeEntries, workOrders } from "@/db/schema";
import { type AgreementLike, type Usage } from "@/lib/agreements";

/** An empty result, for an org with nothing on file yet. */
const NOTHING: Usage = { partsCents: 0, visits: 0, laborMinutes: 0, pmPartsCents: 0 };

/**
 * Bound a YYYY-MM-DD column by the agreement's term.
 *
 * A blank start means "since forever" and a blank end "until further notice",
 * matching lib/agreements.inTerm - so an agreement with no dates counts
 * everything rather than nothing. Counting nothing would report zero spend
 * against a live allowance, which reads as good news and is the more dangerous
 * direction to be wrong in.
 */
const within = (col: Parameters<typeof gte>[0], a: Pick<AgreementLike, "startsOn" | "endsOn">) => {
  const bounds = [
    a.startsOn ? gte(col, a.startsOn) : undefined,
    a.endsOn ? lte(col, a.endsOn) : undefined,
  ].filter(Boolean);
  return bounds.length ? and(...bounds) : undefined;
};

export async function usageFor(
  a: Pick<AgreementLike, "startsOn" | "endsOn"> & { instrumentIds?: number[]; pmPartsIncluded?: boolean },
  orgId: number,
): Promise<Usage> {
  // Their systems: what labour and visits are counted against. Read once.
  // A contract assigned to specific systems counts only those - that is what
  // lets one client run a full-service contract on the TOC and a PM-only one
  // on the UV-Vis, each drawing down its own paper.
  const scoped = a.instrumentIds ?? [];
  const theirs = await db.select({ id: instruments.id }).from(instruments)
    .where(eq(instruments.ownerOrgId, orgId));
  const ids = theirs.map((r) => r.id).filter((id) => scoped.length === 0 || scoped.includes(id));

  const [partRows, woRows, timeRows] = await Promise.all([
    // Whose money bought it, stamped at purchase - never re-derived from who
    // owns the system today.
    db.select({ cents: parts.costCents, pmScheduleId: parts.pmScheduleId }).from(parts).where(and(
      eq(parts.ownerOrgId, orgId),
      isNotNull(parts.costCents),
      // Fitted, not merely ordered. A part sitting in a box has not been spent
      // on their behalf yet, and billing it would be billing for a shelf.
      eq(parts.status, "Installed"),
      sql`${parts.installedAt} <> ''`,
      within(parts.installedAt, a),
      scoped.length ? inArray(parts.instrumentId, scoped) : undefined,
    )),
    db.select({ severity: workOrders.severity, state: workOrders.state, closedAt: workOrders.closedAt })
      .from(workOrders).where(and(
        eq(workOrders.orgId, orgId),
        eq(workOrders.state, "closed"),
        // Dated by when it was OPENED rather than closed: a job asked for in
        // December and finished in January belongs to the year they asked.
        within(workOrders.openedOn, a),
        scoped.length ? inArray(workOrders.instrumentId, scoped) : undefined,
      )),
    ids.length
      ? db.select({ minutes: timeEntries.minutes }).from(timeEntries).where(and(
          inArray(timeEntries.instrumentId, ids),
          within(timeEntries.date, a),
        ))
      : Promise.resolve([]),
  ]);

  // A PM's own parts are part of the PM. When the contract says so, they are
  // reported but never drawn from the allowance - billing the client for a
  // kit their included PM already covers is charging twice for one thing.
  // Split rather than filtered away: a number that silently vanishes is how
  // two screens end up disagreeing in front of the customer.
  const pmPartsCents = partRows
    .filter((r) => r.pmScheduleId !== null)
    .reduce((n, r) => n + (r.cents ?? 0), 0);
  const allPartsCents = partRows.reduce((n, r) => n + (r.cents ?? 0), 0);

  return {
    partsCents: a.pmPartsIncluded ? allPartsCents - pmPartsCents : allPartsCents,
    pmPartsCents,
    // The severity filter is applied here rather than in SQL so the one rule
    // about what counts lives in lib/agreements and is tested there.
    visits: woRows.filter((w) => w.severity.trim().toLowerCase() !== "question").length,
    laborMinutes: timeRows.reduce((n, r) => n + r.minutes, 0),
  };
}

/** Usage for several agreements at once, keyed by id. One org, one pass each. */
export async function usageForAll<
  T extends { id: number; orgId: number; instrumentIds?: number[]; pmPartsIncluded?: boolean }
    & Pick<AgreementLike, "startsOn" | "endsOn">,
>(
  list: T[],
): Promise<Map<number, Usage>> {
  const out = new Map<number, Usage>();
  for (const a of list) {
    out.set(a.id, await usageFor(a, a.orgId).catch(() => NOTHING));
  }
  return out;
}
