import { describe, expect, it } from "vitest";
import { nextScheduled, pmRequestDue, pmRequestTitle, pmWindow, scheduleLine } from "@/lib/pmRequest";

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
