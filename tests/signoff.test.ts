import { describe, expect, it } from "vitest";
import { signoffGate, snapshotOf, signatureIsStale, type GateTask } from "@/lib/signoff";

// A signature on unfinished work is worse than no signature, so the gate gets
// pinned down in both directions: nothing passes that shouldn't, and nothing
// blocks that shouldn't.

const t = (over: Partial<GateTask> & { id: number }): GateTask => ({
  title: `Task ${over.id}`, state: "Done", required: false, kind: "task", ...over,
});
const reports = (pairs: [number, number][] = []) => new Map(pairs);

describe("the sign-off gate", () => {
  it("passes when everything is done and mandatory tests have reports", () => {
    const g = signoffGate([t({ id: 1 }), t({ id: 2, kind: "test", required: true })], reports([[2, 1]]));
    expect(g.ready).toBe(true);
    expect(g.blockers).toEqual([]);
    expect(g.tasksDone).toBe(2);
  });

  it("blocks on open work, naming a single one and counting many", () => {
    const one = signoffGate([t({ id: 1, state: "Blocked", title: "Leak check" }), t({ id: 2 })], reports());
    expect(one.ready).toBe(false);
    expect(one.blockers[0]).toEqual({ kind: "open_work", text: '"Leak check" is still blocked' });

    const many = signoffGate([t({ id: 1, state: "Open" }), t({ id: 2, state: "In progress" })], reports());
    expect(many.blockers[0].text).toBe("2 tasks are not Done");
  });

  it("blocks a mandatory test that is done but has no report - a checkbox is not evidence", () => {
    const g = signoffGate([t({ id: 1, kind: "test", required: true, title: "Caffeine Checkout" })], reports());
    expect(g.ready).toBe(false);
    expect(g.blockers).toEqual([{ kind: "missing_report", text: '"Caffeine Checkout" has no report on file' }]);
  });

  it("does not chase paperwork for a mandatory test nobody has finished yet", () => {
    const g = signoffGate([t({ id: 1, kind: "test", required: true, state: "Open" })], reports());
    expect(g.blockers.map((b) => b.kind)).toEqual(["open_work"]);
  });

  it("leaves optional tests and mandatory non-test work alone", () => {
    // An optional test needs no report; a mandatory TASK only needs doing.
    const g = signoffGate([
      t({ id: 1, kind: "test", required: false }),
      t({ id: 2, kind: "task", required: true }),
    ], reports());
    expect(g.ready).toBe(true);
  });

  it("an empty record is signable - nothing is outstanding", () => {
    expect(signoffGate([], reports()).ready).toBe(true);
  });
});

describe("staleness", () => {
  it("flags a packet that moved after it was signed, and only then", () => {
    const at = signoffGate([t({ id: 1 })], reports());
    const snap = snapshotOf(at);
    expect(signatureIsStale(snap, at)).toBe(false);
    // A task added afterwards, or one reopened, changes what the packet says.
    expect(signatureIsStale(snap, signoffGate([t({ id: 1 }), t({ id: 2 })], reports()))).toBe(true);
    expect(signatureIsStale(snap, signoffGate([t({ id: 1, state: "Open" })], reports()))).toBe(true);
    expect(signatureIsStale(null, at)).toBe(false);
  });
});
