// What a client is owed in preventive maintenance, and whether they got it.
//
// The feature is one sentence a service manager says out loud - "UCSF gets two
// PMs a year on every mass spec and one on every LC" - and the whole risk is in
// what that sentence means on August 27th. Two a year does NOT mean the client
// is fine until December, and it does not mean they are behind in January. The
// year is cut into stretches and the Nth visit is owed by the end of the Nth
// stretch, so "behind" can be said the day it becomes true.
//
// The other decision worth a test is the unit. A system with three schedules
// generates three PM tasks, and an engineer who closes all three on one visit
// has performed one PM. Counting tasks would have half the fleet reading "done
// for the year" in March, which is a report nobody would trust twice.
import { describe, expect, it } from "vitest";
import {
  coverageLine, coverageRollup, lastDayOfMonth, perYearLabel, planFor, pmCoverage,
  PLAN_MAX_PER_YEAR, slotEnds, type Coverage, type PlanRow,
} from "@/lib/pmPlan";

const plan = (over: Partial<PlanRow> = {}): PlanRow =>
  ({ id: 1, orgId: 7, category: "LC-MS", perYear: 2, note: "", ...over });

describe("which plan governs a system", () => {
  const PLANS = [
    plan({ id: 1, category: "LC-MS", perYear: 2 }),
    plan({ id: 2, category: "GC", perYear: 1 }),
    plan({ id: 3, category: "", perYear: 1, note: "catch-all" }),
  ];

  it("takes the row that names the system's own class", () => {
    expect(planFor(PLANS, "LC-MS")?.id).toBe(1);
    expect(planFor(PLANS, "GC")?.id).toBe(2);
  });

  it("falls back to the catch-all for a class nobody named", () => {
    expect(planFor(PLANS, "N2 generator")?.id).toBe(3);
    // A system with no class at all is "everything else" too.
    expect(planFor(PLANS, "")?.id).toBe(3);
  });

  it("matches a class through case and stray whitespace", () => {
    /*
     * The vocabulary is typed by hand into two different forms - the system
     * form and the plan form - and instruments.category is free text with no
     * fixed list. "lc-ms " against "LC-MS" silently falling through to the
     * catch-all would be a system quietly on the wrong plan, which is the
     * failure nobody notices until a client does.
     */
    expect(planFor(PLANS, " lc-ms ")?.id).toBe(1);
    expect(planFor(PLANS, "Gc")?.id).toBe(2);
  });

  it("has no plan when there is no catch-all either", () => {
    expect(planFor([plan({ category: "LC-MS" })], "GC")).toBeNull();
    expect(planFor([], "LC-MS")).toBeNull();
  });
});

describe("when each of the year's visits is owed", () => {
  it("cuts the year into equal stretches on month ends", () => {
    expect(slotEnds(2026, 1)).toEqual(["2026-12-31"]);
    expect(slotEnds(2026, 2)).toEqual(["2026-06-30", "2026-12-31"]);
    expect(slotEnds(2026, 4)).toEqual(["2026-03-31", "2026-06-30", "2026-09-30", "2026-12-31"]);
    expect(slotEnds(2026, 3)).toEqual(["2026-04-30", "2026-08-31", "2026-12-31"]);
  });

  it("gets February right in a leap year", () => {
    expect(lastDayOfMonth(2028, 2)).toBe("2028-02-29");
    expect(lastDayOfMonth(2026, 2)).toBe("2026-02-28");
    expect(slotEnds(2028, 6)).toEqual([
      "2028-02-29", "2028-04-30", "2028-06-30", "2028-08-31", "2028-10-31", "2028-12-31",
    ]);
  });

  it("falls back to days for a count that does not divide the year", () => {
    // Nobody writes "five a year" into a contract, but somebody will type it.
    const five = slotEnds(2026, 5);
    expect(five).toHaveLength(5);
    expect(five[4]).toBe("2026-12-31");
    // Still monotonic, which is the only property the arithmetic downstream needs.
    expect([...five].sort()).toEqual(five);
  });

  it("has no deadlines at all for a plan of zero or less", () => {
    expect(slotEnds(2026, 0)).toEqual([]);
    expect(slotEnds(2026, -3)).toEqual([]);
  });

  it("refuses to cut the year finer than the cap", () => {
    expect(slotEnds(2026, 5000)).toHaveLength(PLAN_MAX_PER_YEAR);
  });
});

