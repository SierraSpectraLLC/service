// When a standing reimbursement is owed.
//
// The owner's sentence: "if I offer one engineer $35/mo internet stipend I
// want that to be automatically reimbursed." An automatic payment is a thing
// worth being careful about in exactly one direction - paying twice - and the
// tests below are mostly about that, plus its opposite: a cron that missed a
// week must not quietly leave somebody out of pocket.
//
// The date arithmetic itself is lib/recurring's and is tested there. What is
// tested here is the walk over it: what has been paid, what is owed, and where
// the walk stops.
import { describe, expect, it } from "vitest";
import {
  checkStipend, dueStipendCycles, nextStipendCycle, perksTitle, previewFirstCycle,
  stipendDescription, stipendLive, type StipendTerms,
} from "@/lib/stipends";

const INTERNET: StipendTerms = {
  amountCents: 3500, everyMonths: 1, dayOfMonth: 1,
  startsOn: "2026-06-01", endsOn: "", active: true, lastOn: "",
};
const at = (over: Partial<StipendTerms>): StipendTerms => ({ ...INTERNET, ...over });

describe("whether an arrangement pays at all", () => {
  it("needs an amount, a cadence and a pulse", () => {
    expect(stipendLive(INTERNET)).toBe(true);
    expect(stipendLive({ ...INTERNET, active: false })).toBe(false);
    // A live arrangement paying nothing every month forever is not something
    // anybody means to create.
    expect(stipendLive({ ...INTERNET, amountCents: 0 })).toBe(false);
    expect(stipendLive({ ...INTERNET, everyMonths: 0 })).toBe(false);
  });

  it("pays nothing while it is paused, and picks up where it left off", () => {
    // Pausing is the normal way one of these stops for a while - somebody on
    // unpaid leave - and the months it was off are not owed retrospectively
    // when it comes back, because lastOn did not move.
    expect(dueStipendCycles(at({ active: false, lastOn: "2026-07-01" }), "2026-09-15")).toEqual([]);
    expect(dueStipendCycles(at({ lastOn: "2026-07-01" }), "2026-09-15"))
      .toEqual(["2026-08-01", "2026-09-01"]);
  });
});

describe("never paying the same month twice", () => {
  it("returns nothing when the cycle is already raised", () => {
    // The guard that lets a cron be trusted with money: a pass that runs twice
    // produces an empty list the second time, by construction rather than luck.
    expect(dueStipendCycles(at({ lastOn: "2026-08-01" }), "2026-08-01")).toEqual([]);
    expect(dueStipendCycles(at({ lastOn: "2026-08-01" }), "2026-08-31")).toEqual([]);
  });

  it("does not re-emit history when one is set up mid-life", () => {
    const paid = at({ startsOn: "2020-01-01", lastOn: "2026-08-01" });
    expect(dueStipendCycles(paid, "2026-08-20")).toEqual([]);
  });
});

describe("catching up", () => {
  it("raises the months a stalled pass missed, oldest first", () => {
    // An engineer should not be out of pocket because a cron job had a bad
    // Tuesday. Oldest first so the rows land in the order they were owed.
    expect(dueStipendCycles(at({ lastOn: "2026-06-01" }), "2026-09-10"))
      .toEqual(["2026-07-01", "2026-08-01", "2026-09-01"]);
  });

  it("is bounded, so a start date typed as 2014 cannot raise a hundred rows", () => {
    /*
     * The cap is the difference between a misconfiguration somebody notices
     * and one that empties an account overnight. The rest arrive on following
     * days, slowly enough to be stopped.
     */
    const ancient = at({ startsOn: "2014-01-01" });
    expect(dueStipendCycles(ancient, "2026-09-10")).toHaveLength(6);
    expect(dueStipendCycles(ancient, "2026-09-10", 2)).toEqual(["2014-01-01", "2014-02-01"]);
  });

  it("pays the month it was set up in, not the month after", () => {
    /*
     * Deliberately unlike a retainer, which opens at the next unstarted cycle
     * so ticking a box cannot raise eight drafts. A stipend typed on the 3rd
     * with "starts this month" means this month - opening at September would
     * silently skip the month the owner was thinking about.
     */
    expect(dueStipendCycles(at({ startsOn: "2026-08-01" }), "2026-08-03")).toEqual(["2026-08-01"]);
  });
});

