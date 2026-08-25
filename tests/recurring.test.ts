import { describe, expect, it } from "vitest";
import {
  addDays, addMonths, anticipated, billCadenceLabel, cycleDay, daysInMonth,
  dueCycles, firstCycle, openingCursor, recurring, type RecurringTerms,
} from "@/lib/recurring";

/**
 * The arithmetic a retainer's money depends on.
 *
 * Two failures matter more than the rest and both have their own block below:
 * billing a month twice, and skipping February on a contract dated the 31st.
 * One is an invoice the client disputes; the other is revenue nobody notices
 * missing until the year-end reconcile.
 */

const base: RecurringTerms = {
  billEveryMonths: 1, billAmountCents: 2_000_000, billDescription: "Service retainer",
  billDayOfMonth: 1, billLeadDays: 7, billNextOn: "2026-09-01", billLastOn: "",
  startsOn: "2026-01-01", endsOn: "", status: "active",
};
const on = (p: Partial<RecurringTerms>): RecurringTerms => ({ ...base, ...p });

describe("day arithmetic", () => {
  it("knows how long a month is, leap years included", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
  });

  it("clamps a cycle day to a month that is too short", () => {
    expect(cycleDay(2026, 1, 31)).toBe("2026-01-31");
    expect(cycleDay(2026, 2, 31)).toBe("2026-02-28");
    expect(cycleDay(2028, 2, 31)).toBe("2028-02-29");
    expect(cycleDay(2026, 4, 31)).toBe("2026-04-30");
  });

  it("walks months without drifting off the intended day", () => {
    // The classic bug: Jan 31 -> Feb 28 -> Mar 28. The intended day is carried
    // separately, so March comes back to the 31st.
    expect(addMonths("2026-01-31", 1, 31)).toBe("2026-02-28");
    expect(addMonths("2026-02-28", 1, 31)).toBe("2026-03-31");
    expect(addMonths("2026-12-01", 1, 1)).toBe("2027-01-01");
    expect(addMonths("2026-11-15", 3, 15)).toBe("2027-02-15");
  });

  it("shifts plain days across a month and a year boundary", () => {
    expect(addDays("2026-03-01", -7)).toBe("2026-02-22");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });
});

describe("what counts as recurring", () => {
  it("needs a cadence, an amount and a live contract", () => {
    expect(recurring(on({}))).toBe(true);
    expect(recurring(on({ billEveryMonths: 0 }))).toBe(false);
    expect(recurring(on({ billAmountCents: 0 }))).toBe(false);
    expect(recurring(on({ status: "cancelled" }))).toBe(false);
    expect(recurring(on({ status: "draft" }))).toBe(false);
  });
});

describe("the first cycle", () => {
  it("is the cycle day on or after the start, not the start itself", () => {
    expect(firstCycle("2026-01-09", 1)).toBe("2026-02-01");
    expect(firstCycle("2026-01-01", 1)).toBe("2026-01-01");
    expect(firstCycle("2026-01-09", 15)).toBe("2026-01-15");
  });

  it("opens the cursor ahead of today, never on a year of back-cycles", () => {
    // Turning the box on for a contract that started in January must not
    // raise eight drafts. History is backfilled deliberately.
    expect(openingCursor({ startsOn: "2026-01-01", billDayOfMonth: 1 }, "2026-08-24")).toBe("2026-09-01");
    expect(openingCursor({ startsOn: "2027-01-01", billDayOfMonth: 1 }, "2026-08-24")).toBe("2027-01-01");
  });
});

