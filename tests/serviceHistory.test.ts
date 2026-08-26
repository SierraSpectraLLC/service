import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  dayOf, lastVisitBy, visitsOf, visitsThisYear, type Completion,
} from "@/lib/serviceHistory";

/**
 * "0 visits this year" was not "no visits".
 *
 * It was "no closed work orders" - a fact about which table the work landed
 * in. Maintenance can be recorded three ways in this app and only one was
 * being counted, so a shop that ran a client's annual PM the way the
 * maintenance panel invites you to had it reported as nothing at all: zero
 * visits, zero instruments worked on, and a card with no last-visit date.
 *
 * A visit is now a DAY SOMEBODY COMPLETED WORK ON THE SYSTEM. One sentence,
 * checkable against the record, and it dedupes by construction.
 */

const TODAY = "2026-08-26";

describe("what counts as a visit", () => {
  it("counts a completed PM, not only a closed work order", () => {
    // The reported case. Both of these are somebody finishing work on a
    // machine; only the first was ever counted.
    const v = visitsOf([
      { instrumentId: 1, day: "2026-03-02", planned: false },
      { instrumentId: 1, day: "2026-07-14", planned: true },
    ]);
    expect(v).toHaveLength(2);
  });

  it("counts one day once, however many rows recorded it", () => {
    /* A PM ticked off inside a work order closed the same day is ONE visit.
       Counting rows would report an engineer's single afternoon as three
       trips, which is the mirror of the bug this fixes. */
    const v = visitsOf([
      { instrumentId: 1, day: "2026-07-14", planned: true },
      { instrumentId: 1, day: "2026-07-14", planned: true },
      { instrumentId: 1, day: "2026-07-14", planned: true },
    ]);
    expect(v).toHaveLength(1);
  });

  it("calls a day unplanned when anything unplanned finished on it", () => {
    /* Planned-wins would let a routine PM ticked off during an emergency
       callout report the callout as scheduled maintenance - the more
       expensive error, because it hides that something broke. */
    const v = visitsOf([
      { instrumentId: 1, day: "2026-07-14", planned: true },
      { instrumentId: 1, day: "2026-07-14", planned: false },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].planned).toBe(false);
  });

  it("keeps two systems' same-day work apart", () => {
    const v = visitsOf([
      { instrumentId: 1, day: "2026-07-14", planned: true },
      { instrumentId: 2, day: "2026-07-14", planned: true },
    ]);
    expect(v).toHaveLength(2);
  });

  it("drops a completion with no date rather than dating it today", () => {
    // A row with no timestamp is not a visit that happened now.
    expect(visitsOf([{ instrumentId: 1, day: "", planned: true }])).toEqual([]);
    expect(dayOf(null)).toBe("");
  });

  it("sorts newest first", () => {
    const v = visitsOf([
      { instrumentId: 1, day: "2024-01-01", planned: true },
      { instrumentId: 1, day: "2026-07-14", planned: true },
      { instrumentId: 1, day: "2025-05-05", planned: true },
    ]);
    expect(v.map((x) => x.day)).toEqual(["2026-07-14", "2025-05-05", "2024-01-01"]);
  });
});

describe("this year, and the last one whenever it was", () => {
  const visits = visitsOf([
    { instrumentId: 1, day: "2024-11-08", planned: true },
    { instrumentId: 1, day: "2026-02-20", planned: false },
    { instrumentId: 2, day: "2026-08-01", planned: true },
  ] as Completion[]);

  it("counts only the calendar year, and never the future", () => {
    expect(visitsThisYear(visits, TODAY).map((v) => v.day))
      .toEqual(["2026-08-01", "2026-02-20"]);
    // A visit dated ahead of today is a typo or a booking, not a visit made.
    const ahead = visitsOf([{ instrumentId: 1, day: "2026-12-01", planned: true }]);
    expect(visitsThisYear(ahead, TODAY)).toEqual([]);
  });

  it("still knows the last visit when it was years ago", () => {
    /* The other half of the complaint: a system whose only service was in 2024
       reads "0 visits this year", which is TRUE and useless on its own. The
       card and the record's panel carry the last visit whenever it was. */
    const last = lastVisitBy(visits);
    expect(last.get(1)).toBe("2026-02-20");
    expect(lastVisitBy(visitsOf([{ instrumentId: 9, day: "2019-04-04", planned: true }])).get(9))
      .toBe("2019-04-04");
  });

  it("says nothing for a system nothing has been done to", () => {
    expect(lastVisitBy([]).get(1)).toBeUndefined();
  });
});

describe("the surfaces that were reading only work orders", () => {
  const read = (f: string) => readFileSync(f, "utf8");

  it("feeds the landing's cards and year band from completions", () => {
    const src = read("src/app/(dashboard)/page.tsx");
    expect(src).toMatch(/const completions: Completion\[\]/);
    expect(src).toMatch(/t\.origin !== "pm" && t\.origin !== "pm_request"/);
    expect(src).toMatch(/const visits = visitsOf\(completions\)/);
    expect(src).toMatch(/visitsThisYear\(visits, today\)/);
    // The old rule, which read closed work orders and called them visits.
    expect(src).not.toMatch(/const lastVisitAt = new Map<number, Date>/);
  });

  it("feeds the record's Coverage panel from the same two sources", () => {
    // I built "Last service by" on the narrow source in the commit before
    // this one, so it said "nothing closed on this record yet" about a PM we
    // had just performed.
    const src = read("src/app/instruments/[id]/page.tsx");
    expect(src).toMatch(/t\.origin !== "pm" && t\.origin !== "pm_request"/);
    expect(src).toMatch(/lastClosed\.day/);
  });

  it("stops the instruments band asking a riddle", () => {
    // "0 OF 1" beside a heading reading "Your instruments" - two numbers and
    // nothing saying of what.
    const src = read("src/components/ClientLanding.tsx");
    expect(src).toMatch(/attention\.length > 0/);
    expect(src).toMatch(/need\$\{attention\.length === 1 \? "s" : ""\} attention/);
  });
});
