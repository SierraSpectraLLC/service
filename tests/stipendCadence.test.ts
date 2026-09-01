// Standing reimbursements on a cadence that is not a month.
//
// The ask: "Can we set up a mechanism to log recurring automatic expenses that
// recur on cadences? monthly, weekly, etc. 1st of the month, last, specific
// day."
//
// Two of those four already worked. A monthly arrangement on a day of the
// month was the entire shape of a stipend, and "the last day" turns out to be
// expressible in the shape that existed - cycleDay clamps to the month's own
// length, so day 31 lands on the 30th in April and the 28th in February. It
// had no NAME, which is a different problem and a real one: an owner is not
// going to type 31 hoping it means something else.
//
// Weekly is genuinely new. A month clamps and a week steps, and no amount of
// day-of-month arithmetic produces "every other Friday", so the schedule grew
// a second shape rather than a wider first one.
//
// What is pinned here is that both shapes obey the same three disciplines the
// pass is trusted with money for: never pay twice, catch up, stay bounded.
import { describe, expect, it } from "vitest";
import { alignWeekday, addWeeks, weekdayOf } from "@/lib/recurring";
import {
  LAST_DAY, checkStipend, dueStipendCycles, nextStipendCycle,
  monthlyEquivalentCents, previewFirstCycle, stipendCadenceLabel, stipendDescription,
  stipendLive, type StipendTerms,
} from "@/lib/stipends";

const base: StipendTerms = {
  amountCents: 3500, cadence: "months", everyMonths: 1, dayOfMonth: 1,
  everyWeeks: 1, weekday: 5, startsOn: "2026-01-01", endsOn: "", active: true, lastOn: "",
};
const weekly = (over: Partial<StipendTerms> = {}): StipendTerms =>
  ({ ...base, cadence: "weeks", startsOn: "2026-01-01", ...over });

describe("weekday arithmetic", () => {
  it("counts Sunday as 0, the way getUTCDay does", () => {
    expect(weekdayOf("2026-01-04")).toBe(0);   // a Sunday
    expect(weekdayOf("2026-01-02")).toBe(5);   // a Friday
  });

  it("moves a start date forward to the weekday it pays on", () => {
    // 2026-01-01 is a Thursday. A Friday schedule starts on the 2nd, not on
    // the 1st: the start date says when the arrangement begins, the weekday
    // says when it lands.
    expect(alignWeekday("2026-01-01", 5)).toBe("2026-01-02");
  });

  it("leaves a start date that is already the right weekday alone", () => {
    expect(alignWeekday("2026-01-02", 5)).toBe("2026-01-02");
  });

  it("steps a week without drifting off the weekday", () => {
    let d = "2026-01-02";
    for (let i = 0; i < 60; i++) d = addWeeks(d, 1);
    expect(weekdayOf(d)).toBe(5);
    // Across a DST boundary in every northern timezone, and a leap day.
    expect(d).toBe("2027-02-26");
  });
});

describe("a weekly arrangement", () => {
  it("pays every week on its day", () => {
    expect(dueStipendCycles(weekly(), "2026-01-29", 10))
      .toEqual(["2026-01-02", "2026-01-09", "2026-01-16", "2026-01-23"]);
  });

  it("does every other week without inventing the weeks between", () => {
    expect(dueStipendCycles(weekly({ everyWeeks: 2 }), "2026-02-05", 10))
      .toEqual(["2026-01-02", "2026-01-16", "2026-01-30"]);
  });

  it("never pays a cycle twice", () => {
    /*
     * The invariant a cron is trusted with money for. lastOn is written in the
     * same breath as the expense row, and everything at or before it is money
     * that already went out - so a pass that runs twice, or a catch-up that
     * overlaps a normal run, produces nothing the second time by construction.
     */
    const s = weekly({ lastOn: "2026-01-16" });
    expect(dueStipendCycles(s, "2026-01-29", 10)).toEqual(["2026-01-23"]);
  });

  it("catches up a pass that did not run", () => {
    // Four weeks of a cron having a bad Tuesday. The engineer is not out of
    // pocket for it.
    expect(dueStipendCycles(weekly({ lastOn: "2026-01-02" }), "2026-01-30", 10))
      .toEqual(["2026-01-09", "2026-01-16", "2026-01-23", "2026-01-30"]);
  });

  it("stays bounded, so a start date in 2014 cannot empty an account", () => {
    // Twelve years of weekly cycles is over six hundred rows. The cap is what
    // stands between a typo and an overnight pass paying all of them.
    const many = dueStipendCycles(weekly({ startsOn: "2014-01-01" }), "2026-09-01", 6);
    expect(many).toHaveLength(6);
  });

  it("stops at its end date", () => {
    expect(dueStipendCycles(weekly({ endsOn: "2026-01-16" }), "2026-03-01", 10))
      .toEqual(["2026-01-02", "2026-01-09", "2026-01-16"]);
  });

  it("is not live with a nonsense interval", () => {
    expect(stipendLive(weekly({ everyWeeks: 0 }))).toBe(false);
    expect(stipendLive(weekly({ everyWeeks: 1 }))).toBe(true);
  });

  it("says when it next pays, and says the overdue one when it is behind", () => {
    // Same rule the pass obeys, so the roster and the cron cannot disagree.
    expect(nextStipendCycle(weekly({ lastOn: "2026-01-09" }), "2026-01-29")).toBe("2026-01-16");
    expect(nextStipendCycle(weekly({ lastOn: "2026-01-23" }), "2026-01-26")).toBe("2026-01-30");
  });
});

