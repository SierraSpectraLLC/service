import { describe, expect, it } from "vitest";
import {
  leftSystemIn, leftSystemOn, movedFrom, positionAtEndOf, wasInSystemOn, type MoveEvent,
} from "@/lib/moduleMembership";

/**
 * Where a unit stood on a day, read back from its move log. The log records
 * one system per event and names the system LEFT on a move only in text, so
 * these pin the undo rules one event at a time and then a whole life.
 */
const MSP4 = 4, MSP7 = 7;
const fromIdOf = (name: string) => ({ "MSP-004": MSP4, "MSP-007": MSP7 }[name] ?? null);
let seq = 0;
const ev = (kind: string, day: string, instrumentId: number | null, detail = ""): MoveEvent =>
  ({ assetId: 1, kind, instrumentId, detail, day, at: ++seq });

describe("movedFrom", () => {
  it("reads the system left off the text, and the shelf as null", () => {
    expect(movedFrom("MSP-004 -> MSP-007", fromIdOf)).toBe(MSP4);
    expect(movedFrom("spare -> MSP-007", fromIdOf)).toBeNull();
    // A name nobody can resolve - a system since renamed - reads as the shelf,
    // which files the lines under no system rather than the wrong one.
    expect(movedFrom("GONE-1 -> MSP-007", fromIdOf)).toBeNull();
    expect(movedFrom("not a move", fromIdOf)).toBeNull();
  });
});

describe("leftSystemIn", () => {
  it("names the system for a removal, a move away, or a decommission - and nothing else", () => {
    expect(leftSystemIn(ev("removed", "2026-09-08", MSP4, "from MSP-004"), fromIdOf)).toBe(MSP4);
    expect(leftSystemIn(ev("moved", "2026-09-08", MSP7, "MSP-004 -> MSP-007"), fromIdOf)).toBe(MSP4);
    expect(leftSystemIn(ev("status", "2026-09-08", MSP4, "In service -> Decommissioned"), fromIdOf)).toBe(MSP4);
    expect(leftSystemIn(ev("status", "2026-09-08", MSP4, "Spare -> In service"), fromIdOf)).toBeNull();
    expect(leftSystemIn(ev("installed", "2026-09-08", MSP4, "into MSP-004"), fromIdOf)).toBeNull();
    expect(leftSystemIn(ev("note", "2026-09-08", null, "hello"), fromIdOf)).toBeNull();
  });
});

describe("positionAtEndOf", () => {
  // A detector's life: installed into MSP-004 on the 1st, moved to MSP-007
  // on the 8th, pulled to the shelf on the 10th, decommissioned on the 12th.
  const life = [
    ev("installed", "2026-09-01", MSP4, "into MSP-004"),
    ev("status", "2026-09-05", MSP4, "In service -> Needs attention"),
    ev("moved", "2026-09-08", MSP7, "MSP-004 -> MSP-007"),
    ev("removed", "2026-09-10", MSP7, "from MSP-007"),
    ev("status", "2026-09-12", null, "Spare -> Decommissioned"),
  ];
  const current = null;

  it("walks back from now through each kind of event", () => {
    expect(positionAtEndOf("2026-09-12", current, life, fromIdOf)).toBeNull();
    expect(positionAtEndOf("2026-09-11", current, life, fromIdOf)).toBeNull();   // on the shelf
    expect(positionAtEndOf("2026-09-09", current, life, fromIdOf)).toBe(MSP7);
    expect(positionAtEndOf("2026-09-08", current, life, fromIdOf)).toBe(MSP7);   // moved that day: there by its end
    expect(positionAtEndOf("2026-09-07", current, life, fromIdOf)).toBe(MSP4);
    expect(positionAtEndOf("2026-09-05", current, life, fromIdOf)).toBe(MSP4);   // a status stamp says where it was
    expect(positionAtEndOf("2026-09-01", current, life, fromIdOf)).toBe(MSP4);
    expect(positionAtEndOf("2026-08-31", current, life, fromIdOf)).toBeNull();   // before it existed here
  });

  it("starts from where the unit is NOW when nothing has happened since", () => {
    expect(positionAtEndOf("2026-09-20", MSP7, [ev("installed", "2026-09-01", MSP7)], fromIdOf)).toBe(MSP7);
  });

  it("undoes a decommission back onto the system it left", () => {
    const events = [ev("installed", "2026-09-01", MSP4), ev("status", "2026-09-12", MSP4, "In service -> Decommissioned")];
    expect(positionAtEndOf("2026-09-11", null, events, fromIdOf)).toBe(MSP4);
    expect(positionAtEndOf("2026-09-12", null, events, fromIdOf)).toBeNull();
  });

  it("orders two events on one day by time, not by kind", () => {
    const events = [ev("installed", "2026-09-08", MSP4), ev("moved", "2026-09-08", MSP7, "MSP-004 -> MSP-007")];
    expect(positionAtEndOf("2026-09-07", MSP7, events, fromIdOf)).toBeNull();
    expect(positionAtEndOf("2026-09-08", MSP7, events, fromIdOf)).toBe(MSP7);
  });
});

describe("wasInSystemOn", () => {
  const life = [
    ev("installed", "2026-09-01", MSP4, "into MSP-004"),
    ev("moved", "2026-09-08", MSP7, "MSP-004 -> MSP-007"),
  ];
  it("counts the day a unit left: Tuesday's detector is still Tuesday's", () => {
    expect(wasInSystemOn("2026-09-08", MSP4, MSP7, life, fromIdOf)).toBe(true);
    expect(wasInSystemOn("2026-09-08", MSP7, MSP7, life, fromIdOf)).toBe(true);
    expect(wasInSystemOn("2026-09-09", MSP4, MSP7, life, fromIdOf)).toBe(false);
    expect(wasInSystemOn("2026-09-03", MSP4, MSP7, life, fromIdOf)).toBe(true);
    expect(wasInSystemOn("2026-09-03", MSP7, MSP7, life, fromIdOf)).toBe(false);
  });
});

describe("leftSystemOn", () => {
  it("is the last day the unit left the system, and nothing while it is still there", () => {
    const life = [
      ev("installed", "2026-09-01", MSP4), ev("removed", "2026-09-03", MSP4, "from MSP-004"),
      ev("installed", "2026-09-05", MSP4), ev("moved", "2026-09-08", MSP7, "MSP-004 -> MSP-007"),
    ];
    expect(leftSystemOn(MSP4, MSP7, life, fromIdOf)).toBe("2026-09-08");
    expect(leftSystemOn(MSP7, MSP7, life, fromIdOf)).toBeNull();
    expect(leftSystemOn(MSP4, MSP4, life, fromIdOf)).toBeNull();
    expect(leftSystemOn(99, MSP7, life, fromIdOf)).toBeNull();
  });
});
