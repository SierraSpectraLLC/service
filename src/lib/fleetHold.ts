// The systems the shop is NOT looking after this week, and how every fleet
// query says so.
//
// This began as one rule about prospects. Quoting a company means creating it
// and its systems - there is no other way to put a system on a quote - and
// those systems then joined the working fleet like any client's. So one quote
// to a stranger put their machines on the board, into the metrics, onto the
// maintenance calendar and into the PM queue, and the shop had no way to say
// "not ours yet" short of not recording them at all.
//
// It is now one rule about two stages. A former client's machines are in
// exactly the same position for the opposite reason - not yet ours, versus no
// longer ours - and both resolve to the same sentence: the fleet is what the
// shop is working on, and neither of these is. See lib/orgStage, which owns
// the vocabulary and the heldOutOfFleet predicate this reads.
//
// WHAT IS HELD OUT IS THE WORKING FLEET, and nothing else. Their record stays
// complete: the systems are on their own client page, in the quote's coverage
// picker, in search, carrying their whole service history. For a former client
// that history is the asset - it is what gets handed to whoever owns the
// machine next - so holding the systems off the board must never be confused
// with forgetting them.
//
// One rule, one place. The alternative was a condition written out at each of
// the fleet queries, which is a rule the next page has to remember; this is
// the id set they all exclude, and tests/fleetPages checks that every one of
// them asks for it.

import { and, eq, inArray, isNull, notInArray, or, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { assets, instruments, orgs } from "@/db/schema";
import { HELD_STAGES } from "@/lib/orgStage";
import { forTenant } from "@/lib/tenancy";

/** What the fleet is holding back: their systems, and the modules on them. */
export type FleetHold = {
  systems: number[];
  /**
   * Assets sitting on those systems.
   *
   * Not a nicety - a PM schedule hangs off a system OR off a module, and the
   * module-level ones are how a stacked annual is written: the pump's jobs on
   * the pump, the mass spec's on the mass spec. Those rows name no system at
   * all, so a rule that only knew about instrument ids let every one of a
   * prospect's module PMs carry on falling due. Found by marking a prospect in
   * the running app and watching their maintenance list not move.
   */
  assets: number[];
};

/**
 * The systems owned by anybody we are not currently working for, and the
 * modules on them.
 *
 * Resolved as ids rather than as a join condition because the exclusion has to
 * work against four different columns - instruments.id, pm_schedules
 * .instrument_id, pm_schedules.asset_id, tasks.instrument_id - and an id list
 * reads the same at all of them. Empty is the ordinary case and costs nothing.
 *
 * The stage test names the held stages rather than testing `<> 'client'`, so
 * this query and stageOf() cannot disagree about a value neither of them
 * expected. They did, briefly: an empty string is a client to stageOf and was
 * not a client to `<>`, which would have taken a machine off the board on the
 * strength of a blank column. See HELD_STAGES.
 */
export async function fleetHold(tenantOrgId: number | null): Promise<FleetHold> {
  const systemRows = await db.select({ id: instruments.id }).from(instruments)
    .innerJoin(orgs, eq(orgs.id, instruments.ownerOrgId))
    .where(and(inArray(orgs.stage, HELD_STAGES), forTenant(instruments.tenantOrgId, tenantOrgId)));
  const systems = systemRows.map((r) => r.id);
  if (!systems.length) return { systems, assets: [] };
  const assetRows = await db.select({ id: assets.id }).from(assets)
    .where(inArray(assets.instrumentId, systems));
  return { systems, assets: assetRows.map((r) => r.id) };
}

/**
 * "...and not one of theirs" - the condition to AND into a fleet query.
 *
 * Undefined when there is nothing held back, which drizzle drops from the
 * `and` rather than turning into a no-op comparison.
 *
 * A NULL column passes. That is not laxness: on pm_schedules a null instrument
 * means the row hangs off a module instead, and NOT IN against a null yields
 * null in SQL - so the plain notInArray would silently drop every module-level
 * PM in the shop the first time anybody marked a prospect. Passing the null
 * and testing the OTHER column is what makes both halves of the hold work.
 */
export function notHeld(col: AnyColumn, ids: number[]): SQL | undefined {
  return ids.length ? or(isNull(col), notInArray(col, ids)) : undefined;
}
