import { describe, expect, it } from "vitest";
import { RECENT_DAYS, groupEodHistory, historyDayLabel } from "@/lib/eodHistory";

/**
 * A record carries its own diary: every past day's updates, newest first,
 * each line with its author. Staff read everything, marked; a client reads
 * what their reports carried.
 */
const at = (h: number) => new Date(2026, 8, 1, h);
const row = (over: Partial<Parameters<typeof groupEodHistory>[0][number]> = {}) => ({
  date: "2026-09-08", systemUpdate: "Replaced the seals", actionItem: "", internal: false, skipped: false,
  author: "bill@sierra.com", updatedBy: "Bill Harner", updatedAt: at(9), ...over,
});
const TODAY = "2026-09-11";

describe("groupEodHistory", () => {
  it("is past days only, newest first, lines in the order written", () => {
    const days = groupEodHistory([
      row({ date: "2026-09-11", systemUpdate: "today - not history" }),
      row({ date: "2026-09-08", systemUpdate: "second", updatedAt: at(15), updatedBy: "Joe Harris", author: "joe@sierra.com" }),
      row({ date: "2026-09-08", systemUpdate: "first", updatedAt: at(9) }),
      row({ date: "2026-09-10", systemUpdate: "later day" }),
    ], { today: TODAY, staff: true });
    expect(days.map((d) => d.date)).toEqual(["2026-09-10", "2026-09-08"]);
    expect(days[1].lines.map((l) => `${l.by}: ${l.systemUpdate}`)).toEqual(["Bill Harner: first", "Joe Harris: second"]);
  });

  it("drops a line that says nothing, and a day with nothing left", () => {
    const days = groupEodHistory([
      row({ date: "2026-09-09", systemUpdate: "", actionItem: "" }),
      row({ date: "2026-09-08", systemUpdate: "", actionItem: "Order the pump" }),
    ], { today: TODAY, staff: true });
    expect(days).toHaveLength(1);
    expect(days[0].lines[0].actionItem).toBe("Order the pump");
  });

  it("shows staff the internal and skipped lines, marked", () => {
    const days = groupEodHistory([
      row({ internal: true }), row({ skipped: true, updatedAt: at(10) }),
    ], { today: TODAY, staff: true });
    expect(days[0].lines.map((l) => [l.internal, l.skipped])).toEqual([[true, false], [false, true]]);
  });

  it("shows a client only what their report carried", () => {
    const days = groupEodHistory([
      row({ internal: true, systemUpdate: "bench chatter" }),
      row({ skipped: true, systemUpdate: "left off", updatedAt: at(10) }),
      row({ systemUpdate: "sent to them", updatedAt: at(11) }),
      row({ date: "2026-09-07", internal: true, systemUpdate: "a whole internal day" }),
    ], { today: TODAY, staff: false });
    expect(days).toHaveLength(1);
    expect(days[0].lines.map((l) => l.systemUpdate)).toEqual(["sent to them"]);
  });

  it("keeps enough days to need a second page", () => {
    expect(RECENT_DAYS).toBeGreaterThanOrEqual(14);
  });
});

describe("historyDayLabel", () => {
  it("reads as a day, with the year only when it is not this year's", () => {
    expect(historyDayLabel("2026-09-08", TODAY)).toBe("Tue, Sep 8");
    expect(historyDayLabel("2025-12-31", TODAY)).toMatch(/Dec 31, 2025/);
    expect(historyDayLabel("nonsense", TODAY)).toBe("nonsense");
  });
});
