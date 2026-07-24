// Stage age bookkeeping over stage_events rows. The pure walk is separated
// from the DB fetch so it's unit-testable.
import { asc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { stageEvents } from "@/db/schema";

export type StageEvent = { instrumentId: number; stage: string; kind: string; at: Date };

/** Walk events (oldest first) to the current "in this stage since" per instrument. */
export function sinceByStage(events: StageEvent[]): Map<number, Map<string, Date>> {
  const m = new Map<number, Map<string, Date>>();
  for (const e of events) {
    let inst = m.get(e.instrumentId);
    if (!inst) m.set(e.instrumentId, (inst = new Map()));
    if (e.kind === "added") {
      if (!inst.has(e.stage)) inst.set(e.stage, e.at); // keep the earliest add of the current run
    } else {
      inst.delete(e.stage);
    }
  }
  return m;
}

/** Completed (added -> removed) durations in days, grouped by stage. */
export function completedDurations(events: StageEvent[]): Map<string, number[]> {
  const open = new Map<string, Date>(); // `${instrumentId}|${stage}` -> added at
  const out = new Map<string, number[]>();
  for (const e of events) {
    const k = `${e.instrumentId}|${e.stage}`;
    if (e.kind === "added") {
      if (!open.has(k)) open.set(k, e.at);
    } else {
      const started = open.get(k);
      if (started) {
        open.delete(k);
        const days = (e.at.getTime() - started.getTime()) / 86_400_000;
        const list = out.get(e.stage) ?? [];
        list.push(days);
        out.set(e.stage, list);
      }
    }
  }
  return out;
}

export function ageDays(since: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / 86_400_000));
}

/** Fetch + walk for a set of instruments. */
export async function getStageSince(instrumentIds: number[]): Promise<Map<number, Map<string, Date>>> {
  if (!instrumentIds.length) return new Map();
  const events = await db.select().from(stageEvents)
    .where(inArray(stageEvents.instrumentId, instrumentIds))
    .orderBy(asc(stageEvents.at), asc(stageEvents.id));
  return sinceByStage(events);
}
