import { describe, expect, it } from "vitest";
import {
  WEEKDAYS, askLabel, cleanDays, daysLabel, nextScheduled, pmRequestDue, pmRequestTitle, pmWindow,
  scheduleLine,
} from "@/lib/pmRequest";

const s = (title: string, nextDue: string, paused = false) => ({ title, nextDue, paused });

describe("the horizon a client asked for", () => {
  it("reads the three offered windows", () => {
    expect(pmWindow("now").days).toBe(0);
    expect(pmWindow("month").days).toBe(30);
    expect(pmWindow("visit").days).toBe(90);
  });

  it("falls to a month on anything it doesn't recognize", () => {
    // Not "now": a request arriving with a broken form must not read as an
    // emergency, and must not read as a year away either.
    expect(pmWindow("").key).toBe("month");
    expect(pmWindow("urgent!!").key).toBe("month");
  });

  it("dates the work from the horizon, calendar-correct", () => {
    expect(pmRequestDue("2026-08-12", "now")).toBe("2026-08-12");
    expect(pmRequestDue("2026-08-12", "month")).toBe("2026-09-11");
    expect(pmRequestDue("2026-12-15", "visit")).toBe("2027-03-15");
  });
});

describe("what staff read in the task list", () => {
  it("leads with the ask", () => {
    expect(pmRequestTitle("Annual PM before the audit")).toBe("Maintenance requested: Annual PM before the audit");
  });

  it("stands alone when nothing was typed", () => {
    expect(pmRequestTitle("   ")).toBe("Maintenance requested");
  });

  it("takes the first line only, bounded", () => {
    expect(pmRequestTitle("Lamp hours\nand the pump sounds rough")).toBe("Maintenance requested: Lamp hours");
    expect(pmRequestTitle("x".repeat(400)).length).toBe("Maintenance requested: ".length + 120);
  });
});

describe("what the calendar already says", () => {
  it("picks the soonest schedule", () => {
    const next = nextScheduled([s("Yearly PM", "2027-01-04"), s("Filter", "2026-09-01")], "2026-08-12");
    expect(next?.row.title).toBe("Filter");
    expect(next?.overdue).toBe(false);
  });

  it("ignores paused schedules - they are not going to happen on their own", () => {
    const next = nextScheduled([s("Filter", "2026-08-20", true), s("Yearly PM", "2027-01-04")], "2026-08-12");
    expect(next?.row.title).toBe("Yearly PM");
  });

  it("calls due-or-overdue overdue, which is the answer that changes what we do", () => {
    expect(nextScheduled([s("Filter", "2026-08-12")], "2026-08-12")?.overdue).toBe(true);
    expect(nextScheduled([s("Filter", "2026-07-01")], "2026-08-12")?.overdue).toBe(true);
  });

  it("has nothing to say when there is no live schedule", () => {
    expect(nextScheduled([], "2026-08-12")).toBeNull();
    expect(nextScheduled([s("Filter", "2026-09-01", true)], "2026-08-12")).toBeNull();
    expect(scheduleLine([], "2026-08-12")).toBe("");
  });

  it("says it in one line either way", () => {
    expect(scheduleLine([s("Yearly PM", "2026-09-01")], "2026-08-12"))
      .toBe('Next scheduled maintenance: "Yearly PM" on 2026-09-01.');
    expect(scheduleLine([s("Yearly PM", "2026-07-01")], "2026-08-12"))
      .toBe('Scheduled maintenance "Yearly PM" is already due (2026-07-01).');
  });
});

/*
 * The days a client will have somebody on site.
 *
 * A preference, not a booking - "we are covered Mondays and Wednesdays" is a
 * standing fact about how a lab runs, which is both easier for them to answer
 * than a date and more useful to schedule against. What it does to the record
 * is move the due date FORWARD to the first day that suits them, so the work
 * lands on a day somebody can let a van in.
 *
 * Every date below is checked against a real weekday: 2026-09-01 is a Tuesday.
 */
const MON = 1, TUE = 2, WED = 3, THU = 4, FRI = 5;

describe("the days that suit a client", () => {
  it("keeps only days actually offered, sorted, once each", () => {
    // Off the wire, so: a Sunday nobody offered, a duplicate, out of order.
    expect(cleanDays([THU, MON, MON, 0, 6, 99])).toEqual([MON, THU]);
    expect(cleanDays(undefined)).toEqual([]);
    expect(cleanDays([])).toEqual([]);
  });

  it("offers the working week and not the weekend", () => {
    /*
     * Weekend work is an exception a client asks for in words, where the shop
     * can price it and answer. A sixth and seventh chip beside the others
     * would imply it is routine.
     */
    expect(WEEKDAYS.map((d) => d.short)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
  });

  it("says the preference the way a person would", () => {
    expect(daysLabel([MON])).toBe("Mon");
    expect(daysLabel([MON, WED])).toBe("Mon or Wed");
    expect(daysLabel([MON, WED, THU])).toBe("Mon, Wed or Thu");
    // No preference is the ordinary answer and reads as no constraint.
    expect(daysLabel([])).toBe("");
    expect(daysLabel(undefined)).toBe("");
  });
});

describe("dating the work against those days", () => {
  it("leaves the horizon alone when they named none", () => {
    // Which is what every request filed before this existed still gets.
    expect(pmRequestDue("2026-09-01", "month")).toBe("2026-10-01");
    expect(pmRequestDue("2026-09-01", "month", [])).toBe("2026-10-01");
  });

  it("moves forward to the first day that suits them", () => {
    // 2026-10-01 is a Thursday; a lab covered Mon/Wed gets the Monday after.
    expect(pmRequestDue("2026-09-01", "month", [MON, WED])).toBe("2026-10-05");
  });

  it("stays put when the horizon already lands on one of them", () => {
    // Thursday horizon, Thursday offered: nothing to move.
    expect(pmRequestDue("2026-09-01", "month", [THU])).toBe("2026-10-01");
  });

  it("forward and not backward, which would be the past", () => {
    /*
     * "As soon as you can" on a Friday, from a lab covered Mondays, means
     * Monday - not last Monday. The nearest day is the wrong answer here in a
     * way that files work already overdue.
     */
    const friday = "2026-09-04";
    expect(new Date(`${friday}T00:00:00Z`).getUTCDay()).toBe(FRI);
    expect(pmRequestDue(friday, "now", [MON])).toBe("2026-09-07");
  });

  it("never moves more than a week, whatever they picked", () => {
    // The cost of honouring the preference at all, and bounded by the week.
    for (const day of [MON, TUE, WED, THU, FRI]) {
      const due = pmRequestDue("2026-09-01", "now", [day]);
      expect(due >= "2026-09-01").toBe(true);
      expect(due <= "2026-09-07").toBe(true);
    }
  });

  it("crosses a month end without arithmetic trouble", () => {
    // 2026-09-30 is a Wednesday; a Friday lab gets the 2nd of October.
    expect(pmRequestDue("2026-09-30", "now", [FRI])).toBe("2026-10-02");
  });
});

describe("what the record says was asked for", () => {
  it("is the horizon alone when no days were named", () => {
    expect(askLabel("month")).toBe("within a month");
  });

  it("carries both, because the shop schedules against both", () => {
    expect(askLabel("month", [MON, WED, THU])).toBe("within a month, prefers Mon, Wed or Thu");
    expect(askLabel("now", [FRI])).toBe("as soon as you can, prefers Fri");
  });
});
