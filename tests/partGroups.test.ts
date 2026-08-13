import { describe, expect, it } from "vitest";
import { dayLabel, isFinished, partGroups, serviceDay } from "@/lib/partGroups";

const p = (id: number, status: string, over: Partial<{ installedAt: string; removedAt: string; createdAt: string }> = {}) =>
  ({ id, status, installedAt: "", removedAt: "", ...over });

describe("what is still in flight", () => {
  it("counts everything that has not been fitted or pulled", () => {
    for (const s of ["Needed", "Ordered", "In transit", "Received", "Backordered"]) {
      expect(isFinished(p(1, s))).toBe(false);
    }
    expect(isFinished(p(1, "Installed"))).toBe(true);
    expect(isFinished(p(1, "Removed"))).toBe(true);
  });
});

describe("the day a finished part belongs to", () => {
  it("prefers when it came out over when it went in", () => {
    // A part fitted in March and pulled in September is September's work: that is
    // the visit somebody was standing at the instrument for.
    expect(serviceDay(p(1, "Removed", { installedAt: "2026-03-12", removedAt: "2026-09-04" }))).toBe("2026-09-04");
  });

  it("falls back to when the row was written", () => {
    expect(serviceDay(p(1, "Installed", { createdAt: "2026-03-12T18:22:00.000Z" }))).toBe("2026-03-12");
  });

  it("has no day rather than a wrong one", () => {
    expect(serviceDay(p(1, "Installed"))).toBe("");
    expect(serviceDay(p(1, "Installed", { installedAt: "sometime" }))).toBe("");
  });
});

describe("folding finished work into visits", () => {
  const parts = [
    p(1, "Needed"),
    p(2, "Ordered"),
    p(3, "Installed", { installedAt: "2026-09-04" }),
    p(4, "Installed", { installedAt: "2026-09-04" }),
    p(5, "Removed", { installedAt: "2026-03-12", removedAt: "2026-09-04" }),
    p(6, "Installed", { installedAt: "2026-03-12" }),
  ];

  it("keeps live work out of the fold", () => {
    const g = partGroups(parts);
    expect(g.live.map((r) => r.id)).toEqual([1, 2]);
  });

  it("groups by day, newest visit first", () => {
    const g = partGroups(parts);
    expect(g.visits.map((v) => [v.day, v.parts.map((r) => r.id)]))
      .toEqual([["2026-09-04", [3, 4, 5]], ["2026-03-12", [6]]]);
  });

  it("names a visit after the job that closed that day", () => {
    const g = partGroups(parts, [{ day: "2026-09-04", title: "Annual PM" }]);
    expect(g.visits[0].label).toBe("4 Sep 2026 · Annual PM");
    expect(g.visits[1].label).toBe("12 Mar 2026");
  });

  it("names all of them when several jobs closed together, without repeating one", () => {
    const g = partGroups(parts, [
      { day: "2026-09-04", title: "Annual PM" },
      { day: "2026-09-04", title: "Annual PM" },
      { day: "2026-09-04", title: "Detector swap" },
    ]);
    expect(g.visits[0].label).toBe("4 Sep 2026 · Annual PM · Detector swap");
  });

  it("puts undated rows last, and says so", () => {
    // A gap in data entry, not a date - so it sorts after every real visit
    // instead of pretending to be the oldest or the newest.
    const g = partGroups([p(7, "Installed"), ...parts]);
    const last = g.visits[g.visits.length - 1];
    expect(last.day).toBe("");
    expect(last.label).toBe("No date recorded");
    expect(last.parts.map((r) => r.id)).toEqual([7]);
  });

  it("loses nothing: every row is either live or in exactly one visit", () => {
    const g = partGroups(parts);
    const seen = [...g.live, ...g.visits.flatMap((v) => v.parts)].map((r) => r.id).sort((a, b) => a - b);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("handles an empty panel", () => {
    expect(partGroups([])).toEqual({ live: [], visits: [] });
  });
});

describe("day labels", () => {
  it("reads as a date a person would say", () => {
    expect(dayLabel("2026-09-04")).toBe("4 Sep 2026");
    expect(dayLabel("2026-12-31")).toBe("31 Dec 2026");
  });
});
