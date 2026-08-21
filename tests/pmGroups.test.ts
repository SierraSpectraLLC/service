import { describe, expect, it } from "vitest";
import { pmActive, pmAssetGroups, pmFolds, pmGroups, pmMonthLabel } from "@/lib/pmGroups";

const TODAY = "2026-08-12";
const s = (id: number, nextDue: string, over: { paused?: boolean; openTaskId?: number | null } = {}) =>
  ({ id, nextDue, paused: false, openTaskId: null, ...over });

describe("owed now", () => {
  it("counts due and overdue", () => {
    expect(pmActive(s(1, "2026-08-12"), TODAY)).toBe(true);
    expect(pmActive(s(2, "2026-07-01"), TODAY)).toBe(true);
    expect(pmActive(s(3, "2026-08-13"), TODAY)).toBe(false);
  });

  it("counts an open task whatever its date says", () => {
    // Work somebody has started is outstanding even when the calendar says
    // next month - folding it away would hide a job in progress.
    expect(pmActive(s(1, "2026-12-01", { openTaskId: 44 }), TODAY)).toBe(true);
  });

  it("never counts a paused schedule, however overdue", () => {
    expect(pmActive(s(1, "2020-01-01", { paused: true }), TODAY)).toBe(false);
  });
});

describe("folding the rest into months", () => {
  it("keeps what's owed and groups the rest, soonest month first", () => {
    const g = pmGroups([
      s(1, "2026-07-01"),                       // overdue
      s(2, "2026-09-04"),
      s(3, "2026-09-28"),
      s(4, "2027-01-10"),
    ], TODAY);
    expect(g.active.map((r) => r.id)).toEqual([1]);
    expect(g.months.map((m) => [m.label, m.rows.map((r) => r.id)]))
      .toEqual([["September 2026", [2, 3]], ["January 2027", [4]]]);
    expect(g.allClear).toBe(false);
  });

  it("headlines the month and year of the soonest one still to come", () => {
    const g = pmGroups([s(1, "2027-03-02"), s(2, "2026-09-04")], TODAY);
    expect(g.next).toEqual({ key: "2026-09", label: "September 2026" });
  });

  it("reads as all clear once every cycle is complete", () => {
    // The state after the last task of the period is ticked off: nothing owed,
    // one line, and the month it comes back around.
    const g = pmGroups([s(1, "2026-09-04"), s(2, "2026-09-28")], TODAY);
    expect(g.allClear).toBe(true);
    expect(g.active).toEqual([]);
    expect(g.next?.label).toBe("September 2026");
  });

  it("sorts within a month by date then id, so the fold is stable", () => {
    const g = pmGroups([s(9, "2026-09-20"), s(3, "2026-09-04"), s(1, "2026-09-04")], TODAY);
    expect(g.months[0].rows.map((r) => r.id)).toEqual([1, 3, 9]);
  });

  it("puts paused schedules on their own, out of the months", () => {
    const g = pmGroups([s(1, "2026-09-04", { paused: true }), s(2, "2026-10-01")], TODAY);
    expect(g.paused.map((r) => r.id)).toEqual([1]);
    expect(g.months.map((m) => m.label)).toEqual(["October 2026"]);
    expect(g.next?.label).toBe("October 2026");
  });

  it("has no headline when everything left is paused", () => {
    const g = pmGroups([s(1, "2026-09-04", { paused: true })], TODAY);
    expect(g.next).toBeNull();
    expect(g.allClear).toBe(true);
  });

  it("handles an empty list", () => {
    expect(pmGroups([], TODAY)).toEqual({ active: [], months: [], paused: [], next: null, allClear: true });
  });
});

describe("month labels", () => {
  it("names the month from the string, never from a Date", () => {
    // A Date would shift the month across a timezone at midnight on the 1st.
    expect(pmMonthLabel("2026-01-01")).toBe("January 2026");
    expect(pmMonthLabel("2026-12-31")).toBe("December 2026");
  });
});

describe("grouping by asset", () => {
  const a = (id: number, nextDue: string, assetId: number | null, onAsset = "", over = {}) =>
    ({ ...s(id, nextDue, over), assetId, onAsset });

  it("system work first, then each unit in the order it appears", () => {
    const g = pmAssetGroups([
      a(1, "2026-09-01", 7, "Pump — LC-40D"),
      a(2, "2026-09-01", null),
      a(3, "2026-09-01", 9, "Mass spec — 6495C"),
      a(4, "2026-10-01", 7, "Pump — LC-40D"),
    ], TODAY);
    expect(g.map((x) => [x.key, x.label, x.rows.map((r) => r.id)])).toEqual([
      ["sys", "System", [2]],
      ["a7", "Pump — LC-40D", [1, 4]],
      ["a9", "Mass spec — 6495C", [3]],
    ]);
  });

  it("a folded header still answers both questions: how much is owed, and when next", () => {
    const [g] = pmAssetGroups([
      a(1, "2026-07-01", 7, "Pump"),               // overdue
      a(2, "2026-12-01", 7, "Pump"),
      a(3, "2026-09-01", 7, "Pump", { paused: true }), // paused: not owed, not "next"
    ], TODAY);
    expect(g.due).toBe(1);
    expect(g.nextDue).toBe("2026-07-01");
  });

  it("a unit with no label still gets a group, never a blank header", () => {
    const [g] = pmAssetGroups([a(1, "2026-09-01", 7)], TODAY);
    expect(g.label).toBe("Unnamed unit");
  });
});

describe("one fold per month", () => {
  it("chronological: overdue months, the due month, the calendar, then paused", () => {
    const folds = pmFolds([
      s(1, "2026-09-04"),
      s(2, "2026-05-20"),                    // overdue straggler
      s(3, "2026-08-28"),                    // this month, not owed yet
      s(4, "2026-08-03"),                    // this month, overdue within it
      s(5, "2027-01-10", { paused: true }),
    ], TODAY);
    expect(folds.map((f) => [f.key, f.state, f.rows.map((r) => r.id)])).toEqual([
      ["2026-05", "overdue", [2]],
      ["2026-08", "due", [4, 3]],
      ["2026-09", "upcoming", [1]],
      ["paused", "paused", [5]],
    ]);
  });

  it("a folded header still says what is owed inside", () => {
    const [may, aug] = pmFolds([s(1, "2026-05-20"), s(2, "2026-08-03"), s(3, "2026-08-28")], TODAY);
    expect(may.owed).toBe(1);
    expect(aug.owed).toBe(1);      // the 8/28 row is this month but not owed yet
  });

  it("work started early makes its month owed - a fold must not hide a job in flight", () => {
    const [dec] = pmFolds([s(1, "2026-12-01", { openTaskId: 44 })], TODAY);
    expect(dec.state).toBe("upcoming");
    expect(dec.owed).toBe(1);
  });

  it("no paused rows, no paused fold", () => {
    expect(pmFolds([s(1, "2026-09-01")], TODAY).map((f) => f.key)).toEqual(["2026-09"]);
  });
});
