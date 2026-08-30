import { describe, expect, it } from "vitest";
import {
  assembleEvents, eventsToIcs, monthGrid, monthTitle, promiseTone, shiftMonth, type CalendarInputs,
} from "@/lib/calendar";

/**
 * The calendar is a reader, not a keeper: every assertion here is about
 * faithfully re-presenting dates other features own, and about the two ways
 * a derived calendar can lie - showing what should not be there (a paused
 * schedule, a draft quote, a paid invoice) and hiding what should.
 */

const T = "2026-08-25";
const base: CalendarInputs = { schedules: [], tasks: [], systems: [], quotes: [], invoices: [], agreements: [] };
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

describe("promiseTone", () => {
  it("late is bad, a week out is warn, beyond is calm - boundaries included", () => {
    expect(promiseTone("2026-08-24", T)).toBe("bad");   // yesterday
    expect(promiseTone("2026-08-25", T)).toBe("warn");  // today: not late yet, but loud
    expect(promiseTone("2026-09-01", T)).toBe("warn");  // exactly seven days out
    expect(promiseTone("2026-09-02", T)).toBe("info");  // eight
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

  it("a promised system shows on its day, and goes bad the day after", () => {
    const systems = [
      { id: 7, externalId: "LZ-002", dueOn: "2026-09-01" },
      { id: 8, externalId: "T-003", dueOn: "2026-08-20" },   // behind us
      { id: 9, externalId: "EP-001", dueOn: "" },            // no promise made
    ];
    const ev = assembleEvents({ ...base, systems }, "2026-08-01", "2026-09-30", T);
    expect(ev).toHaveLength(2);
    expect(ev.find((e) => e.label === "LZ-002 promised")).toMatchObject({
      date: "2026-09-01", kind: "due", href: "/instruments/7", tone: "warn",
    });
    // A promise behind us is late, not history.
    expect(ev.find((e) => e.label === "T-003 promised")).toMatchObject({ tone: "bad" });
  });

  it("an unbooked due cycle shows as maintenance, late ones loudest", () => {
    const ev = assembleEvents({ ...base, schedules: [sched({})] }, "2026-08-01", "2026-08-31", T);
    expect(ev[0]).toMatchObject({ kind: "pm", date: "2026-08-20", tone: "bad" });
  });

/*
 * ONE LINE PER MACHINE PER DAY.
 *
 * The thing that made this necessary: a system's schedules are written on the
 * same day at the same cadence, so they fall due together, and a fleet falls
 * due together too. One event per schedule turned a single Tuesday into
 * fourteen rows about one machine - and the title of one of fourteen jobs is
 * not the useful fact. Which machine needs somebody is.
 */
describe("maintenance is counted per machine, not per job", () => {
  it("keeps the job's own title when there is only one", () => {
    // Nothing is gained by hiding it: with one job the title IS the fact.
    const ev = assembleEvents({ ...base, schedules: [sched({})] }, "2026-08-01", "2026-08-31", T);
    expect(ev).toHaveLength(1);
    expect(ev[0].label).toBe("Quarterly source clean @ LZ-001");
  });

  it("collapses a machine's cluster into one line that names the machine", () => {
    const ev = assembleEvents({
      ...base,
      schedules: [
        sched({ id: 1, title: "Quarterly source clean" }),
        sched({ id: 2, title: "Annual PM" }),
        sched({ id: 3, title: "Detector housekeeping" }),
      ],
    }, "2026-08-01", "2026-08-31", T);
    expect(ev).toHaveLength(1);
    expect(ev[0].label).toBe("LZ-001 maintenance due · 3 jobs");
    // Still the machine's own page: the list of the three already lives there.
    expect(ev[0]).toMatchObject({ kind: "pm", date: "2026-08-20", href: "/instruments/1" });
  });

  it("keeps machines apart, and keeps days apart", () => {
    const ev = assembleEvents({
      ...base,
      schedules: [
        sched({ id: 1, instrumentId: 1, systemLabel: "LZ-001" }),
        sched({ id: 2, instrumentId: 1, systemLabel: "LZ-001" }),
        sched({ id: 3, instrumentId: 2, systemLabel: "LZ-002" }),
        sched({ id: 4, instrumentId: 2, systemLabel: "LZ-002" }),
        sched({ id: 5, instrumentId: 2, systemLabel: "LZ-002", nextDue: "2026-08-27" }),
      ],
    }, "2026-08-01", "2026-08-31", T);
    expect(ev.map((e) => e.label).sort()).toEqual([
      "LZ-001 maintenance due · 2 jobs",
      "LZ-002 maintenance due · 2 jobs",
      "Quarterly source clean @ LZ-002",
    ]);
  });

  it("keeps a booking apart from a due cycle on the same machine", () => {
    // Different days and different facts: one is an appointment somebody
    // agreed to, the other is a cycle nobody has answered yet.
    const ev = assembleEvents({
      ...base,
      schedules: [
        sched({ id: 1, bookedOn: "2026-08-28" }),
        sched({ id: 2, bookedOn: "2026-08-28" }),
        sched({ id: 3 }),
      ],
    }, "2026-08-01", "2026-08-31", T);
    expect(ev.map((e) => `${e.kind}:${e.label}`).sort()).toEqual([
      "pm:Quarterly source clean @ LZ-001",
      "visit:LZ-001 booked in · 2 jobs",
    ]);
  });

  it("does not pool one machine's jobs with another machine's", () => {
    /*
     * Keyed on the RECORD rather than on the printed tag. Two workspaces can
     * each have an LZ-001, and a calendar that merged them would say one
     * machine needs four jobs when two machines need two each.
     */
    const ev = assembleEvents({
      ...base,
      schedules: [
        sched({ id: 1, instrumentId: 7, systemLabel: "LZ-001" }),
        sched({ id: 2, instrumentId: 9, systemLabel: "LZ-001" }),
      ],
    }, "2026-08-01", "2026-08-31", T);
    expect(ev).toHaveLength(2);
    expect(ev.map((e) => e.href).sort()).toEqual(["/instruments/7", "/instruments/9"]);
  });

  it("does not pool schedules that hang off no machine at all", () => {
    // A schedule with neither an instrument nor an asset has nothing to be
    // grouped BY; pooling them would invent a machine that does not exist.
    const ev = assembleEvents({
      ...base,
      schedules: [
        sched({ id: 1, instrumentId: null, assetId: null, systemLabel: "", title: "Calibrate the bench meter" }),
        sched({ id: 2, instrumentId: null, assetId: null, systemLabel: "", title: "Service the compressor" }),
      ],
    }, "2026-08-01", "2026-08-31", T);
    expect(ev.map((e) => e.label).sort())
      .toEqual(["Calibrate the bench meter", "Service the compressor"]);
  });

  it("counts a standalone asset as its own machine", () => {
    const ev = assembleEvents({
      ...base,
      schedules: [
        sched({ id: 1, instrumentId: null, assetId: 4, systemLabel: "Pump nXDS15i" }),
        sched({ id: 2, instrumentId: null, assetId: 4, systemLabel: "Pump nXDS15i" }),
      ],
    }, "2026-08-01", "2026-08-31", T);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ href: "/assets/4", label: "Pump nXDS15i maintenance due · 2 jobs" });
  });

  it("still hides a paused schedule, however many it stands beside", () => {
    const ev = assembleEvents({
      ...base,
      schedules: [sched({ id: 1 }), sched({ id: 2, paused: true }), sched({ id: 3, paused: true })],
    }, "2026-08-01", "2026-08-31", T);
    expect(ev).toHaveLength(1);
    expect(ev[0].label).toBe("Quarterly source clean @ LZ-001");
  });
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
