import { describe, expect, it } from "vitest";
import { fmtWhen } from "@/lib/when";

// The point of this helper is that it produces the SAME characters wherever it
// runs. Client components render once on the server and once in the browser, and
// a difference between the two is a hydration error - which is how a page ends
// up looking fine and behaving dead. Two things used to differ: the timezone
// (server UTC vs the bench PC's local time) and the punctuation ICU chooses.

describe("fmtWhen", () => {
  it("formats in shop time, not the machine's time", () => {
    // 2026-08-11T20:38:00Z is 1:38 PM Pacific.
    expect(fmtWhen("2026-08-11T20:38:00Z")).toBe("Aug 11, 1:38 PM");
  });

  it("uses plain ASCII punctuation, never ICU's narrow no-break space", () => {
    const s = fmtWhen("2026-08-11T20:38:00Z");
    expect(s).not.toMatch(/[  ]/);
    expect(s).toContain(" PM");
  });

  it("crosses midnight in shop time, not UTC", () => {
    // 07:00Z on the 12th is still 12:00 AM on the 12th in Pacific... just.
    expect(fmtWhen("2026-08-12T07:00:00Z")).toBe("Aug 12, 12:00 AM");
    // An hour earlier is the previous day at 11 PM.
    expect(fmtWhen("2026-08-12T06:00:00Z")).toBe("Aug 11, 11:00 PM");
  });

  it("is midnight and noon aware", () => {
    expect(fmtWhen("2026-01-01T20:00:00Z")).toBe("Jan 1, 12:00 PM");
  });

  it("honors an explicit timezone", () => {
    expect(fmtWhen("2026-08-11T20:38:00Z", "UTC")).toBe("Aug 11, 8:38 PM");
    expect(fmtWhen("2026-08-11T20:38:00Z", "America/New_York")).toBe("Aug 11, 4:38 PM");
  });

  it("accepts a Date as well as an ISO string", () => {
    expect(fmtWhen(new Date("2026-08-11T20:38:00Z"))).toBe("Aug 11, 1:38 PM");
  });

  it("returns empty for something that isn't a date, rather than 'Invalid Date'", () => {
    expect(fmtWhen("not a date")).toBe("");
  });
});
