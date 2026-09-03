/**
 * Turn the handoffs on file into spans of custody, and file every event under
 * the span it happened in.
 *   DATABASE_URL=... npx tsx scripts/backfill-epochs.ts [--apply] [--instrument N]
 *
 * Dry by default. Idempotent: an epoch that already exists at (instrument, n)
 * is updated in place rather than duplicated, and an event already filed under
 * the right epoch is left alone.
 *
 * THE TIME BEFORE THE FIRST HANDOFF IS NOT AN EPOCH. Every owned system was
 * backfilled with one intake row, so the stretch before it is the stretch
 * before this platform existed - somebody's history, and we have none of it.
 * Events dated in it keep a null epoch_id and read as "before Ridgeline";
 * inventing a span would put a custodian's name on years nobody can account for.
 *
 * It does NOT touch instruments.owner_org_id. See scripts/custody-parity.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../src/db";
import { custodyEpochs, custodyEvents, instruments, orgs, systemEvents } from "../src/db/schema";
import { CLOSES_A_SPAN, spanAt, spansOf, type CustodyRow } from "../src/lib/custody/spans";

export async function main() {
  const apply = process.argv.includes("--apply");
  const onlyAt = process.argv.indexOf("--instrument");
  const only = onlyAt === -1 ? null : Number(process.argv[onlyAt + 1]);

  const insts = await db.select({
    id: instruments.id, externalId: instruments.externalId, ownerOrgId: instruments.ownerOrgId,
  }).from(instruments);
  const orgName = new Map((await db.select({ id: orgs.id, name: orgs.name }).from(orgs)).map((o) => [o.id, o.name]));

  let madeEpochs = 0, placedEvents = 0, orphanEvents = 0, machinesWithNoHistory = 0;

  for (const inst of insts) {
    if (only !== null && inst.id !== only) continue;

    const rows = await db.select({
      id: custodyEvents.id, kind: custodyEvents.kind,
      fromOrgId: custodyEvents.fromOrgId, toOrgId: custodyEvents.toOrgId,
      fromName: custodyEvents.fromName, toName: custodyEvents.toName, at: custodyEvents.at,
    }).from(custodyEvents).where(eq(custodyEvents.instrumentId, inst.id)).orderBy(asc(custodyEvents.at));

    const spans = spansOf(rows as CustodyRow[], {
      custodianOrgId: inst.ownerOrgId,
      custodianName: inst.ownerOrgId === null ? "house stewardship" : orgName.get(inst.ownerOrgId) ?? "",
    });
    if (!spans.length) { machinesWithNoHistory++; continue; }

    const epochIdByN = new Map<number, number>();
    for (const span of spans) {
      const [have] = await db.select({ id: custodyEpochs.id }).from(custodyEpochs)
        .where(and(eq(custodyEpochs.instrumentId, inst.id), eq(custodyEpochs.n, span.n))).limit(1);
      const values = {
        instrumentId: inst.id, n: span.n,
        custodianOrgId: span.custodianOrgId,
        custodianName: span.custodianName || (span.custodianOrgId === null ? "house stewardship" : orgName.get(span.custodianOrgId) ?? ""),
        closeKind: span.closeKind,
      };
      if (have) { epochIdByN.set(span.n, have.id); continue; }
      madeEpochs++;
      if (!apply) { epochIdByN.set(span.n, -span.n); continue; }
      const [made] = await db.insert(custodyEpochs).values(values).returning({ id: custodyEpochs.id });
      epochIdByN.set(span.n, made.id);
    }

    const events = await db.select({
      id: systemEvents.id, kind: systemEvents.kind,
      occurredAt: systemEvents.occurredAt, epochId: systemEvents.epochId,
    }).from(systemEvents).where(eq(systemEvents.instrumentId, inst.id));
    for (const e of events) {
      // A handoff closes the tenure it ends; everything else opens the one it
      // lands in. See spanAt - sealing freezes a bundle over the closing
      // epoch's events, and the transfer is the last line of it.
      const span = spanAt(spans, e.occurredAt, CLOSES_A_SPAN.has(e.kind) ? "closes" : "opens");
      if (span === null) { orphanEvents++; continue; }
      const epochId = epochIdByN.get(span.n);
      if (epochId === undefined || e.epochId === epochId) continue;
      placedEvents++;
      // epoch_id is one of exactly two columns the append-only trigger lets
      // change - see the trigger in drizzle/schema-sync.sql for why.
      if (apply) await db.update(systemEvents).set({ epochId }).where(eq(systemEvents.id, e.id));
    }
  }

  const openTotal = apply
    ? (await db.select({ n: sql<number>`count(*)::int` }).from(custodyEpochs).where(eq(custodyEpochs.closeKind, "open")))[0].n
    : 0;
  const unplaced = (await db.select({ n: sql<number>`count(*)::int` }).from(systemEvents).where(isNull(systemEvents.epochId)))[0].n;

  console.log(`[epochs] ${apply ? "wrote" : "would write"} ${madeEpochs} epoch(s) and place ${placedEvents} event(s)`);
  console.log(`[epochs] ${machinesWithNoHistory} machine(s) have no handoff on file and get no epoch at all`);
  console.log(`[epochs] ${orphanEvents} event(s) predate the first handoff and stay unfiled - "before Ridgeline"`);
  if (apply) console.log(`[epochs] ${openTotal} open epoch(s); ${unplaced} event(s) still unfiled`);
  if (!apply) console.log("[epochs] dry run; pass --apply to write");
}

// Auto-runs when you run it, and stays quiet when a test imports it to
// drive main() against a database of its own. A backfill nobody can
// exercise is a backfill nobody knows the behaviour of.
if (!process.env.VITEST) main().catch((e) => { console.error("[epochs] failed:", e); process.exit(1); });
