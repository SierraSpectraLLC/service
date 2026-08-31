// Notes people write onto the calendar themselves.
//
// The one stored thing on a page that otherwise derives everything, so the
// rules worth pinning are the ones that keep it from swamping what it sits
// beside: a note is drawn on every day it covers, so an unbounded span would
// paint a year of cells over the work underneath.
import { describe, expect, it } from "vitest";
import { NOTE_MAX_DAYS, checkNote, daysBetween, noteDays, noteLabel } from "@/lib/calendarNotes";

const note = (onDate: string, endsOn = "", title = "Site closed") => ({ onDate, endsOn, title });

describe("what a note has to say", () => {
  it("takes a title and a day", () => {
    expect(checkNote({ onDate: "2026-09-14", title: "Site closed" })).toBeNull();
  });

  it("refuses a date with no words on it", () => {
    expect(checkNote({ onDate: "2026-09-14", title: "  " })).toBeTruthy();
  });

  it("refuses something that is not a day", () => {
    expect(checkNote({ onDate: "", title: "x" })).toBeTruthy();
    expect(checkNote({ onDate: "next tuesday", title: "x" })).toBeTruthy();
    expect(checkNote({ onDate: "2026-02-31", title: "x" })).toBeTruthy();
  });

  it("takes a span, and refuses one that ends before it starts", () => {
    expect(checkNote({ onDate: "2026-09-14", endsOn: "2026-09-18", title: "Audit" })).toBeNull();
    expect(checkNote({ onDate: "2026-09-18", endsOn: "2026-09-14", title: "Audit" })).toBeTruthy();
  });

  it("bounds the span, because every day of it gets drawn", () => {
    // A typo'd year would otherwise paint 365 cells over the actual work.
    const ok = { onDate: "2026-01-01", endsOn: "2026-04-01", title: "Long" };
    expect(daysBetween(ok.onDate, ok.endsOn)).toBeGreaterThan(NOTE_MAX_DAYS);
    expect(checkNote(ok)).toContain(String(NOTE_MAX_DAYS));
    expect(checkNote({ onDate: "2026-01-01", endsOn: "2026-02-15", title: "Fine" })).toBeNull();
  });

  it("allows a note about the past", () => {
    /*
     * People write these up after the fact - "the site was shut that week,
     * that is why nobody got in". A calendar that refuses the explanation is a
     * calendar that keeps the mystery.
     */
    expect(checkNote({ onDate: "2019-04-02", title: "Shut for the move" })).toBeNull();
  });
});

describe("which days a note covers", () => {
  it("is one day when nothing said otherwise", () => {
    expect(noteDays(note("2026-09-14"), "2026-09-01", "2026-09-30")).toEqual(["2026-09-14"]);
  });

  it("is every day of a span, ends included", () => {
    expect(noteDays(note("2026-09-14", "2026-09-16"), "2026-09-01", "2026-09-30"))
      .toEqual(["2026-09-14", "2026-09-15", "2026-09-16"]);
  });

  it("clips to the window being drawn", () => {
    // A shutdown starting in August still shows on the September days it
    // reaches - the month grid is what it is being drawn onto.
    expect(noteDays(note("2026-08-28", "2026-09-02"), "2026-09-01", "2026-09-30"))
      .toEqual(["2026-09-01", "2026-09-02"]);
  });

  it("says nothing when the note misses the window entirely", () => {
    expect(noteDays(note("2026-05-01", "2026-05-04"), "2026-09-01", "2026-09-30")).toEqual([]);
  });

  it("ignores an end date that is not after the start", () => {
    expect(noteDays(note("2026-09-14", "2026-09-10"), "2026-09-01", "2026-09-30"))
      .toEqual(["2026-09-14"]);
    expect(noteDays(note("2026-09-14", "nonsense"), "2026-09-01", "2026-09-30"))
      .toEqual(["2026-09-14"]);
  });

  it("crosses a month end without arithmetic trouble", () => {
    expect(noteDays(note("2026-02-27", "2026-03-02"), "2026-01-01", "2026-12-31"))
      .toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
  });
});

describe("what a note says on the day you land on", () => {
  it("is just the title when it is one day", () => {
    expect(noteLabel(note("2026-09-14"), "2026-09-14")).toBe("Site closed");
  });

  it("counts the day out of the span, on every day of it", () => {
    /*
     * The calendar is read a week at a time. Landing on the Wednesday of a
     * shutdown and seeing an unqualified "Site closed" says nothing about
     * whether Thursday is clear.
     */
    const n = note("2026-09-14", "2026-09-18");
    expect(noteLabel(n, "2026-09-14")).toBe("Site closed (1/5)");
    expect(noteLabel(n, "2026-09-16")).toBe("Site closed (3/5)");
    expect(noteLabel(n, "2026-09-18")).toBe("Site closed (5/5)");
  });
});
