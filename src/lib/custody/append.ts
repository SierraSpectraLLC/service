// The only way a row enters system_events.
//
// Two things have to hold and neither can be left to a caller remembering:
// the chain per machine must be LINEAR (no two events claiming the same
// predecessor), and every emitter must be safe to run twice - because the
// backfill exists precisely to repair emitters that failed, and it will run
// over rows they already wrote.
//
// HOW THE CHAIN IS SERIALIZED. The spec called for SELECT ... FOR UPDATE on the
// instrument row. The production driver is neon-http, which has no interactive
// transactions at all (drizzle throws "No transactions support"), so that lock
// cannot be taken from this app. The unique index on (instrument_id, prev_hash)
// does the same job from below: two racing appends read the same last hash,
// both compute a successor, and the second INSERT loses on the index. We re-read
// and retry. That is strictly stronger than the lock would have been - it holds
// for a future code path that forgets to take one, and it makes a forked chain
// unrepresentable rather than merely unlikely.

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { custodyEpochs, systemEvents } from "@/db/schema";
import { GENESIS, eventHash } from "@/lib/custody/hash";
import { provenanceLeaks } from "@/lib/custody/policy";
import type {
  EventKind, HowGrade, OrgId, ProcedureKeyEntry, SourceKind, WhoGrade,
} from "@/lib/custody/types";

export type AppendInput = {
  instrumentId: number;
  assetId?: number | null;
  kind: EventKind;
  occurredAt: Date;
  /** Defaults to now. The backfill passes the source row's own stamp instead. */
  recordedAt?: Date;
  authorOrgId: OrgId | null;
  commissionerOrgId?: OrgId | null;
  custodianOrgId: OrgId | null;
  whoGrade: WhoGrade;
  howGrade: HowGrade;
  procedureKeys?: ProcedureKeyEntry[];
  provenance?: Record<string, unknown>;
  private?: Record<string, unknown>;
  withheld?: boolean;
  sourceKind: SourceKind;
  /** Together with sourceKind this is what makes a re-run a no-op. */
  sourceId?: string | null;
  /** Phase 3 onwards. Nothing may target an epoch before epochs exist. */
  epochId?: number | null;
};

export type AppendResult =
  | { id: number; created: true }
  | { id: number; created: false; why: "already recorded" };

const RETRIES = 5;

const isUnique = (e: unknown, constraint: string): boolean => {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string })?.code;
  return (code === "23505" || /duplicate key value/i.test(msg)) && msg.includes(constraint);
};