describe("where a system stands", () => {
  const at = (today: string, doneDays: string[], perYear = 2): Coverage =>
    pmCoverage({ plan: plan({ perYear }), doneDays, today });

  it("is on track in January with nothing done", () => {
    // Two a year, first owed by June 30. On January 9th nothing is late, and a
    // page that said "behind" here would be crying wolf all spring.
    const c = at("2026-01-09", []);
    expect(c.state).toBe("on_track");
    expect(c.owedByNow).toBe(0);
    expect(c.nextOwedBy).toBe("2026-06-30");
    expect(coverageLine(c)).toBe("0 of 2 done this year. Next owed by 2026-06-30.");
  });

  it("is behind in August with nothing done", () => {
    const c = at("2026-08-27", []);
    expect(c.state).toBe("behind");
    expect(c.owedByNow).toBe(1);
    expect(c.overdue).toBe(1);
    expect(coverageLine(c)).toBe("0 of 2 done this year - 1 past its day. Next owed by 2026-06-30.");
  });

  it("is on track in August with one done", () => {
    const c = at("2026-08-27", ["2026-05-14"]);
    expect(c.state).toBe("on_track");
    expect(c.done).toBe(1);
    expect(c.nextOwedBy).toBe("2026-12-31");
    expect(c.lastDoneOn).toBe("2026-05-14");
  });

  it("counts a day once, however many schedules closed on it", () => {
    /*
     * The decision this whole file exists to protect. Pump seals, detector lamp
     * and annual service all closed on one visit is ONE PM. Counting the tasks
     * would read as the year's promise already kept, in May, on a system that
     * has been visited once.
     */
    const c = at("2026-08-27", ["2026-05-14", "2026-05-14", "2026-05-14"]);
    expect(c.done).toBe(1);
    expect(c.state).toBe("on_track");
  });

  it("ignores days from another year", () => {
    // Last December's PM was last year's promise. It does not pay for this one.
    const c = at("2026-08-27", ["2025-12-30", "2025-06-02"]);
    expect(c.done).toBe(0);
    expect(c.state).toBe("behind");
    expect(c.lastDoneOn).toBe("");
  });

  it("does not owe a third visit to a client who took two early", () => {
    // Being ahead is not a debt. Two done by February satisfies a two-a-year
    // plan, and the page must not invent a June deadline for a third.
    const c = at("2026-02-20", ["2026-01-08", "2026-02-19"]);
    expect(c.state).toBe("complete");
    expect(c.nextOwedBy).toBe("");
    expect(coverageLine(c)).toBe("2 of 2 done this year, last on 2026-02-19.");
  });

  it("is behind by two when a whole year has gone by unworked", () => {
    const c = at("2026-12-31", [], 2);
    expect(c.overdue).toBe(2);
    expect(coverageLine(c)).toContain("2 past their days");
  });

  it("separates a plan of zero from no plan at all", () => {
    /*
     * "We do not PM those" is a decision somebody made and can defend. "Nobody
     * has said" is a gap in the account. Collapsing them into one grey pill is
     * how the second one never gets filled in.
     */
    const excluded = pmCoverage({ plan: plan({ perYear: 0 }), doneDays: [], today: "2026-08-27" });
    expect(excluded.state).toBe("excluded");
    expect(coverageLine(excluded)).toBe("This class is not on a maintenance plan.");

    const none = pmCoverage({ plan: null, doneDays: [], today: "2026-08-27" });
    expect(none.state).toBe("unplanned");
    expect(coverageLine(none)).toBe("Nobody has said what this system is owed.");
  });

  it("still records what was done on a system nobody planned", () => {
    // The visits happened. Not knowing what was owed is not a reason to forget
    // them - it is the reason somebody should go and write the plan down.
    const c = pmCoverage({ plan: null, doneDays: ["2026-03-01"], today: "2026-08-27" });
    expect(c.done).toBe(1);
    expect(c.lastDoneOn).toBe("2026-03-01");
  });

  it("reads an annual plan as owed on the last day of the year", () => {
    expect(at("2026-08-27", [], 1).state).toBe("on_track");
    expect(at("2026-12-31", [], 1).state).toBe("behind");
  });
});

describe("the client-level roll-up", () => {
  const c = (state: Coverage["state"], perYear: number, done: number): Coverage => ({
    state, perYear, done, owedByNow: 0, overdue: 0, nextOwedBy: "", lastDoneOn: "",
  });

  it("counts only systems that are actually on a plan", () => {
    const r = coverageRollup([
      c("behind", 2, 0),
      c("on_track", 2, 1),
      c("complete", 1, 1),
      c("unplanned", 0, 3),   // its 3 visits are not a promise anybody made
      c("excluded", 0, 0),
    ]);
    expect(r.systems).toBe(5);
    expect(r.planned).toBe(3);
    expect(r.behind).toBe(1);
    expect(r.complete).toBe(1);
    // 2 still owed on the first, 1 on the second, 0 on the third.
    expect(r.owed).toBe(3);
    expect(r.delivered).toBe(2);
  });

  it("never counts a client ahead of their plan as owing negative visits", () => {
    // Three visits against a two-a-year plan is generosity, not credit toward
    // next year. It must not subtract from what the rest of the fleet owes.
    const r = coverageRollup([c("complete", 2, 3), c("behind", 2, 0)]);
    expect(r.owed).toBe(2);
  });
});

describe("how a cadence is said", () => {
  it("uses the words a service manager uses", () => {
    expect(perYearLabel(1)).toBe("once a year");
    expect(perYearLabel(2)).toBe("twice a year");
    expect(perYearLabel(4)).toBe("quarterly");
    expect(perYearLabel(12)).toBe("monthly");
    expect(perYearLabel(3)).toBe("3× a year");
    expect(perYearLabel(0)).toBe("not covered");
  });
});
