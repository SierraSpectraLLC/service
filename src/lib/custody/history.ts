// Service history read off the chain instead of reassembled from three tables.
//
// lib/serviceHistory exists because "0 VISITS THIS YEAR" once meant "no closed
// work orders" - a fact about which table the work happened to land in. It
// fixed that by reading all three at the call site. This reads one.
//
// The RULE stays where it is: a visit is a day somebody completed work on the
// system, and a day is unplanned if anything unplanned finished on it. Both
// paths call the same visitsOf, so the flag switches where completions come
// from and never what a visit means - which is the only way the two can be
// compared at all.

import { desc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { systemEvents } from "@/db/schema";
import { dayOf, visitsOf, type Completion, type Visit } from "@/lib/serviceHistory";

/**
 * The source kinds that represent WORK FINISHING. A qualification verdict, a
 * handoff and a stage change are all real events and none of them is an
 * engineer standing in the room, so none of them is a visit - the same line
 * lib/serviceHistory draws when it refuses to count an audit row.
 */
const WORK_SOURCES = ["work_order", "task"];

export async function completionsFromEvents(instrumentIds: number[]): Promise<Completion[]> {
  if (!instrumentIds.length) return [];
  const rows = await db.select({
    instrumentId: systemEvents.instrumentId,
    occurredAt: systemEvents.occurredAt,
    sourceKind: systemEvents.sourceKind,
    provenance: systemEvents.provenance,
  }).from(systemEvents).where(inArray(systemEvents.instrumentId, instrumentIds));

  return rows.flatMap((r) => {
    if (!WORK_SOURCES.includes(r.sourceKind)) return [];
    const day = dayOf(r.occurredAt);
    if (!day) return [];
    // `planned` is stamped on the event at write time and travels: scheduled
    // upkeep versus something that broke is the single most useful thing a
    // buyer can know about a line, and re-deriving it later would mean reading
    // the work order the event exists to replace.
    const planned = (r.provenance as { planned?: boolean } | null)?.planned === true;
    return [{ instrumentId: r.instrumentId, day, planned }];
  });
}

/** The same shape lib/serviceHistory.visitsOf returns, from the chain. */
export async function visitsOfFromEvents(instrumentIds: number[]): Promise<Visit[]> {
  return visitsOf(await completionsFromEvents(instrumentIds));
}

/** One machine's chain, newest first - what the record page will render. */
export const chainOf = (instrumentId: number) =>
  db.select().from(systemEvents)
    .where(inArray(systemEvents.instrumentId, [instrumentId]))
    .orderBy(desc(systemEvents.occurredAt), desc(systemEvents.id));
