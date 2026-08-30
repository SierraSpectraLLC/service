import { describe, expect, it } from "vitest";
import {
  ARRIVAL_PHOTO_MIN, RESTORATION_SOURCES, RESTORATION_STAGES, SOURCE_ID_PREFIX,
  STAGE_CONFIRM_KEYS, gateReady, interviewComplete, nextStage, nextStagedId,
  stageGate, stageIndex, type GateSnapshot,
} from "@/lib/restoration";
import { PROVENANCE_QUESTIONS } from "@/lib/restoration";

// A snapshot where everything a gate could ask for is in order.
const allClear = (): GateSnapshot => ({
  components: { total: 4, serialed: 4, graded: 4 },
  arrivalPhotos: ARRIVAL_PHOTO_MIN,
  interviewComplete: true,
  openTasks: 0,
  partsLogged: true,
  outsideDocumented: true,
  verifyVerdictPass: true,
  benchOpenItems: 0,
  wipeDone: true,
  prepOpenItems: 0,
  crateMap: { total: 4, mapped: 4 },
  trackingOnFile: true,
  buyerSet: true,
  onsitePass: true,
  acceptanceSigned: true,
});

const allConfirmed = (stage: string) => new Set(STAGE_CONFIRM_KEYS[stage] ?? []);

describe("the stage order", () => {
  it("walks receive → restore → verify → ship → commission → complete", () => {
    expect(nextStage("receive")).toBe("restore");
    expect(nextStage("restore")).toBe("verify");
    expect(nextStage("verify")).toBe("ship");
    expect(nextStage("ship")).toBe("commission");
    expect(nextStage("commission")).toBe("complete");
  });

  it("has nowhere to go from complete, or from nonsense", () => {
    expect(nextStage("complete")).toBeNull();
    expect(nextStage("intake")).toBeNull();
    expect(stageIndex("not-a-stage")).toBe(-1);
  });
});

describe("stageGate", () => {
  it("passes every stage when everything is in order and confirmed", () => {
    for (const stage of RESTORATION_STAGES.slice(0, -1)) {
      const items = stageGate(stage, allClear(), allConfirmed(stage));
      expect(items.length, stage).toBeGreaterThan(0);
      expect(gateReady(items), `${stage} should pass`).toBe(true);
    }
  });

  it("produces no gate for complete - there is no stage after it", () => {
    expect(stageGate("complete", allClear(), new Set())).toEqual([]);
  });

  it("marks confirm items unchecked until their restoration_confirms row exists", () => {
    const items = stageGate("receive", allClear(), new Set());
    const confirmItems = items.filter((i) => i.kind === "confirm");
    expect(confirmItems.length).toBeGreaterThan(0);
    expect(confirmItems.every((i) => !i.ok)).toBe(true);
    expect(gateReady(items)).toBe(false);
  });

  it("declares exactly the confirm keys STAGE_CONFIRM_KEYS promises, per stage", () => {
    for (const stage of RESTORATION_STAGES) {
      const keys = stageGate(stage, allClear(), new Set())
        .filter((i) => i.kind === "confirm").map((i) => i.key).sort();
      expect(keys, stage).toEqual([...(STAGE_CONFIRM_KEYS[stage] ?? [])].sort());
    }
  });

  it("blocks Receive on an ungraded component, a missing serial, or thin photos", () => {
    const ungraded = stageGate("receive", { ...allClear(), components: { total: 4, serialed: 4, graded: 3 } }, allConfirmed("receive"));
    expect(gateReady(ungraded)).toBe(false);
    const unserialed = stageGate("receive", { ...allClear(), components: { total: 4, serialed: 3, graded: 4 } }, allConfirmed("receive"));
    expect(gateReady(unserialed)).toBe(false);
    const fewPhotos = stageGate("receive", { ...allClear(), arrivalPhotos: ARRIVAL_PHOTO_MIN - 1 }, allConfirmed("receive"));
    expect(gateReady(fewPhotos)).toBe(false);
  });

  it("refuses to receive a project with no components at all", () => {
    const items = stageGate("receive", { ...allClear(), components: { total: 0, serialed: 0, graded: 0 } }, allConfirmed("receive"));
    expect(gateReady(items)).toBe(false);
  });

  it("blocks Restore while a task is open, and says how many", () => {
    const items = stageGate("restore", { ...allClear(), openTasks: 1 }, allConfirmed("restore"));
    const task = items.find((i) => i.key === "tasks_done")!;
    expect(task.ok).toBe(false);
    expect(task.label).toContain("1 restore task still open");
  });

  it("blocks Ship until every serialized component is in exactly one crate and a buyer is set", () => {
    const unmapped = stageGate("ship", { ...allClear(), crateMap: { total: 4, mapped: 3 } }, allConfirmed("ship"));
    expect(gateReady(unmapped)).toBe(false);
    const noBuyer = stageGate("ship", { ...allClear(), buyerSet: false }, allConfirmed("ship"));
    expect(gateReady(noBuyer)).toBe(false);
  });

  it("blocks Commission until the on-site verdict and the buyer's signature are on file", () => {
    const noVerdict = stageGate("commission", { ...allClear(), onsitePass: false }, new Set());
    expect(gateReady(noVerdict)).toBe(false);
    const unsigned = stageGate("commission", { ...allClear(), acceptanceSigned: false }, new Set());
    expect(gateReady(unsigned)).toBe(false);
  });

  it("never lets a system item read as user-checkable", () => {
    for (const stage of RESTORATION_STAGES) {
      for (const item of stageGate(stage, allClear(), new Set())) {
        expect(["system", "confirm"]).toContain(item.kind);
      }
    }
  });
});

describe("nextStagedId", () => {
  it("starts a fresh prefix at 001", () => {
    expect(nextStagedId([], "ACQ")).toBe("ACQ-001");
    expect(nextStagedId(["LZ-001", "T-003"], "ACQ")).toBe("ACQ-001");
  });

  it("continues past the highest, ignoring gaps - a freed number never comes back", () => {
    expect(nextStagedId(["ACQ-001", "ACQ-007", "ACQ-003"], "ACQ")).toBe("ACQ-008");
  });

  it("matches its own prefix case-insensitively and whole, not as a substring", () => {
    expect(nextStagedId(["acq-002"], "ACQ")).toBe("ACQ-003");
    // TRD-9 must not count toward ACQ, and ACQ-EXTRA-5 is not an ACQ number.
    expect(nextStagedId(["TRD-009", "ACQ-EXTRA-005"], "ACQ")).toBe("ACQ-001");
  });

  it("grows past three digits instead of wrapping", () => {
    expect(nextStagedId(["ACQ-999"], "ACQ")).toBe("ACQ-1000");
  });

  it("has a prefix for every source", () => {
    for (const s of RESTORATION_SOURCES) {
      expect(SOURCE_ID_PREFIX[s], s).toMatch(/^[A-Z]+$/);
    }
  });
});

describe("interviewComplete", () => {
  it("accepts 'unknown' as an answer but refuses a skipped question", () => {
    const all = new Map(PROVENANCE_QUESTIONS.map((q) => [q.key, "unknown"]));
    expect(interviewComplete(all)).toBe(true);
    all.set(PROVENANCE_QUESTIONS[0].key, "");
    expect(interviewComplete(all)).toBe(false);
    all.delete(PROVENANCE_QUESTIONS[0].key);
    expect(interviewComplete(all)).toBe(false);
  });
});
