import { describe, expect, it } from "vitest";
import { addDays, advance, isDue, cadenceLabel, parseCadence } from "@/lib/pm";

describe("PM date arithmetic", () => {
  it("adds days across month ends", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-08-09", 90)).toBe("2026-11-07");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("handles leap years", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDays("2028-02-29", 365)).toBe("2029-02-28");
  });

  it("due means due-or-overdue - a missed day never un-schedules the work", () => {
    expect(isDue("2026-08-09", "2026-08-09")).toBe(true);
    expect(isDue("2026-08-01", "2026-08-09")).toBe(true);
    expect(isDue("2026-08-10", "2026-08-09")).toBe(false);
  });

  it("advances from the day work was DONE, not the day it was planned", () => {
    // 90-day flush due Aug 1, done Aug 11: next one is Nov 9, not Oct 30.
    expect(advance("2026-08-11", 90)).toBe("2026-11-09");
  });
});

describe("cadence input", () => {
  it("accepts whole days in range", () => {
    expect(parseCadence(90)).toEqual({ days: 90 });
    expect(parseCadence(" 30 ")).toEqual({ days: 30 });
  });

  it("rejects zero, negatives, floats and junk", () => {
    for (const bad of [0, -7, 3.5, "abc", "", 99999]) {
      expect(parseCadence(bad as string | number)).toHaveProperty("error");
    }
  });

  it("names the common cadences", () => {
    expect(cadenceLabel(7)).toBe("weekly");
    expect(cadenceLabel(90)).toBe("quarterly");
    expect(cadenceLabel(45)).toBe("every 45 days");
  });
});
