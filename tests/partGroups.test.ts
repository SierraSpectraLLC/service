import { describe, expect, it } from "vitest";
import {
  dayLabel, dayText, isFinished, isoDay, partDates, partGroups, serviceDay, visitLabel,
} from "@/lib/partGroups";

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

  it("looks past a date it cannot read instead of giving up on the row", () => {
    // The bug a customer found: the stamp was written as "Aug 13" - no year, so
    // nothing that can be sorted - and being non-empty it beat a perfectly good
    // creation date, failed the format check, and took the part to "No date
    // recorded". Every part anybody had ever installed was in that bucket.
    expect(serviceDay(p(1, "Installed", { installedAt: "Aug 13", createdAt: "2026-08-13T18:22:00.000Z" })))
      .toBe("2026-08-13");
    expect(serviceDay(p(1, "Removed", {
      removedAt: "Aug 13", installedAt: "2026-03-12", createdAt: "2026-08-13T18:22:00.000Z",
    }))).toBe("2026-03-12");
  });
});

describe("reading a stored date", () => {
  it("recognises a calendar day and nothing else", () => {
    expect(isoDay("2026-08-13")).toBe("2026-08-13");
    expect(isoDay(" 2026-08-13 ")).toBe("2026-08-13");
    expect(isoDay("Aug 13")).toBe("");
    expect(isoDay("")).toBe("");
    expect(isoDay(undefined)).toBe("");
  });

  it("shows a real date properly and an old one as it stands", () => {
    // Blanking what somebody typed, or guessing a year for it, would both be
    // worse than printing the two words that are actually stored.
    expect(dayText("2026-08-13")).toBe("13 Aug 2026");
    expect(dayText("Aug 13")).toBe("Aug 13");
    expect(dayText("")).toBe("");
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

describe("what a save writes for the dates", () => {
  const TODAY = "2026-08-20";
  const blank = { status: "Needed", receivedAt: "", installedAt: "", removedAt: "" };

  it("stamps today when a part first reaches a state", () => {
    expect(partDates(blank, "Installed", {}, TODAY).installedAt).toBe(TODAY);
    expect(partDates(blank, "Removed", {}, TODAY).removedAt).toBe(TODAY);
    expect(partDates(blank, "Received", {}, TODAY).receivedAt).toBe(TODAY);
  });

  it("takes the day somebody typed over today", () => {
    // The whole point: a swap done on a site visit is recorded the following
    // week, and the record should say the week it happened.
    expect(partDates(blank, "Installed", { installedAt: "2026-08-13" }, TODAY).installedAt)
      .toBe("2026-08-13");
  });

  it("lets a date be corrected long after the fact", () => {
    const stored = { status: "Installed", receivedAt: "", installedAt: "Aug 13", removedAt: "" };
    expect(partDates(stored, "Installed", { installedAt: "2026-08-13" }, TODAY).installedAt)
      .toBe("2026-08-13");
  });

  it("leaves a stored date alone when the form sends nothing", () => {
    // An edit to the note or the price must not quietly erase when the work was
    // done - including the old year-less strings, which still say something.
    const stored = { status: "Installed", receivedAt: "", installedAt: "Aug 13", removedAt: "" };
    expect(partDates(stored, "Installed", {}, TODAY).installedAt).toBe("Aug 13");
    expect(partDates(stored, "Installed", { installedAt: "" }, TODAY).installedAt).toBe("Aug 13");
  });

  it("ignores anything that is not a calendar day", () => {
    expect(partDates(blank, "Installed", { installedAt: "last tuesday" }, TODAY).installedAt).toBe(TODAY);
  });

  it("does not re-stamp a state the part was already in", () => {
    const stored = { status: "Installed", receivedAt: "", installedAt: "2026-03-12", removedAt: "" };
    expect(partDates(stored, "Installed", {}, TODAY).installedAt).toBe("2026-03-12");
  });
});

describe("what a visit is called", () => {
  const DAY = "2026-08-12";

  it("is just the date when nothing closed that day", () => {
    expect(visitLabel(DAY, [])).toBe("12 Aug 2026");
  });

  it("names the job when there was one, or two", () => {
    expect(visitLabel(DAY, ["Replace Deuterium Lamp"]))
      .toBe("12 Aug 2026 · Replace Deuterium Lamp");
    expect(visitLabel(DAY, ["Replace Deuterium Lamp", "Replace Tungsten Lamp"]))
      .toBe("12 Aug 2026 · Replace Deuterium Lamp · Replace Tungsten Lamp");
  });

  it("counts the rest instead of listing them", () => {
    // A PM day closes every procedure on the schedule at once. Joining them gave
    // a three-line heading over two rows of parts.
    expect(visitLabel(DAY, [
      "Perform Baseline Flatness Check", "Replace Deuterium Lamp", "Replace Tungsten Lamp",
      "Wavelength Accuracy 486.0nm", "Visual Verification at 550nm", "Baseline Flatness",
      "Wavelength Accuracy 656.10nm",
    ])).toBe("12 Aug 2026 · Perform Baseline Flatness Check · Replace Deuterium Lamp · +5 more");
  });

  it("takes a name somebody gave the day over any list of jobs", () => {
    expect(visitLabel(DAY, ["Replace Deuterium Lamp", "Baseline Flatness"], "Annual PM"))
      .toBe("12 Aug 2026 · Annual PM");
    expect(visitLabel(DAY, [], "  Annual PM  ")).toBe("12 Aug 2026 · Annual PM");
  });

  it("still says so when there is no date at all", () => {
    expect(visitLabel("", [])).toBe("No date recorded");
    expect(visitLabel("", ["Replace Deuterium Lamp"])).toBe("No date recorded");
    // A name is worth more than the apology, even undated.
    expect(visitLabel("", [], "Bench rebuild")).toBe("Bench rebuild");
  });

  it("carries a name through the grouping", () => {
    const parts = [p(1, "Installed", { installedAt: "2026-08-12" })];
    const [visit] = partGroups(parts, [{ day: "2026-08-12", title: "Replace Deuterium Lamp" }],
      { "2026-08-12": "Annual PM" }).visits;
    expect(visit.label).toBe("12 Aug 2026 · Annual PM");
    expect(visit.named).toBe(true);
  });
});
