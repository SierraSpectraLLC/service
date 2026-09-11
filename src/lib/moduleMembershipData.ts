// The database half of lib/moduleMembership: fetch a set of units' move logs
// once and answer, for any of them, where it stood on any day.
import { and, eq, inArray, like } from "drizzle-orm";
import { db } from "@/db";
import { assetEvents, assets, instruments } from "@/db/schema";
import { shopDay } from "@/lib/shopday";
import {
  leftSystemOn, positionAtEndOf, wasInSystemOn, type FromIdOf, type MoveEvent,
} from "@/lib/moduleMembership";

export type MembershipResolver = {
  /** Where the unit stands now. */
  current(assetId: number): number | null;
  /** Where the unit stood at the end of `day`. */
  positionOn(assetId: number, day: string): number | null;
  /** Was the unit in `systemId` at any point during `day`? */
  wasInOn(assetId: number, systemId: number, day: string): boolean;
  /** The last day the unit left `systemId`, or null if it never has or is there now. */
  leftOn(assetId: number, systemId: number): string | null;
};

/**
 * One read of the move log for these units, and the systems the moved-from
 * texts name, so every question after is answered in memory.
 */
export async function membershipResolver(assetIds: number[]): Promise<MembershipResolver> {
  const ids = [...new Set(assetIds)];
  const [rows, eventRows] = ids.length
    ? await Promise.all([
      db.select({ id: assets.id, instrumentId: assets.instrumentId }).from(assets).where(inArray(assets.id, ids)),
      db.select().from(assetEvents).where(inArray(assetEvents.assetId, ids)),
    ])
    : [[], []];
  const events = new Map<number, MoveEvent[]>();
  for (const e of eventRows) {
    events.set(e.assetId, [...(events.get(e.assetId) ?? []), {
      assetId: e.assetId, kind: e.kind, instrumentId: e.instrumentId, detail: e.detail,
      day: shopDay(e.at), at: e.at.getTime(),
    }]);
  }
  // The systems named on the left of a moved event's "X -> Y", by name.
  const names = [...new Set(eventRows
    .filter((e) => e.kind === "moved" && e.detail.includes(" -> "))
    .map((e) => e.detail.slice(0, e.detail.indexOf(" -> ")).trim())
    .filter((n) => n && n !== "spare"))];
  const named = names.length
    ? await db.select({ id: instruments.id, externalId: instruments.externalId })
        .from(instruments).where(inArray(instruments.externalId, names))
    : [];
  const byName = new Map(named.map((i) => [i.externalId, i.id]));
  const fromIdOf: FromIdOf = (externalId) => byName.get(externalId) ?? null;
  const current = new Map(rows.map((r) => [r.id, r.instrumentId]));
  const of = (id: number) => events.get(id) ?? [];
  return {
    current: (id) => current.get(id) ?? null,
    positionOn: (id, day) => positionAtEndOf(day, current.get(id) ?? null, of(id), fromIdOf),
    wasInOn: (id, systemId, day) => wasInSystemOn(day, systemId, current.get(id) ?? null, of(id), fromIdOf),
    leftOn: (id, systemId) => leftSystemOn(systemId, current.get(id) ?? null, of(id), fromIdOf),
  };
}

/**
 * Every unit that is in this system now or ever was, by the log: the ones
 * installed into, removed from, moved into or status-stamped on it, and the
 * ones whose moved-from text names it. The system page reads these units'
 * daily updates and lets the resolver say which days each belongs to.
 */
export async function everModulesOf(systemId: number, externalId: string) {
  const [current, touched, fromText] = await Promise.all([
    db.select({ id: assets.id }).from(assets).where(eq(assets.instrumentId, systemId)),
    db.select({ assetId: assetEvents.assetId }).from(assetEvents).where(eq(assetEvents.instrumentId, systemId)),
    db.select({ assetId: assetEvents.assetId }).from(assetEvents)
      .where(and(eq(assetEvents.kind, "moved"), like(assetEvents.detail, `${externalId} -> %`))),
  ]);
  const ids = [...new Set([
    ...current.map((a) => a.id), ...touched.map((e) => e.assetId), ...fromText.map((e) => e.assetId),
  ])];
  return ids.length ? db.select().from(assets).where(inArray(assets.id, ids)) : [];
}
