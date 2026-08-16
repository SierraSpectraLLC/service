// The test half of a list of tasks: which of them are tests, and what each one
// read.
//
// Three pages mount TasksPanel - a system, a standalone unit, a work order -
// and a test has to look and behave the same on all three. Assembling this in
// each page is how the ★-evidence list already drifted into being computed one
// way on two pages and hardcoded false on the third; one loader means a test
// cannot be a test in one place and a checkbox in another.

import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { procedures, taskResults } from "@/db/schema";
import { needsResult } from "@/lib/testResult";

export type TaskTestSpec = { resultType: string; target: string | null; tolerancePct: string | null };
export type TaskTestResult = {
  value: string; passed: boolean | null; note: string; recordedBy: string; recordedAt: string;
};
/** Keyed by task id; a task absent from `tests` is ordinary work. */
export type TaskTests = {
  tests: Map<number, TaskTestSpec>;
  results: Map<number, TaskTestResult>;
};

/**
 * `rows` is whatever the page already selected from tasks - only the id and the
 * procedure behind it are read.
 */
export async function loadTaskTests(
  rows: { id: number; procedureId: number | null }[],
): Promise<TaskTests> {
  const tests = new Map<number, TaskTestSpec>();
  const results = new Map<number, TaskTestResult>();
  if (!rows.length) return { tests, results };

  const procIds = [...new Set(rows.flatMap((t) => (t.procedureId !== null ? [t.procedureId] : [])))];
  const [procRows, resultRows] = await Promise.all([
    procIds.length
      ? db.select({
          id: procedures.id, kind: procedures.kind, resultType: procedures.resultType,
          target: procedures.target, tolerancePct: procedures.tolerancePct,
        }).from(procedures).where(inArray(procedures.id, procIds))
      : [],
    db.select().from(taskResults).where(inArray(taskResults.taskId, rows.map((t) => t.id))),
  ]);

  for (const t of rows) {
    const p = procRows.find((x) => x.id === t.procedureId);
    // Tests, and tasks whose outcome is inspected/replaced - both close by
    // recording what happened, so both get the result block and the gate.
    if (p && needsResult(p.kind, p.resultType)) {
      tests.set(t.id, { resultType: p.resultType, target: p.target, tolerancePct: p.tolerancePct });
    }
  }
  for (const r of resultRows) {
    results.set(r.taskId, {
      value: r.value, passed: r.passed, note: r.note,
      recordedBy: r.recordedBy, recordedAt: r.recordedAt.toISOString(),
    });
  }
  return { tests, results };
}

/** The two fields TasksPanel wants on each task row. */
export const testFieldsFor = (t: TaskTests, taskId: number) => ({
  test: t.tests.get(taskId) ?? null,
  result: t.results.get(taskId) ?? null,
});
