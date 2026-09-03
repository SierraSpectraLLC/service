// The maintenance plan, derived from the chain instead of stored beside it.
//
// pm_schedules.last_done and next_due are two columns somebody updates when a
// task completes, and three code paths do (setTaskState, completePmNow,
// alignMaintenance). They agree when nothing goes wrong. The chain is one
// list of what happened, and "when was the lamp last changed" is a question
// about that list - so the answer is read off it, per procedure KEY, which is
// what lets a PM done under the previous holder count for the next one.
//
// Pure core, thin loader. Under custody.sheets the maintenance tab reads this;
// the stored columns keep being written by the old paths (and by a run) until
// Phase 8 retires them.

import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { pmSchedules, procedures, systemEvents } from "@/db/schema";
import { addDays } from "@/lib/pm";
import type { ProcedureKeyEntry, WhoGrade } from "@/lib/custody/types";

export type PlanRow = { key: string; title: string; intervalDays: number | null; usageEvery?: number | null; usageUnit?: string };

export type PlanEventLike = {
  occurredAt: Date;
  whoGrade: WhoGrade;
  procedureKeys: ProcedureKeyEntry[];
};

export type PlanStatus = {
  key: string;
  title: string;
  /** YYYY-MM-DD of the latest `done` for this key, or "" when the chain has none. */
  lastDone: string;
  /** The grade of that line - a buyer reading "last PM" deserves to know it was attested. */
  lastGrade: WhoGrade | null;
  /** From lastDone and the cadence. "" when either is missing. */
  nextDue: string;
  /** The latest line SKIPPED it after the last done: the work is still owed. */
  stillDue: boolean;
  /** Why it was skipped, from the line. Travels, so it can be shown to the next holder. */
  skipReason: string;
  /** No cadence and no history: the plan cannot say anything about it. */
  unknown: boolean;
};

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Per key: the latest done, the latest skip after it, and the next due.
 *
 * "Latest" is by occurredAt, not by when the line was recorded: a backfilled
 * intake dated 2024 is 2024's maintenance however recently somebody typed it.
 */
export function planStatus(rows: PlanRow[], events: PlanEventLike[], today: string): PlanStatus[] {
  const ordered = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  return rows.map((r) => {
    let lastDone: { at: Date; grade: WhoGrade } | null = null;
    let skip: { at: Date; reason: string } | null = null;
    for (const e of ordered) {
      for (const k of e.procedureKeys) {
        if (k.key !== r.key) continue;
        if (k.state === "done") { lastDone = { at: e.occurredAt, grade: e.whoGrade }; skip = null; }
        else if (k.state === "skip") skip = { at: e.occurredAt, reason: k.reason ?? "" };
      }
    }
    const lastDoneDay = lastDone ? day(lastDone.at) : "";
    const nextDue = lastDoneDay && r.intervalDays ? addDays(lastDoneDay, r.intervalDays) : "";
    return {
      key: r.key, title: r.title,
      lastDone: lastDoneDay, lastGrade: lastDone?.grade ?? null,
      nextDue,
      stillDue: skip !== null,
      skipReason: skip?.reason ?? "",
      unknown: !lastDone && !skip && !r.intervalDays,
    };
  });
}

/** Overdue, by the derived next due. */
export const isOverdue = (p: PlanStatus, today: string): boolean => !!p.nextDue && p.nextDue <= today;

/**
 * The rows a machine's plan is made of: its schedules' procedures, by key.
 * Schedules with no procedure (hand-made) have no key and are not in the plan -
 * they stay on the stored columns, which is what they always were.
 */
export async function planRowsFor(instrumentId: number): Promise<PlanRow[]> {
  const scheds = await db.select({ procedureId: pmSchedules.procedureId, title: pmSchedules.title, everyDays: pmSchedules.everyDays })
    .from(pmSchedules).where(eq(pmSchedules.instrumentId, instrumentId));
  const ids = scheds.map((s) => s.procedureId).filter((x): x is number => x !== null);
  const procs = ids.length ? await db.select({ id: procedures.id, key: procedures.key, name: procedures.name, intervalDays: procedures.intervalDays, usageEvery: procedures.usageEvery, usageUnit: procedures.usageUnit })
    .from(procedures).where(inArray(procedures.id, ids)) : [];
  const byId = new Map(procs.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: PlanRow[] = [];
  for (const s of scheds) {
    const p = s.procedureId === null ? null : byId.get(s.procedureId);
    if (!p || !p.key || seen.has(p.key)) continue;
    seen.add(p.key);
    out.push({ key: p.key, title: s.title || p.name, intervalDays: p.intervalDays ?? s.everyDays, usageEvery: p.usageEvery, usageUnit: p.usageUnit });
  }
  return out;
}

export async function planStatusFor(instrumentId: number, today: string): Promise<PlanStatus[]> {
  const rows = await planRowsFor(instrumentId);
  if (!rows.length) return [];
  const events = await db.select({ occurredAt: systemEvents.occurredAt, whoGrade: systemEvents.whoGrade, procedureKeys: systemEvents.procedureKeys })
    .from(systemEvents).where(eq(systemEvents.instrumentId, instrumentId)).orderBy(asc(systemEvents.occurredAt));
  return planStatus(rows, events.map((e) => ({ occurredAt: e.occurredAt, whoGrade: e.whoGrade as WhoGrade, procedureKeys: (e.procedureKeys ?? []) as ProcedureKeyEntry[] })), today);
}
