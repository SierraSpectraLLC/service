import { describe, expect, it } from "vitest";
import {
  homeOn, leftAfter, positionAtEndOf, positionAtStartOf, timelineOf, type MoveEvent,
} from "@/lib/moduleMembership";

/**
 * Where a unit stood on a day, read back from its move log. The log records
 * one system per event and names the system LEFT on a move only in text, so
 * the timeline takes it from the unit's own earlier event instead. These pin
 * the reading one event at a time, then a whole life.
 */
const MSP4 = 4, MSP7 = 7;
let seq = 0;
const ev = (kind: string, day: string, instrumentId: number | null, detail = ""): MoveEvent =>
  ({ assetId: 1, kind, instrumentId, detail, day, at: ++seq });

describe("timelineOf", () => {
  it("reads what each event says the unit was before and after it", () => {
    const steps = timelineOf([
      ev("installed", "2026-09-01", MSP4, "into MSP-004"),
      ev("note", "2026-09-02", null, "says nothing"),
      ev("status", "2026-09-05", MSP4, "In service -> Needs attention"),
      ev("moved", "2026-09-08", MSP7, "MSP-004 -> MSP-007"),
      ev("removed", "2026-09-10", MSP7, "from MSP-007"),
      ev("status", "2026-09-12", null, "Spare -> Decommissioned"),
    ]);
    expect(steps.map((s) => [s.day, s.before, s.after])).toEqual([
      ["2026-09-01", null, MSP4],
      ["2026-09-05", MSP4, MSP4],
      ["2026-09-08", MSP4, MSP7],   // the system left comes from the log, not the text
      ["2026-09-10", MSP7, null],
      ["2026-09-12", null, null],
    ]);
  });

  it("takes the system a move left from the log even when the text names a system since renamed", () => {
    const steps = timelineOf([
      ev("installed", "2026-09-01", MSP4, "into MSP-004"),
      ev("moved", "2026-09-08", MSP7, "GONE-1 -> MSP-007"),
    ]);
    expect(steps[1].before).toBe(MSP4);
  });

  it("reads a move with nothing before it as from the shelf, never by name", () => {
    const steps = timelineOf([ev("moved", "2026-09-08", MSP7, "MSP-004 -> MSP-007")]);
    expect(steps[0].before).toBeNull();
  });

  it("orders by time, not by the order the rows arrived", () => {
    const later = ev("moved", "2026-09-08", MSP7, "MSP-004 -> MSP-007");
    const earlier = ev("installed", "2026-09-01", MSP4);
    earlier.at = 1; later.at = 2;
    expect(timelineOf([later, earlier]).map((s) => s.after)).toEqual([MSP4, MSP7]);
  });
});

describe("positionAtEndOf / positionAtStartOf", () => {
  const steps = timelineOf([
    ev("installed", "2026-09-01", MSP4),
    ev("moved", "2026-09-08", MSP7, "MSP-004 -> MSP-007"),
    ev("removed", "2026-09-10", MSP7),
  ]);
  const current = null;

  it("answers for any day in the life", () => {
    expect(positionAtEndOf("2026-08-31", current, steps)).toBeNull();
    expect(positionAtEndOf("2026-09-01", current, steps)).toBe(MSP4);
    expect(positionAtEndOf("2026-09-07", current, steps)).toBe(MSP4);
    expect(positionAtEndOf("2026-09-08", current, steps)).toBe(MSP7);
    expect(positionAtEndOf("2026-09-09", current, steps)).toBe(MSP7);
    expect(positionAtEndOf("2026-09-10", current, steps)).toBeNull();
    expect(positionAtStartOf("2026-09-08", current, steps)).toBe(MSP4);
    expect(positionAtStartOf("2026-09-09", current, steps)).toBe(MSP7);
    expect(positionAtStartOf("2026-09-01", current, steps)).toBeNull();
  });

  it("lets the record answer for now, and for a unit with no log at all", () => {
    expect(positionAtEndOf("2026-09-20", MSP4, steps)).toBe(MSP4);   // moved back by something the log never saw
    expect(positionAtEndOf("2026-09-20", null, [])).toBeNull();
    expect(positionAtEndOf("2026-01-01", MSP7, [])).toBe(MSP7);
  });
});

describe("homeOn - the one rule", () => {
  const steps = timelineOf([
    ev("installed", "2026-09-01", MSP4),
    ev("moved", "2026-09-08", MSP7, "MSP-004 -> MSP-007"),
    ev("removed", "2026-09-10", MSP7),
  ]);

  it("gives a move day's line to the system the unit began the day in - once", () => {
    expect(homeOn("2026-09-08", null, steps)).toBe(MSP4);
    expect(homeOn("2026-09-09", null, steps)).toBe(MSP7);
    expect(homeOn("2026-09-10", null, steps)).toBe(MSP7);   // pulled that day: still that day's
    expect(homeOn("2026-09-11", null, steps)).toBeNull();
  });

  it("gives an install day's line to the system joined, when the day began on the shelf", () => {
    expect(homeOn("2026-09-01", null, steps)).toBe(MSP4);
    expect(homeOn("2026-08-30", null, steps)).toBeNull();
  });
});

describe("leftAfter", () => {
  it("is the day the unit left the system on or after the line's day, and nothing while it is still there", () => {
    const steps = timelineOf([
      ev("installed", "2026-09-01", MSP4), ev("removed", "2026-09-03", MSP4),
      ev("installed", "2026-09-05", MSP4), ev("moved", "2026-09-08", MSP7, "MSP-004 -> MSP-007"),
    ]);
    // Two stints: a line from the first says the first departure, not the last.
    expect(leftAfter("2026-09-02", MSP4, steps)).toBe("2026-09-03");
    expect(leftAfter("2026-09-06", MSP4, steps)).toBe("2026-09-08");
    expect(leftAfter("2026-09-08", MSP4, steps)).toBe("2026-09-08");
    expect(leftAfter("2026-09-09", MSP7, steps)).toBeNull();
    expect(leftAfter("2026-09-06", 99, steps)).toBeNull();
  });
});
