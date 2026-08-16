// Whether a system (or standalone unit) may be signed off, and why not.
//
// Pure, because this is the one rule a signature depends on: sign a record that
// wasn't actually finished and the signature is worse than no signature at all.
// The server recomputes it at the moment of signing - the UI's answer is a
// courtesy, never the authority.

export type GateTask = {
  id: number;
  title: string;
  state: string;
  /** True when the procedure that generated it is marked required. */
  required: boolean;
  /** 'test' tests need a report on file; 'task' work just needs doing. */
  kind: string;
};

export type Blocker = { kind: "open_work" | "missing_report"; text: string };

export type Gate = {
  ready: boolean;
  blockers: Blocker[];
  /** For the frozen snapshot and the packet's evidence list. */
  tasksTotal: number;
  tasksDone: number;
  requiredTests: { id: number; title: string; reports: number }[];
};

/**
 * `reportsByTask` counts the evidence filed against each task id: attachments,
 * and a recorded test result. A mandatory TEST needs at least one - "passing"
 * is a claim that has to be evidenced, and a Done checkbox is not evidence. A
 * mandatory TASK only has to be done.
 *
 * A recorded result counts because it is the thing the rule was reaching for.
 * "5.2 mL/min, within 4.5-5.5, by Joe on the 3rd" is the measurement itself,
 * attributed and timestamped; a file was only ever the closest thing available
 * before there was anywhere to put the number.
 */
export function signoffGate(tasks: GateTask[], reportsByTask: Map<number, number>): Gate {
  const open = tasks.filter((t) => t.state !== "Done");
  const requiredTests = tasks
    .filter((t) => t.required && t.kind === "test")
    .map((t) => ({ id: t.id, title: t.title, reports: reportsByTask.get(t.id) ?? 0 }));

  const blockers: Blocker[] = [];
  if (open.length) {
    blockers.push({
      kind: "open_work",
      text: open.length === 1
        ? `"${open[0].title}" is still ${open[0].state.toLowerCase()}`
        : `${open.length} tasks are not Done`,
    });
  }
  // Only complain about missing reports once the test itself is done - chasing
  // paperwork for work nobody has started is noise.
  for (const t of requiredTests) {
    if (t.reports === 0 && !open.some((o) => o.id === t.id)) {
      blockers.push({ kind: "missing_report", text: `"${t.title}" has no report on file` });
    }
  }
  return {
    ready: blockers.length === 0,
    blockers,
    tasksTotal: tasks.length,
    tasksDone: tasks.length - open.length,
    requiredTests,
  };
}

/** What the frozen snapshot on a signature holds. */
export type SignoffSnapshot = {
  version: 1;
  tasksTotal: number;
  tasksDone: number;
  requiredTests: { title: string; reports: number }[];
};

export const snapshotOf = (g: Gate): SignoffSnapshot => ({
  version: 1,
  tasksTotal: g.tasksTotal,
  tasksDone: g.tasksDone,
  requiredTests: g.requiredTests.map((t) => ({ title: t.title, reports: t.reports })),
});

/**
 * Has the record moved since it was signed? A signature attests to a moment,
 * so this doesn't invalidate anything - it tells the reader the packet in front
 * of them is no longer the packet that was approved.
 */
export function signatureIsStale(snap: SignoffSnapshot | null, now: Gate): boolean {
  if (!snap) return false;
  return snap.tasksTotal !== now.tasksTotal || snap.tasksDone !== now.tasksDone;
}
