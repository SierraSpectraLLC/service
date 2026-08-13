import { describe, expect, it } from "vitest";
import { copyable, copyOfTask, copyPlan, copySummary, type SourceTask } from "@/lib/taskCopy";

const task = (over: Partial<SourceTask> = {}): SourceTask => ({
  id: 1, title: "Replace pump seals", body: "Kit 5063-6589.", assignee: "Joe",
  dueDate: "2026-09-01", state: "Done", origin: "pm", assetId: 44,
  pmScheduleId: 7, procedureId: 12, sortOrder: 3,
  checklist: [
    { text: "Depressurize", sortOrder: 0 },
    { text: "Swap seals", sortOrder: 1 },
  ],
  ...over,
});

describe("what a copied task carries", () => {
  it("carries the words, which are the reason anybody pressed Copy", () => {
    const c = copyOfTask(task(), 10);
    expect(c.title).toBe("Replace pump seals");
    expect(c.body).toBe("Kit 5063-6589.");
    expect(c.checklist.map((x) => x.text)).toEqual(["Depressurize", "Swap seals"]);
  });

  it("keeps the assignee, who is likeliest to do it again", () => {
    expect(copyOfTask(task(), 10).assignee).toBe("Joe");
  });

  it("orders the checklist by the sequence it was written in, not by luck", () => {
    const c = copyOfTask(task({ checklist: [
      { text: "third", sortOrder: 9 }, { text: "first", sortOrder: 1 }, { text: "second", sortOrder: 4 },
    ] }), 0);
    expect(c.checklist.map((x) => x.text)).toEqual(["first", "second", "third"]);
    expect(c.checklist.map((x) => x.sortOrder)).toEqual([0, 1, 2]);
  });
});

describe("what a copied task must never carry", () => {
  it("arrives Open however finished the original was", () => {
    // Copying a Done task copies the instruction, never the claim that somebody
    // carried it out on a machine nobody has touched.
    const c = copyOfTask(task({ state: "Done" }), 0);
    expect(c.state).toBe("Open");
    expect(c.completedAt).toBeNull();
  });

  it("arrives with nothing ticked", () => {
    expect(copyOfTask(task(), 0).checklist.every((x) => x.done === false)).toBe(true);
  });

  it("never carries the maintenance schedule", () => {
    // The one that would do real damage: completing a task advances the schedule
    // that generated it, so a copy holding the pointer would move another
    // system's PM calendar from a page nobody was looking at.
    expect(copyOfTask(task({ pmScheduleId: 7 }), 0).pmScheduleId).toBeNull();
  });

  it("never carries the procedure, which is a sign-off gate", () => {
    expect(copyOfTask(task({ procedureId: 12 }), 0).procedureId).toBeNull();
  });

  it("is hand-made work, not something a schedule or an intake produced", () => {
    for (const origin of ["pm", "checkout", "issue", "pm_request"]) {
      expect(copyOfTask(task({ origin }), 0).origin).toBe("");
    }
  });

  it("drops a due date set against another machine's calendar", () => {
    // Kept, it would arrive already overdue and mean nothing.
    expect(copyOfTask(task({ dueDate: "2026-09-01" }), 0).dueDate).toBe("");
  });

  it("drops the unit, whose id belongs to the system it came from", () => {
    expect(copyOfTask(task({ assetId: 44 }), 0).assetId).toBeNull();
  });
});

describe("a batch landing on the target", () => {
  const three = [
    task({ id: 3, title: "Third", sortOrder: 30 }),
    task({ id: 1, title: "First", sortOrder: 10 }),
    task({ id: 2, title: "Second", sortOrder: 20 }),
  ];

  it("keeps the sequence they were written in", () => {
    expect(copyPlan(three, 0).map((t) => t.title)).toEqual(["First", "Second", "Third"]);
  });

  it("lands after whatever the target already has", () => {
    expect(copyPlan(three, 100).map((t) => t.sortOrder)).toEqual([101, 102, 103]);
  });

  it("breaks a sort-order tie by id, so a copy is repeatable", () => {
    const tied = [task({ id: 9, title: "B", sortOrder: 5 }), task({ id: 4, title: "A", sortOrder: 5 })];
    expect(copyPlan(tied, 0).map((t) => t.title)).toEqual(["A", "B"]);
  });

  it("copes with nothing selected", () => {
    expect(copyPlan([], 0)).toEqual([]);
  });
});

describe("saying what happened", () => {
  it("names a few and counts the rest", () => {
    expect(copySummary(["Seals"], "X-011")).toBe('copied "Seals" to X-011');
    expect(copySummary(["A", "B"], "X-011")).toBe('copied "A", "B" to X-011');
    expect(copySummary(["A", "B", "C", "D"], "X-011")).toBe("copied 4 tasks to X-011");
  });
});

describe("which tasks may be copied", () => {
  it("includes finished ones - 'do what we did there' is a normal ask", () => {
    expect(copyable({ title: "Done thing" })).toBe(true);
  });

  it("leaves out one with no title, which has nothing to carry", () => {
    expect(copyable({ title: "   " })).toBe(false);
  });
});
