// The database half of lib/moduleMembership: fetch a set of units' move logs
// once and answer, for any of them, where it stood on any day.
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { assetEvents, assets } from "@/db/schema";
import { shopDay } from "@/lib/shopday";
import { forTenant } from "@/lib/tenancy";
import { homeOn, leftAfter, positionAtEndOf, timelineOf, type Step } from "@/lib/moduleMembership";

export type MembershipResolver = {
  /** Where the unit stands now. */
  current(assetId: number): number | null;
  /** Where the unit stood at the end of `day`. */
  positionOn(assetId: number, day: string): number | null;
  /** The system a unit's line for `day` belongs to - see lib/moduleMembership.homeOn. */
  homeOn(assetId: number, day: string): number | null;
  /** The day the unit left `systemId` on or after `day`, or null. */
  leftAfter(assetId: number, systemId: number, day: string): string | null;
};

/**
 * One read of the move log for these units, so every question after is
 * answered in memory. Nothing here looks a system up by name: the system a
 * move left comes from the unit's own earlier events (lib/moduleMembership).
 */
export async function membershipResolver(assetIds: number[]): Promise<MembershipResolver> {
  const ids = [...new Set(assetIds)];
  const [rows, eventRows] = ids.length
    ? await Promise.all([
      db.select({ id: assets.id, instrumentId: assets.instrumentId }).from(assets).where(inArray(assets.id, ids)),
      db.select().from(assetEvents).where(inArray(assetEvents.assetId, ids)),
    ])
    : [[], []];
  const byAsset = new Map<number, typeof eventRows>();
  for (const e of eventRows) byAsset.set(e.assetId, [...(byAsset.get(e.assetId) ?? []), e]);
  const steps = new Map<number, Step[]>();
  for (const [id, evs] of byAsset) {
    steps.set(id, timelineOf(evs.map((e) => ({
      assetId: e.assetId, kind: e.kind, instrumentId: e.instrumentId, detail: e.detail,
      day: shopDay(e.at), at: e.at.getTime(),
    }))));
  }
  const current = new Map(rows.map((r) => [r.id, r.instrumentId]));
  const now = (id: number) => current.get(id) ?? null;
  const of = (id: number) => steps.get(id) ?? [];
  return {
    current: now,
    positionOn: (id, day) => positionAtEndOf(day, now(id), of(id)),
    homeOn: (id, day) => homeOn(day, now(id), of(id)),
    leftAfter: (id, systemId, day) => leftAfter(day, systemId, of(id)),
  };
}

/**
 * Every unit of this workspace that is in the system now or ever was, by the
 * log: the ones installed into, moved into, removed from or status-stamped
 * on it. A unit that only ever left it by a move is found too, because the
 * event that put it there carries the system. Scoped to the system's own
 * workspace - the log has no tenant column of its own.
 */
export async function everModulesOf(systemId: number, tenantOrgId: number | null) {
  const [current, touched] = await Promise.all([
    db.select({ id: assets.id }).from(assets).where(eq(assets.instrumentId, systemId)),
    db.select({ assetId: assetEvents.assetId }).from(assetEvents).where(eq(assetEvents.instrumentId, systemId)),
  ]);
  const ids = [...new Set([...current.map((a) => a.id), ...touched.map((e) => e.assetId)])];
  return ids.length
    ? db.select().from(assets).where(and(inArray(assets.id, ids), forTenant(assets.tenantOrgId, tenantOrgId)))
    : [];
}