describe("the last day of the month", () => {
  it("is day 31, and lands on the last day of every month", () => {
    const s: StipendTerms = { ...base, dayOfMonth: LAST_DAY, startsOn: "2026-01-01" };
    expect(dueStipendCycles(s, "2026-05-01", 6))
      .toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("finds February 29 in a leap year", () => {
    const s: StipendTerms = { ...base, dayOfMonth: LAST_DAY, startsOn: "2028-02-01" };
    expect(dueStipendCycles(s, "2028-03-01", 2)).toEqual(["2028-02-29"]);
  });

  it("never skips a short month", () => {
    // The failure this clamping exists to prevent: a schedule on the 31st
    // silently missing February every year, found by the person not paid.
    const s: StipendTerms = { ...base, dayOfMonth: LAST_DAY, startsOn: "2026-02-01" };
    expect(dueStipendCycles(s, "2026-02-28", 2)).toEqual(["2026-02-28"]);
  });
});

describe("months keep behaving exactly as they did", () => {
  it("defaults to months when the column says nothing", () => {
    // Every arrangement that existed before the cadence column. Reading a
    // blank as "weeks" would re-schedule real money on a deploy.
    const legacy = { ...base, cadence: "" };
    expect(dueStipendCycles(legacy, "2026-03-05", 6))
      .toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
  });

  it("does the same for a cadence word nobody defined", () => {
    expect(dueStipendCycles({ ...base, cadence: "fortnightly" }, "2026-02-05", 6))
      .toEqual(["2026-01-01", "2026-02-01"]);
  });

  it("still does quarterly", () => {
    expect(dueStipendCycles({ ...base, everyMonths: 3 }, "2026-08-01", 6))
      .toEqual(["2026-01-01", "2026-04-01", "2026-07-01"]);
  });
});

describe("what the form refuses", () => {
  const draft = {
    person: "Owen Brandt", label: "Weekly parking", amountCents: 1200,
    startsOn: "2026-01-01", endsOn: "",
  };

  it("takes a sane weekly schedule", () => {
    expect(checkStipend({ ...draft, cadence: "weeks", everyMonths: 1, dayOfMonth: 1, everyWeeks: 2, weekday: 5 })).toBeNull();
  });

  it("refuses a weekly interval of nothing", () => {
    expect(checkStipend({ ...draft, cadence: "weeks", everyMonths: 1, dayOfMonth: 1, everyWeeks: 0, weekday: 5 }))
      .toMatch(/1 to 52 weeks/);
  });

  it("refuses a weekday that is not a day", () => {
    expect(checkStipend({ ...draft, cadence: "weeks", everyMonths: 1, dayOfMonth: 1, everyWeeks: 1, weekday: 9 }))
      .toMatch(/day of the week/);
  });

  it("does not judge a weekly schedule by the monthly rules", () => {
    /*
     * The bug a shared validator invites. dayOfMonth is meaningless in the
     * weekly shape and carries whatever the form left in it - so checking it
     * anyway would reject a perfectly good "every Friday" for a field the
     * person was never shown.
     */
    expect(checkStipend({ ...draft, cadence: "weeks", everyMonths: 99, dayOfMonth: 0, everyWeeks: 1, weekday: 5 })).toBeNull();
  });

  it("still judges a monthly schedule by them", () => {
    expect(checkStipend({ ...draft, cadence: "months", everyMonths: 1, dayOfMonth: 0, everyWeeks: 1, weekday: 5 }))
      .toMatch(/day of the month/);
  });
});

describe("what it costs in an average month", () => {
  const per = (o: Partial<StipendTerms>) => monthlyEquivalentCents({ ...base, ...o });

  it("is the amount itself when it pays monthly", () => {
    expect(per({})).toBe(3500);
  });

  it("spreads a quarterly one across its months", () => {
    expect(per({ everyMonths: 3, amountCents: 9000 })).toBe(3000);
  });

  it("does not call a weekly $12 twelve dollars a month", () => {
    /*
     * The line on the roster read "$12 a month across 1 running arrangement"
     * the day weekly schedules shipped. There are 52 weeks in a year and not
     * 48, so every other week is $26 a month - and a running total of standing
     * company commitments that is half the real figure is worse than none.
     */
    expect(per({ cadence: "weeks", everyWeeks: 1, amountCents: 1200 })).toBe(5200);
    expect(per({ cadence: "weeks", everyWeeks: 2, amountCents: 1200 })).toBe(2600);
    expect(per({ cadence: "weeks", everyWeeks: 4, amountCents: 1200 })).toBe(1300);
  });
});

describe("what the row says on the claim", () => {
  it("names a monthly row for its month, as it always did", () => {
    expect(stipendDescription("Internet stipend", "2026-08-01")).toBe("Internet stipend - August 2026");
    expect(stipendDescription("Internet stipend", "2026-08-01", "months")).toBe("Internet stipend - August 2026");
  });

  it("names a weekly row for its date", () => {
    /*
     * Four weekly rows on one month's claim, all called "Weekly parking -
     * January 2026", read as a duplicate to whoever approves it - which is the
     * fastest way to have real money queried or refused. They land on the same
     * monthly claim, correctly; it is the LINES that have to be told apart.
     */
    const weeks = ["2026-01-02", "2026-01-09", "2026-01-16", "2026-01-23"]
      .map((d) => stipendDescription("Weekly parking", d, "weeks"));
    expect(new Set(weeks).size).toBe(4);
    expect(weeks[0]).toBe("Weekly parking - Jan 2, 2026");
  });
});

describe("saying it back to the person setting it up", () => {
  it("previews the date a weekly schedule actually lands on", () => {
    // 2026-01-01 is a Thursday; a Friday schedule first pays on the 2nd.
    expect(previewFirstCycle("2026-01-01", 1, "weeks", 5)).toBe("2026-01-02");
  });

  it("previews the monthly one the way it always did", () => {
    expect(previewFirstCycle("2026-01-15", 1)).toBe("2026-02-01");
  });

  it("reads a schedule back as a sentence", () => {
    const say = (o: Partial<StipendTerms>) => stipendCadenceLabel({ ...base, ...o });
    expect(say({})).toBe("monthly, on the 1st");
    expect(say({ dayOfMonth: LAST_DAY })).toBe("monthly, on the last day");
    expect(say({ dayOfMonth: 15 })).toBe("monthly, on the 15th");
    expect(say({ everyMonths: 3 })).toBe("quarterly, on the 1st");
    expect(say({ cadence: "weeks", everyWeeks: 1, weekday: 5 })).toBe("every Friday");
    expect(say({ cadence: "weeks", everyWeeks: 2, weekday: 5 })).toBe("every other Friday");
    expect(say({ cadence: "weeks", everyWeeks: 3, weekday: 1 })).toBe("every 3 weeks on Monday");
  });

  it("gets the awkward ordinals right", () => {
    const say = (d: number) => stipendCadenceLabel({ ...base, dayOfMonth: d });
    expect(say(2)).toBe("monthly, on the 2nd");
    expect(say(3)).toBe("monthly, on the 3rd");
    expect(say(11)).toBe("monthly, on the 11th");
    expect(say(12)).toBe("monthly, on the 12th");
    expect(say(13)).toBe("monthly, on the 13th");
    expect(say(21)).toBe("monthly, on the 21st");
  });
});
