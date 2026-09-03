/**
 * Fill system_events from the history that predates it.
 *   DATABASE_URL=... npx tsx scripts/backfill-system-events.ts [--instrument N]
 *
 * IDEMPOTENT, and that is load-bearing rather than polite: this is also the
 * repair tool for an emitter that failed (lib/custody/emit swallows its errors
 * so a broken chain can never refuse to close somebody's work order), so it
 * will routinely run over rows the live path already wrote. A second run
 * inserts nothing.
 *
 * IT USES THE EMITTERS. The plan called for the backfill to write its own rows
 * with source_kind 'backfill', which would have given one work order two events
 * - the emitter's (source_kind 'work_order') and this script's - and no unique
 * index could have caught it. Sharing (source_kind, source_id) with the live
 * path is what makes the two converge instead of duplicating, and it means
 * there is ONE classification of what travels rather than two that drift.
 * 'backfill' stays the source kind for the two sources nothing emits:
 * stage_events and asset_events.
 *
 * ORDERED BY THE SOURCE'S OWN TIMESTAMP, per instrument, so the chain reads
 * honestly: an event dated 2019 is appended before one dated 2021 even though
 * both are being written today.
 */
import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../src/db";
import {
  assetEvents, assets, checkoutVerdicts, custodyEvents, instruments, stageEvents,
  systemEvents, tasks, workOrders,
} from "../src/db/schema";
import { appendEvent } from "../src/lib/custody/append";
import {
  custodianOfAt, emitCheckoutVerdict, emitCustodyEvent, emitPmTask, emitWorkOrderClosed,
} from "../src/lib/custody/emit";

type Job = { at: Date; source: string; run: () => Promise<unknown> };