describe("where the walk stops", () => {
  it("never runs ahead of today", () => {
    // Reimbursing September's internet in August is paying for something
    // nobody has bought yet.
    expect(dueStipendCycles(at({ startsOn: "2026-08-01" }), "2026-08-15")).toEqual(["2026-08-01"]);
  });

  it("stops at the end date", () => {
    expect(dueStipendCycles(at({ lastOn: "2026-06-01", endsOn: "2026-08-01" }), "2026-12-01"))
      .toEqual(["2026-07-01", "2026-08-01"]);
  });

  it("honours a cadence longer than a month", () => {
    // Quarterly comes free from reusing the retainer arithmetic.
    expect(dueStipendCycles(at({ everyMonths: 3, startsOn: "2026-01-15", dayOfMonth: 15 }), "2026-08-01"))
      .toEqual(["2026-01-15", "2026-04-15", "2026-07-15"]);
  });

  it("clamps a 31st to the length of the month", () => {
    // February. Inherited from lib/recurring.cycleDay, asserted here because a
    // stipend that silently skipped February would be found by the engineer.
    const eom = at({ dayOfMonth: 31, startsOn: "2026-01-31", lastOn: "2026-01-31" });
    expect(dueStipendCycles(eom, "2026-03-31")).toEqual(["2026-02-28", "2026-03-31"]);
  });

  it("says nothing on a stipend with no start date", () => {
    expect(dueStipendCycles(at({ startsOn: "" }), "2026-08-01")).toEqual([]);
    expect(dueStipendCycles(at({ startsOn: "not a date" }), "2026-08-01")).toEqual([]);
  });
});

describe("what the roster row shows", () => {
  it("names the next payment the PASS will make, not the next on the calendar", () => {
    /*
     * Up to date: the next cycle, in the future.
     */
    expect(nextStipendCycle(at({ lastOn: "2026-08-01" }), "2026-08-15")).toBe("2026-09-01");
    /*
     * Behind: the OLDEST owed one, because that is the row the next run
     * raises. This arrangement started in June and has never paid, so saying
     * "September" would show an owner a future date for money that is already
     * overdue - and would disagree with dueStipendCycles, which is the thing
     * actually doing the paying.
     */
    expect(dueStipendCycles(at({ lastOn: "" }), "2026-08-15")[0]).toBe("2026-06-01");
    expect(nextStipendCycle(at({ lastOn: "" }), "2026-08-15")).toBe("2026-06-01");
  });

  it("says nothing when there will not be one", () => {
    expect(nextStipendCycle(at({ active: false }), "2026-08-15")).toBe("");
    expect(nextStipendCycle(at({ lastOn: "2026-08-01", endsOn: "2026-08-01" }), "2026-08-15")).toBe("");
  });

  it("previews the first cycle while somebody is still typing the form", () => {
    // A contract signed on the 9th and paid on the 1st pays on the 1st.
    expect(previewFirstCycle("2026-08-09", 1)).toBe("2026-09-01");
    expect(previewFirstCycle("2026-08-01", 1)).toBe("2026-08-01");
    expect(previewFirstCycle("", 1)).toBe("");
  });
});

describe("what the claim reads as", () => {
  it("titles one report per person per month", () => {
    // Named for the MONTH, not the cycle date, because that is how somebody
    // looks for it: "what did we pay Owen in perks in August".
    expect(perksTitle("2026-08-01")).toBe("General perks - August 2026");
    expect(perksTitle("2026-08-31")).toBe("General perks - August 2026");
    expect(perksTitle("")).toBe("General perks");
  });

  it("says what each row is and which month it covers", () => {
    expect(stipendDescription("Internet stipend", "2026-08-01")).toBe("Internet stipend - August 2026");
    expect(stipendDescription("  ", "2026-08-01")).toBe("Stipend - August 2026");
  });
});

describe("what the form will not let through", () => {
  const draft = {
    person: "Owen Brandt", label: "Internet stipend", amountCents: 3500,
    everyMonths: 1, dayOfMonth: 1, startsOn: "2026-08-01", endsOn: "",
  };

  it("accepts a well-formed one", () => {
    expect(checkStipend(draft)).toBeNull();
  });

  it("refuses the ones that would be a standing commitment to nothing", () => {
    expect(checkStipend({ ...draft, person: " " })).toBeTruthy();
    expect(checkStipend({ ...draft, label: "" })).toBeTruthy();
    expect(checkStipend({ ...draft, amountCents: 0 })).toBeTruthy();
    expect(checkStipend({ ...draft, everyMonths: 0 })).toBeTruthy();
    expect(checkStipend({ ...draft, dayOfMonth: 32 })).toBeTruthy();
    expect(checkStipend({ ...draft, startsOn: "" })).toBeTruthy();
    expect(checkStipend({ ...draft, endsOn: "2026-07-01" })).toBeTruthy();
  });
});
