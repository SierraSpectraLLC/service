// Who holds a machine, derived from the open epoch rather than read off a
// pointer.
//
// instruments.owner_org_id is fast and it is a CACHE: it moves by hand in
// places the handoff chain never hears about, and once custody is what decides
// who may read a history, a pointer somebody set in a form is the wrong
// authority. The epoch is the record; the pointer is what the board draws.
//
// Nothing switches over here. Phase 3 derives the answer, writes the
// disagreements to custody_diffs and stops - reassigning machines on a deploy,
// silently, because a script preferred one of two answers, is exactly the
// failure this is meant to prevent.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { custodyEpochs } from "@/db/schema";
import type { OrgId } from "@/lib/custody/types";

export type OpenEpoch = { id: number; n: number; custodianOrgId: OrgId | null; custodianName: string };

/** The open epoch, or null for a machine no handoff has ever been recorded for. */
export async function openEpochOf(instrumentId: number): Promise<OpenEpoch | null> {
  const [row] = await db.select({
    id: custodyEpochs.id, n: custodyEpochs.n,
    custodianOrgId: custodyEpochs.custodianOrgId, custodianName: custodyEpochs.custodianName,
  }).from(custodyEpochs)
    .where(and(eq(custodyEpochs.instrumentId, instrumentId), eq(custodyEpochs.closeKind, "open")))
    .limit(1);
  return row ?? null;
}

/**
 * Null means two different things and the caller has to be able to tell them
 * apart, so it does not: `held` says whether anybody holds it at all, and
 * `orgId` null with held true is house stewardship.
 */
export async function currentCustodianOrgId(
  instrumentId: number,
): Promise<{ held: boolean; orgId: OrgId | null; name: string }> {
  const open = await openEpochOf(instrumentId);
  return open
    ? { held: true, orgId: open.custodianOrgId, name: open.custodianName }
    : { held: false, orgId: null, name: "" };
}

/** Open epochs for a whole board, in one query. */
export async function openEpochsFor(instrumentIds: number[]): Promise<Map<number, OpenEpoch>> {
  if (!instrumentIds.length) return new Map();
  const rows = await db.select({
    instrumentId: custodyEpochs.instrumentId, id: custodyEpochs.id, n: custodyEpochs.n,
    custodianOrgId: custodyEpochs.custodianOrgId, custodianName: custodyEpochs.custodianName,
  }).from(custodyEpochs)
    .where(and(inArray(custodyEpochs.instrumentId, instrumentIds), eq(custodyEpochs.closeKind, "open")));
  return new Map(rows.map((r) => [r.instrumentId, r]));
}
