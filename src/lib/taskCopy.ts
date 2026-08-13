// Copying tasks from one system to another.
//
// The case that asked for it: fifteen pump tasks written once, and then an
// all-in-one pump arrives on a second system that needs the same fifteen. Typing
// them again is an afternoon and produces fifteen subtly different titles.
//
// The whole difficulty is deciding what a copy IS, because a task carries
// several things that belong to the machine it was written on rather than to
// the work. Getting that wrong does not look like a bug - it looks like a
// correct record that quietly says something untrue about a customer's
// instrument. So the rules are here, pure, one place, with the reason attached
// to each one.

export type SourceTask = {
  id: number;
  title: string;
  body: string;
  assignee: string;
  dueDate: string;
  state: string;
  origin: string;
  assetId: number | null;
  pmScheduleId: number | null;
  procedureId: number | null;
  sortOrder: number;
  checklist: { text: string; sortOrder: number }[];
};

export type CopiedTask = {
  title: string;
  body: string;
  assignee: string;
  dueDate: string;
  state: string;
  origin: string;
  assetId: number | null;
  pmScheduleId: number | null;
  procedureId: number | null;
  sortOrder: number;
  completedAt: null;
  checklist: { text: string; done: false; sortOrder: number }[];
};

/**
 * One task, as it should arrive on another system.
 *
 * What is carried: the words. The title, the body and the checklist are the
 * work, and they are the reason anybody is doing this.
 *
 * What is dropped, and why each one matters:
 *
 *  - **State and completion.** A copy always arrives Open. Copying a finished
 *    task copies the instruction, never the claim that it was carried out - and
 *    a task marked Done on a machine nobody has touched is exactly that claim.
 *  - **Checklist ticks.** Same reason, one level down.
 *  - **The PM schedule.** Non-negotiable: completing a task advances the
 *    schedule that generated it, so a copy that kept the pointer would move
 *    another system's maintenance calendar from a page nobody was looking at.
 *  - **The procedure.** It marks a task as a mandatory test for sign-off on the
 *    system whose intake generated it. A copy is new work, and inheriting a
 *    sign-off gate silently is not something somebody asked for by pressing
 *    Copy.
 *  - **Origin.** With the schedule and the procedure gone, "pm" or "checkout"
 *    would describe an ancestry the copy no longer has. It is hand-made work now.
 *  - **The due date.** A date set against another machine's calendar means
 *    nothing here, and a stale one would show up overdue on arrival.
 *  - **The asset.** Ids do not survive the trip; the target has its own units.
 *
 * The assignee is kept. Whoever does this work on one pump is the likeliest
 * person to do it on the next, and it is one dropdown to change.
 */
export function copyOfTask(t: SourceTask, sortOrder: number): CopiedTask {
  return {
    title: t.title,
    body: t.body,
    assignee: t.assignee,
    dueDate: "",
    state: "Open",
    origin: "",
    assetId: null,
    pmScheduleId: null,
    procedureId: null,
    sortOrder,
    completedAt: null,
    checklist: [...t.checklist]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((c, i) => ({ text: c.text, done: false as const, sortOrder: i })),
  };
}

/**
 * The whole batch, in the order they were shown, landing after whatever the
 * target already has.
 *
 * Order is taken from the source's own sort, not from the order somebody happened
 * to tick the boxes: a checklist of fifteen pump steps is a sequence, and
 * arriving shuffled would make it useless.
 */
export function copyPlan(tasks: SourceTask[], afterSortOrder: number): CopiedTask[] {
  return [...tasks]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
    .map((t, i) => copyOfTask(t, afterSortOrder + i + 1));
}

/** What the audit line and the confirmation say. Counted, and named when few. */
export function copySummary(titles: string[], targetLabel: string): string {
  const n = titles.length;
  const what = n === 1 ? `"${titles[0]}"`
    : n <= 3 ? titles.map((t) => `"${t}"`).join(", ")
      : `${n} tasks`;
  return `copied ${what} to ${targetLabel}`;
}

/**
 * Which of the tasks on screen may be copied.
 *
 * Everything, including finished ones - "do what we did on that system" is a
 * normal request, and the copy arrives Open. A task with no title has nothing to
 * carry across and is the one thing left out.
 */
export const copyable = (t: { title: string }) => t.title.trim().length > 0;
