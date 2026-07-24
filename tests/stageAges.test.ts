import { describe, it, expect } from "vitest";
import { sinceByStage, completedDurations, ageDays, type StageEvent } from "@/lib/stageAges";

const d = (s: string) => new Date(s);
const ev = (instrumentId: number, stage: string, kind: string, at: string): StageEvent =>
  ({ instrumentId, stage, kind, at: d(at) });

describe("sinceByStage", () => {
  it("tracks the add time of currently-active stages", () => {
    const m = sinceByStage([
      ev(1, "Intake", "added", "2026-07-01"),
      ev(1, "Checkout", "added", "2026-07-10"),
    ]);
    expect(m.get(1)?.get("Intake")).toEqual(d("2026-07-01"));
    expect(m.get(1)?.get("Checkout")).toEqual(d("2026-07-10"));
  });
  it("clears removed stages and restarts the clock on re-add", () => {
    const m = sinceByStage([
      ev(1, "Checkout", "added", "2026-07-01"),
      ev(1, "Checkout", "removed", "2026-07-05"),
      ev(1, "Checkout", "added", "2026-07-20"),
    ]);
    expect(m.get(1)?.get("Checkout")).toEqual(d("2026-07-20"));
  });
  it("keeps instruments independent", () => {
    const m = sinceByStage([
      ev(1, "Intake", "added", "2026-07-01"),
      ev(2, "Intake", "added", "2026-07-02"),
      ev(1, "Intake", "removed", "2026-07-03"),
    ]);
    expect(m.get(1)?.has("Intake")).toBe(false);
    expect(m.get(2)?.get("Intake")).toEqual(d("2026-07-02"));
  });
});

describe("completedDurations", () => {
  it("pairs added/removed into durations grouped by stage", () => {
    const out = completedDurations([
      ev(1, "Checkout", "added", "2026-07-01"),
      ev(1, "Checkout", "removed", "2026-07-04"),
      ev(2, "Checkout", "added", "2026-07-02"),
      ev(2, "Checkout", "removed", "2026-07-03"),
    ]);
    expect(out.get("Checkout")).toEqual([3, 1]);
  });
  it("ignores removals with no matching add and still-open stages", () => {
    const out = completedDurations([
      ev(1, "Intake", "removed", "2026-07-01"),
      ev(1, "Checkout", "added", "2026-07-02"),
    ]);
    expect(out.size).toBe(0);
  });
});

describe("ageDays", () => {
  it("floors to whole days and never goes negative", () => {
    expect(ageDays(d("2026-07-01T00:00:00Z"), d("2026-07-03T12:00:00Z"))).toBe(2);
    expect(ageDays(d("2026-07-05"), d("2026-07-01"))).toBe(0);
  });
});