async function existingBySource(sourceKind: string, sourceId: string): Promise<number | null> {
  const [row] = await db.select({ id: systemEvents.id }).from(systemEvents)
    .where(and(eq(systemEvents.sourceKind, sourceKind), eq(systemEvents.sourceId, sourceId)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Append one event, or find the one that is already there.
 *
 * Never throws on a double write: an emitter firing twice for one work order is
 * the expected case, not an error, and making callers distinguish would put the
 * decision in twelve places instead of one.
 */
/**
 * The rules an event has to pass before it exists, in one place.
 *
 * Thrown rather than returned: a caller that tried to file a machine's history
 * with a customer's site address on the travelling half has a bug, and a bug
 * that gets a polite { error } back gets ignored. Every one of these is a test
 * failure in development and an incident in production, in that order.
 */
export function checkEvent(input: Pick<AppendInput, "kind" | "provenance" | "procedureKeys">): void {
  if (!input.kind || !String(input.kind).trim()) {
    throw new Error("appendEvent: an event needs a kind - a line with no kind is a date, not history");
  }
  const leaks = provenanceLeaks(input.provenance ?? {});
  if (leaks.length) {
    throw new Error(`appendEvent: provenance carries keys that must not travel: ${leaks.join(", ")}`);
  }
  for (const k of input.procedureKeys ?? []) {
    if (!k.key) throw new Error("appendEvent: a procedure entry needs its key");
    // A skipped step with no reason is a hole the next holder cannot price:
    // "still due" only means something if it says why. The reason travels.
    if (k.state === "skip" && !(k.reason ?? "").trim()) {
      throw new Error(`appendEvent: skipping ${k.key} needs a reason, and the reason travels`);
    }
  }
}

export async function appendEvent(input: AppendInput): Promise<AppendResult> {
  checkEvent(input);
  const sourceId = input.sourceId ?? null;
  if (sourceId !== null) {
    const already = await existingBySource(input.sourceKind, sourceId);
    if (already !== null) return { id: already, created: false, why: "already recorded" };
  }

  // Checked AFTER idempotence on purpose: a row that is already recorded is not
  // an append, and judging it against a since-closed epoch would make the
  // backfill fail on its own previous run.
  if (input.epochId != null) {
    // A CLOSED EPOCH IS FROZEN. Its holder sealed a bundle over exactly these
    // events and somebody else received it; appending into it afterwards would
    // rewrite a record that has already left the building. Enforced here now
    // and in a trigger in Phase 5 - two layers, because this one is worth one
    // forgotten call site.
    const [epoch] = await db.select({ closeKind: custodyEpochs.closeKind, instrumentId: custodyEpochs.instrumentId })
      .from(custodyEpochs).where(eq(custodyEpochs.id, input.epochId)).limit(1);
    if (!epoch) throw new Error(`appendEvent: epoch ${input.epochId} does not exist`);
    if (epoch.instrumentId !== input.instrumentId) {
      throw new Error(`appendEvent: epoch ${input.epochId} belongs to another machine`);
    }
    if (epoch.closeKind !== "open") {
      throw new Error(`appendEvent: epoch ${input.epochId} closed as '${epoch.closeKind}' and is frozen`);
    }
  }

  const procedureKeys = input.procedureKeys ?? [];
  const provenance = input.provenance ?? {};

  for (let attempt = 0; attempt < RETRIES; attempt++) {
    // The tail of the chain. Ordered by id, not by time: the chain is the order
    // things were RECORDED, and a backfilled event dated 2019 is still appended
    // after whatever was written before it.
    const [last] = await db.select({ hash: systemEvents.hash }).from(systemEvents)
      .where(eq(systemEvents.instrumentId, input.instrumentId))
      .orderBy(desc(systemEvents.id)).limit(1);
    const prevHash = last?.hash || GENESIS;
    const hash = eventHash(prevHash, {
      kind: input.kind, occurredAt: input.occurredAt, authorOrgId: input.authorOrgId,
      procedureKeys, provenance,
    });

    try {
      const [row] = await db.insert(systemEvents).values({
        instrumentId: input.instrumentId,
        assetId: input.assetId ?? null,
        epochId: input.epochId ?? null,
        kind: input.kind,
        occurredAt: input.occurredAt,
        recordedAt: input.recordedAt ?? new Date(),
        authorOrgId: input.authorOrgId,
        commissionerOrgId: input.commissionerOrgId ?? null,
        custodianOrgId: input.custodianOrgId,
        whoGrade: input.whoGrade,
        howGrade: input.howGrade,
        procedureKeys,
        provenance,
        private: input.private ?? {},
        withheld: input.withheld ?? false,
        sourceKind: input.sourceKind,
        sourceId,
        prevHash,
        hash,
      }).returning({ id: systemEvents.id });
      return { id: row.id, created: true };
    } catch (e) {
      // Somebody else appended to this machine between our read and our write.
      // Re-read the tail and build on theirs.
      if (isUnique(e, "system_events_chain_unique")) continue;
      // Two emitters for one source row raced. Theirs won; it is the same event.
      if (isUnique(e, "system_events_source_unique") && sourceId !== null) {
        const already = await existingBySource(input.sourceKind, sourceId);
        if (already !== null) return { id: already, created: false, why: "already recorded" };
      }
      throw e;
    }
  }
  throw new Error(
    `appendEvent: instrument ${input.instrumentId} lost the chain race ${RETRIES} times - `
    + "something is appending in a loop",
  );
}

/**
 * Place an event in a custody span. One of exactly two columns the append-only
 * trigger lets change, because Phase 3 sorts events into spans that did not
 * exist when they were written. Never touches anything hashed.
 */
export async function setEventEpoch(eventId: number, epochId: number | null): Promise<void> {
  await db.update(systemEvents).set({ epochId }).where(eq(systemEvents.id, eventId));
}

/** How many events one machine carries. Used by the backfill's summary. */
export async function eventCount(instrumentId: number): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(systemEvents)
    .where(eq(systemEvents.instrumentId, instrumentId));
  return row?.n ?? 0;
}