export async function main() {
  const only = (() => {
    const i = process.argv.indexOf("--instrument");
    return i === -1 ? null : Number(process.argv[i + 1]);
  })();

  const insts = only
    ? await db.select({ id: instruments.id, externalId: instruments.externalId })
        .from(instruments).where(eq(instruments.id, only))
    : await db.select({ id: instruments.id, externalId: instruments.externalId }).from(instruments);
  if (!insts.length) { console.log("[events] no instruments"); return; }
  const ids = insts.map((i) => i.id);

  const [wos, pmTasks, custody, verdicts, stages, assetRows] = await Promise.all([
    db.select({ id: workOrders.id, instrumentId: workOrders.instrumentId, closedAt: workOrders.closedAt })
      .from(workOrders).where(inArray(workOrders.instrumentId, ids)),
    db.select({ id: tasks.id, instrumentId: tasks.instrumentId, completedAt: tasks.completedAt, origin: tasks.origin, state: tasks.state })
      .from(tasks).where(inArray(tasks.instrumentId, ids)),
    db.select({ id: custodyEvents.id, instrumentId: custodyEvents.instrumentId, at: custodyEvents.at })
      .from(custodyEvents).where(inArray(custodyEvents.instrumentId, ids)),
    db.select({ id: checkoutVerdicts.id, instrumentId: checkoutVerdicts.instrumentId, recordedAt: checkoutVerdicts.recordedAt })
      .from(checkoutVerdicts).where(inArray(checkoutVerdicts.instrumentId, ids)),
    db.select().from(stageEvents).where(inArray(stageEvents.instrumentId, ids)).orderBy(asc(stageEvents.at)),
    db.select({
      id: assetEvents.id, assetId: assetEvents.assetId, kind: assetEvents.kind,
      instrumentId: assets.instrumentId, detail: assetEvents.detail, actor: assetEvents.actor, at: assetEvents.at,
    }).from(assetEvents).innerJoin(assets, eq(assets.id, assetEvents.assetId))
      .where(inArray(assets.instrumentId, ids)),
  ]);

  // One bucket per machine, because the chain is per machine and appending in
  // global date order would interleave two instruments for no benefit.
  const byInstrument = new Map<number, Job[]>();
  const push = (instrumentId: number | null, job: Job) => {
    if (instrumentId === null) return;
    byInstrument.set(instrumentId, [...(byInstrument.get(instrumentId) ?? []), job]);
  };

  for (const w of wos) {
    if (w.closedAt === null) continue;
    push(w.instrumentId, { at: w.closedAt, source: "work_order", run: () => emitWorkOrderClosed(w.id) });
  }
  for (const t of pmTasks) {
    if (t.state !== "Done" || t.completedAt === null) continue;
    if (t.origin !== "pm" && t.origin !== "pm_request") continue;
    push(t.instrumentId, { at: t.completedAt, source: "task", run: () => emitPmTask(t.id) });
  }
  for (const c of custody) push(c.instrumentId, { at: c.at, source: "custody_event", run: () => emitCustodyEvent(c.id) });
  for (const v of verdicts) push(v.instrumentId, { at: v.recordedAt, source: "checkout_verdict", run: () => emitCheckoutVerdict(v.id) });

  // The two sources with no emitter. UNCHECKED IS NOT OURS TO PUBLISH: a stage
  // name and a module note were written as internal bookkeeping by people who
  // had no idea either would ever be read by a stranger who buys the machine,
  // so the kind and the dates travel and every word of it stays private.
  // Promoting structured fields out of these is a later, per-type job.
  for (const s of stages) {
    push(s.instrumentId, {
      at: s.at, source: "stage_event",
      run: async () => appendEvent({
        instrumentId: s.instrumentId, kind: "note", occurredAt: s.at, recordedAt: s.at,
        authorOrgId: null, custodianOrgId: await custodianOfAt(s.instrumentId, s.at),
        whoGrade: "attested", howGrade: "document_only",
        provenance: {}, private: { stage: s.stage, change: s.kind },
        sourceKind: "backfill", sourceId: `stage_event:${s.id}`,
      }),
    });
  }
  for (const a of assetRows) {
    if (a.instrumentId === null) continue;
    push(a.instrumentId, {
      at: a.at, source: "asset_event",
      run: async () => appendEvent({
        instrumentId: a.instrumentId!, assetId: a.assetId, kind: "config",
        occurredAt: a.at, recordedAt: a.at,
        authorOrgId: null, custodianOrgId: await custodianOfAt(a.instrumentId!, a.at),
        whoGrade: "attested", howGrade: "document_only",
        provenance: {}, private: { change: a.kind, detail: a.detail, actor: a.actor },
        sourceKind: "backfill", sourceId: `asset_event:${a.id}`,
      }),
    });
  }

  const before = (await db.select({ n: sql<number>`count(*)::int` }).from(systemEvents))[0].n;
  const perSource = new Map<string, number>();
  const perInstrument = new Map<number, number>();
  let failed = 0;

  for (const inst of insts) {
    const jobs = (byInstrument.get(inst.id) ?? []).sort((x, y) => x.at.getTime() - y.at.getTime());
    for (const job of jobs) {
      try {
        await job.run();
        perSource.set(job.source, (perSource.get(job.source) ?? 0) + 1);
        perInstrument.set(inst.id, (perInstrument.get(inst.id) ?? 0) + 1);
      } catch (e) {
        failed++;
        console.error(`[events] ${inst.externalId} ${job.source}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  const after = (await db.select({ n: sql<number>`count(*)::int` }).from(systemEvents))[0].n;
  console.log(`[events] ${insts.length} instrument(s), ${after - before} new event(s), ${after} on file`);
  for (const [source, n] of [...perSource].sort()) console.log(`[events]   ${source}: ${n} considered`);
  const busiest = [...perInstrument].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [id, n] of busiest) {
    console.log(`[events]   ${insts.find((i) => i.id === id)?.externalId ?? id}: ${n}`);
  }
  if (failed) console.error(`[events] ${failed} event(s) could not be written - see above`);
  // A run that adds nothing is the expected second run, and worth saying so
  // nobody reads silence as a broken script.
  if (after === before) console.log("[events] nothing new - already backfilled");
}

// Auto-runs when you run it, and stays quiet when a test imports it to
// drive main() against a database of its own. A backfill nobody can
// exercise is a backfill nobody knows the behaviour of.
if (!process.env.VITEST) main().catch((e) => { console.error("[events] failed:", e); process.exit(1); });
