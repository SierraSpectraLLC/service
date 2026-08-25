import { describe, expect, it } from "vitest";
import {
  assembleEvents, eventsToIcs, monthGrid, monthTitle, shiftMonth, type CalendarInputs,
} from "@/lib/calendar";

/**
 * The calendar is a reader, not a keeper: every assertion here is about
 * faithfully re-presenting dates other features own, and about the two ways
 * a derived calendar can lie - showing what should not be there (a paused
 * schedule, a draft quote, a paid invoice) and hiding what should.
 */

const T = "2026-08-25";
const base: CalendarInputs = { schedules: [], tasks: [], quotes: [], invoices: [], agreements: [] };
const sched = (p: Partial<CalendarInputs["schedules"][number]>) => ({
  id: 1, title: "Quarterly source clean", paused: false, nextDue: "2026-08-20",
  bookedOn: "", instrumentId: 1, assetId: null, systemLabel: "LZ-001", ...p,
});

describe("the month grid", () => {
  it("starts on Sunday and covers the whole month", () => {
    const { weeks, days } = monthGrid("2026-08");
    expect(weeks[0][0]).toBe("2026-07-26");           // Aug 1 2026 is a Saturday
    expect(days).toContain("2026-08-01");
    expect(days).toContain("2026-08-31");
    expect(weeks.every((w) => w.length === 7)).toBe(true);
  });

  it("walks months across a year boundary", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(monthTitle("2026-08")).toBe("August 2026");
  });
});

describe("what makes the calendar", () => {
  it("a booked visit shows AS the visit, and swallows its due-date nag", () => {
    const ev = assembleEvents({ ...base, schedules: [sched({ bookedOn: "2026-09-06" })] },
      "2026-08-01", "2026-09-30", T);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ date: "2026-09-06", kind: "visit", tone: "info" });
    expect(ev[0].label).toContain("LZ-001");
  });

  it("an unbooked due cycle shows as maintenance, late ones loudest", () => {
    const ev = assembleEvents({ ...base, schedules: [sched({})] }, "2026-08-01", "2026-08-31", T);
    expect(ev[0]).toMatchObject({ kind: "pm", date: "2026-08-20", tone: "bad" });
  });

  it("paused schedules, draft quotes and paid invoices are nobody's plans", () => {
    const ev = assembleEvents({
      ...base,
      schedules: [sched({ paused: true })],
      quotes: [{ id: 1, number: "Q-1", title: "", status: "draft", expiresOn: "2026-08-28" }],
      invoices: [{ id: 1, number: "INV-1", status: "paid", dueOn: "2026-08-28", orgName: "Lab Zen" }],
    }, "2026-08-01", "2026-08-31", T);
    expect(ev).toHaveLength(0);
  });

  it("money shows: the open invoice's due day and the sent quote's last good day", () => {
    const ev = assembleEvents({
      ...base,
      quotes: [{ id: 2, number: "Q-2", title: "", status: "sent", expiresOn: "2026-08-30" }],
      invoices: [{ id: 2, number: "INV-2", status: "sent", dueOn: "2026-08-10", orgName: "Coastal" }],
    }, "2026-08-01", "2026-08-31", T);
    expect(ev.map((e) => [e.kind, e.tone])).toEqual([["invoice", "bad"], ["quote", "warn"]]);
  });

  it("a retainer's cycles land from its own schedule, contract end beside them", () => {
    const ev = assembleEvents({
      ...base,
      agreements: [{
        id: 3, number: "AGR-9", title: "", orgId: 1, orgName: "Coastal", status: "active",
        startsOn: "2026-01-01", endsOn: "2026-10-15",
        billEveryMonths: 1, billAmountCents: 2_000_000, billDescription: "",
        billDayOfMonth: 1, billLeadDays: 7, billNextOn: "2026-09-01", billLastOn: "",
      }],
    }, "2026-08-25", "2026-10-31", T);
    expect(ev.map((e) => [e.date, e.kind])).toEqual([
      ["2026-09-01", "retainer"], ["2026-10-01", "retainer"], ["2026-10-15", "renewal"],
    ]);
  });

  it("dated open tasks show; range is respected", () => {
    const ev = assembleEvents({
      ...base,
      tasks: [
        { id: 1, title: "Swap frit", dueDate: "2026-08-27", instrumentId: 2, assignee: "joe" },
        { id: 2, title: "Out of range", dueDate: "2026-10-01", instrumentId: 2, assignee: "" },
      ],
    }, "2026-08-01", "2026-08-31", T);
    expect(ev).toHaveLength(1);
    expect(ev[0].label).toBe("Swap frit - joe");
  });
});

describe("the feed", () => {
  it("emits all-day VEVENTs with stable UIDs and escaped text", () => {
    const ics = eventsToIcs([
      { date: "2026-09-06", kind: "visit", label: "PM, Smith; lab", href: "/instruments/1", tone: "info" },
    ], "Sierra Spectra", "https://x.test");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("DTSTART;VALUE=DATE:20260906");
    expect(ics).toContain("URL:https://x.test/instruments/1");
    expect(ics).toContain("X-WR-CALNAME:Sierra Spectra");
    // twice-fetched feed must not duplicate: same UID both times
    const uid = ics.match(/UID:[^\r\n]+/)?.[0];
    expect(uid).toBeTruthy();
    expect(eventsToIcs([
      { date: "2026-09-06", kind: "visit", label: "PM, Smith; lab", href: "/instruments/1", tone: "info" },
    ], "Sierra Spectra", "https://x.test")).toContain(uid!);
  });
});
