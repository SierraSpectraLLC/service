// The only loader. Every custody read goes through here.
//
// The reason it is the only one is written down in lib/custody/view's header:
// this codebase already has five answers to "who sees what" - a tenant stamp, a
// share row, a cost filter, a dossier scope, a serial-lookup disclosure rule -
// each correct on the surface it was written for and none checkable against the
// others. A machine outlives every one of them. So there is one function that
// decides, one function that loads what it decides on, and no third place.

import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { custodyEpochs, grants, systemEvents } from "@/db/schema";
import { viewOf, type EpochView } from "@/lib/custody/view";
import type {
  CloseKind, Epoch, Grant, GrantEndReason, GrantKind, HowGrade, OrgId,
  ProcedureKeyEntry, SystemChain, SystemEvent, WhoGrade,
} from "@/lib/custody/types";

/** DB rows widened into the plain shapes lib/custody/view was written against. */
function toChain(
  instrumentId: number,
  epochRows: typeof custodyEpochs.$inferSelect[],
  eventRows: typeof systemEvents.$inferSelect[],
  grantRows: typeof grants.$inferSelect[],
): SystemChain {
  const epochs: Epoch[] = epochRows.map((e) => ({
    id: e.id, instrumentId: e.instrumentId, n: e.n,
    custodianOrgId: e.custodianOrgId, custodianName: e.custodianName,
    openedByEventId: e.openedByEventId, closedByEventId: e.closedByEventId,
    closeKind: e.closeKind as CloseKind,
    sealedAt: e.sealedAt, sealHash: e.sealHash, brokerOrgId: e.brokerOrgId,
  }));
  const events: SystemEvent[] = eventRows.map((r) => ({
    id: r.id, instrumentId: r.instrumentId, assetId: r.assetId, epochId: r.epochId,
    kind: r.kind as SystemEvent["kind"], occurredAt: r.occurredAt, recordedAt: r.recordedAt,
    authorOrgId: r.authorOrgId, commissionerOrgId: r.commissionerOrgId, custodianOrgId: r.custodianOrgId,
    whoGrade: r.whoGrade as WhoGrade, howGrade: r.howGrade as HowGrade,
    procedureKeys: (r.procedureKeys ?? []) as ProcedureKeyEntry[],
    provenance: (r.provenance ?? {}) as SystemEvent["provenance"],
    private: (r.private ?? {}) as Record<string, unknown>,
    withheld: r.withheld, sourceKind: r.sourceKind as SystemEvent["sourceKind"],
    sourceId: r.sourceId, prevHash: r.prevHash, hash: r.hash,
  }));
  const asGrants: Grant[] = grantRows.map((g) => ({
    id: g.id, instrumentId: g.instrumentId, epochId: g.epochId,
    granteeOrgId: g.granteeOrgId, grantedByOrgId: g.grantedByOrgId ?? 0,
    kind: g.kind as GrantKind, scope: (g.scope ?? {}) as Record<string, unknown>,
    startsAt: g.startsAt, endsAt: g.endsAt, endedAt: g.endedAt, endedBy: g.endedBy,
    endReason: (g.endReason || null) as GrantEndReason | null,
  }));
  return { instrumentId, epochs, events, grants: asGrants };
}

export type CustodyContext = {
  chain: SystemChain;
  /** What this viewer gets of each epoch. Empty for a viewer with no standing. */
  epochs: EpochView[];
  /** True when the machine has no epochs at all - nothing has been recorded yet. */
  untracked: boolean;
};

/**
 * One machine, as one viewer may see it.
 *
 * The whole chain is loaded and then filtered in pure code rather than filtered
 * in SQL. That is deliberate: the rules are subtle enough to need a truth table
 * (tests/custodyView.test.ts is one), and a WHERE clause cannot be given one.
 * A machine's chain is tens of rows, not millions.
 */
export async function custodyContext(
  viewerOrgId: OrgId | null, instrumentId: number,
): Promise<CustodyContext> {
  const [epochRows, eventRows, grantRows] = await Promise.all([
    db.select().from(custodyEpochs).where(eq(custodyEpochs.instrumentId, instrumentId))
      .orderBy(asc(custodyEpochs.n)),
    db.select().from(systemEvents).where(eq(systemEvents.instrumentId, instrumentId))
      .orderBy(asc(systemEvents.occurredAt), asc(systemEvents.id)),
    db.select().from(grants).where(eq(grants.instrumentId, instrumentId)),
  ]);
  const chain = toChain(instrumentId, epochRows, eventRows, grantRows);
  return { chain, epochs: viewOf(viewerOrgId, chain).epochs, untracked: epochRows.length === 0 };
}
