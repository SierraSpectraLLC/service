import { describe, expect, it } from "vitest";
import { RECENT_DAYS, groupEodHistory, groupEodHistoryWithModules, historyDayLabel } from "@/lib/eodHistory";

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

describe("groupEodHistoryWithModules", () => {
  const det = (over: Partial<Parameters<typeof groupEodHistory>[0][number]> = {}) =>
    ({ row: row({ systemUpdate: "Source cleaned", updatedAt: at(10), ...over }), assetId: 5, label: "SQ Detector (SN K08)", leftOn: null });

  it("files a unit's lines under the day, under the unit, after the system's own", () => {
    const days = groupEodHistoryWithModules(
      [row({ systemUpdate: "Whole system: caffeine checkout" })],
      [det(), det({ systemUpdate: "Cone replaced", updatedAt: at(14), updatedBy: "Joe Harris", author: "joe@sierra.com" })],
      { today: TODAY, staff: true },
    );
    expect(days).toHaveLength(1);
    expect(days[0].lines.map((l) => l.systemUpdate)).toEqual(["Whole system: caffeine checkout"]);
    expect(days[0].modules).toHaveLength(1);
    expect(days[0].modules[0].label).toBe("SQ Detector (SN K08)");
    expect(days[0].modules[0].lines.map((l) => `${l.by}: ${l.systemUpdate}`))
      .toEqual(["Bill Harner: Source cleaned", "Joe Harris: Cone replaced"]);
  });

  it("makes a day out of a unit's line alone, and says when the unit left", () => {
    const days = groupEodHistoryWithModules([], [{ ...det(), leftOn: "2026-09-09" }], { today: TODAY, staff: true });
    expect(days.map((d) => d.date)).toEqual(["2026-09-08"]);
    expect(days[0].lines).toEqual([]);
    expect(days[0].modules[0].leftOn).toBe("2026-09-09");
  });

  it("keeps the client's reading for a unit's lines too", () => {
    const days = groupEodHistoryWithModules([], [
      det({ internal: true }), det({ skipped: true, updatedAt: at(11) }), det({ systemUpdate: "sent", updatedAt: at(12) }),
    ], { today: TODAY, staff: false });
    expect(days[0].modules[0].lines.map((l) => l.systemUpdate)).toEqual(["sent"]);
  });

  it("orders units by name within a day, and days newest first", () => {
    const days = groupEodHistoryWithModules([], [
      { ...det({ date: "2026-09-07" }), assetId: 9, label: "Pump" },
      { ...det({ date: "2026-09-07" }), assetId: 5, label: "Detector" },
      det({ date: "2026-09-09" }),
    ], { today: TODAY, staff: true });
    expect(days.map((d) => d.date)).toEqual(["2026-09-09", "2026-09-07"]);
    expect(days[1].modules.map((m) => m.label)).toEqual(["Detector", "Pump"]);
  });

  it("is what groupEodHistory reads as, with no units", () => {
    const rows = [row()];
    expect(groupEodHistory(rows, { today: TODAY, staff: true }))
      .toEqual(groupEodHistoryWithModules(rows, [], { today: TODAY, staff: true }));
    expect(groupEodHistory(rows, { today: TODAY, staff: true })[0].modules).toEqual([]);
  });
});