describe("cycles ready to raise", () => {
  it("raises nothing before the lead time opens", () => {
    expect(dueCycles(on({}), "2026-08-24")).toEqual([]);      // lead opens the 25th
    expect(dueCycles(on({}), "2026-08-25")).toEqual(["2026-09-01"]);
  });

  it("catches up a cron that did not run, oldest first", () => {
    expect(dueCycles(on({ billNextOn: "2026-06-01" }), "2026-08-25"))
      .toEqual(["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"]);
  });

  it("REFUSES a cycle already recorded as raised", () => {
    // The cursor is the guard; this is the second one, for when the cursor is
    // wrong. Billing $20,000 twice is the failure this file exists for.
    expect(dueCycles(on({ billNextOn: "2026-06-01", billLastOn: "2026-07-01" }), "2026-08-25"))
      .toEqual(["2026-08-01", "2026-09-01"]);
  });

  it("stays inside the contract's own window", () => {
    expect(dueCycles(on({ billNextOn: "2026-09-01", endsOn: "2026-08-31" }), "2026-12-01")).toEqual([]);
    expect(dueCycles(on({ billNextOn: "2026-06-01", endsOn: "2026-07-31" }), "2026-12-01"))
      .toEqual(["2026-06-01", "2026-07-01"]);
  });

  it("caps the catch-up rather than raising two hundred drafts at 3am", () => {
    expect(dueCycles(on({ billNextOn: "2020-01-01", startsOn: "2020-01-01" }), "2026-08-25").length).toBe(12);
  });

  it("bills a quarterly contract four times a year, not twelve", () => {
    // Five, not four: on Dec 31 the 7-day lead has already opened January's.
    expect(dueCycles(on({ billEveryMonths: 3, billNextOn: "2026-01-01" }), "2026-12-31"))
      .toEqual(["2026-01-01", "2026-04-01", "2026-07-01", "2026-10-01", "2027-01-01"]);
    expect(dueCycles(on({ billEveryMonths: 3, billNextOn: "2026-01-01" }), "2026-12-01"))
      .toEqual(["2026-01-01", "2026-04-01", "2026-07-01", "2026-10-01"]);
  });

  it("still reaches live cycles when the cursor is stranded years too early", () => {
    // The skip budget and the raise budget are separate: a cursor left in 2019
    // on a contract that starts in 2026 used to walk its whole allowance
    // skipping, and return nothing - indistinguishable from "nothing is due".
    const out = dueCycles(on({ billNextOn: "2019-01-01" }), "2026-08-25");
    // Every cycle from the contract's own start to the one the lead time has
    // opened - January through September - and not one from 2019.
    expect(out.length).toBe(9);
    expect(out[0]).toBe("2026-01-01");
    expect(out.at(-1)).toBe("2026-09-01");
  });

  it("does not skip February on a contract dated the 31st", () => {
    const feb = dueCycles(on({ billDayOfMonth: 31, billNextOn: "2026-01-31" }), "2026-04-30");
    expect(feb).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("says nothing at all for a contract that is not recurring", () => {
    expect(dueCycles(on({ billEveryMonths: 0 }), "2026-12-01")).toEqual([]);
    expect(dueCycles(on({ billNextOn: "" }), "2026-12-01")).toEqual([]);
  });
});

describe("the forecast", () => {
  it("lists what is coming in a window, lead time and all", () => {
    expect(anticipated(on({}), "2026-08-24", "2026-12-31")).toEqual([
      { on: "2026-09-01", amountCents: 2_000_000 },
      { on: "2026-10-01", amountCents: 2_000_000 },
      { on: "2026-11-01", amountCents: 2_000_000 },
      { on: "2026-12-01", amountCents: 2_000_000 },
    ]);
  });

  it("stops at the end of the contract, not the end of the window", () => {
    expect(anticipated(on({ endsOn: "2026-10-31" }), "2026-08-24", "2026-12-31").map((r) => r.on))
      .toEqual(["2026-09-01", "2026-10-01"]);
  });

  it("forecasts nothing for a contract that does not bill itself", () => {
    expect(anticipated(on({ billEveryMonths: 0 }), "2026-08-24", "2026-12-31")).toEqual([]);
  });
});

describe("billCadenceLabel", () => {
  it("names the common cadences and falls back honestly", () => {
    expect(billCadenceLabel(1)).toBe("monthly");
    expect(billCadenceLabel(3)).toBe("quarterly");
    expect(billCadenceLabel(6)).toBe("twice a year");
    expect(billCadenceLabel(12)).toBe("annually");
    expect(billCadenceLabel(4)).toBe("every 4 months");
    expect(billCadenceLabel(0)).toBe("not recurring");
  });
});
