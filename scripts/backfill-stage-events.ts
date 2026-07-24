/**
 * One-off backfill of stage_events from history that predates the table:
 *   1. Every audit_log stage toggle (field='stages', action "added stage: X" /
 *      "removed stage: X") becomes an event at its audit timestamp.
 *   2. Any currently-active stage still missing an 'added' event gets one at
 *      the instrument's createdAt (best-effort baseline for seeded systems).
 *
 * Run once from a machine, soon after the stage_events deploy:
 *   DATABASE_URL=... npx tsx scripts/backfill-stage-events.ts
 * Refuses to run if stage_events already has more than a handful of rows
 * (pass --force to override) so a double run doesn't pollute the metrics.
 */
import { asc } from "drizzle-orm";
import { db } from "../src/db";
import { auditLog, instruments, stageEvents } from "../src/db/schema";

async function main() {
  const existing = await db.select().from(stageEvents);
  if (existing.length > 20 && !process.argv.includes("--force")) {
    console.error(`[backfill] stage_events already has ${existing.length} rows - refusing to run twice (use --force to override)`);
    process.exit(1);
  }

  const audits = await db.select().from(auditLog).orderBy(asc(auditLog.createdAt));
  let fromAudit = 0;
  const added = new Map<string, Date>(); // `${instId}|${stage}` -> first added
  for (const a of audits) {
    if (a.field !== "stages" || !a.instrumentId) continue;
    const m = /^(added|removed) stage: (.+)$/.exec(a.action);
    if (!m) continue;
    await db.insert(stageEvents).values({ instrumentId: a.instrumentId, stage: m[2], kind: m[1], at: a.createdAt });
    if (m[1] === "added") added.set(`${a.instrumentId}|${m[2]}`, a.createdAt);
    fromAudit++;
  }

  let baseline = 0;
  const insts = await db.select().from(instruments);
  for (const i of insts) {
    for (const stage of i.stages) {
      if (added.has(`${i.id}|${stage}`)) continue;
      await db.insert(stageEvents).values({ instrumentId: i.id, stage, kind: "added", at: i.createdAt });
      baseline++;
    }
  }

  console.log(`[backfill] done: ${fromAudit} events from the audit log, ${baseline} baseline events at instrument creation`);
}

main().catch((e) => { console.error("[backfill] failed:", e.message); process.exit(1); });
