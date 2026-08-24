import { describe, expect, it } from "vitest";
import { boardAttention, boardTone, type BoardRow } from "@/lib/boardRow";

/**
 * The reported bug: a system sitting in "Waiting / blocked", with a written
 * reason and an open task, wearing the grey dot that means "ours to move".
 *
 * Blocked was simply not one of the things the board looked at. Every other
 * signal was a count of something attached to the system - overdue tasks, open
 * parts, gas, assets, documents - and the stage itself, which is the one field
 * that says outright that nobody is moving this, was never read.
 */
const row = (over: Partial<BoardRow> = {}): BoardRow => ({
  blockedDays: null, overdue: 0, openParts: 0,
  gasIssues: [], assetIssues: [], docIssues: [],
  missingFromSheet: false, down: false, queueMine: true,
  ...over,
});

describe("a blocked system says so", () => {
  it("turns the dot amber, where it used to read as ours to move", () => {
    expect(boardTone(row())).toBe("neutral");
    expect(boardTone(row({ blockedDays: 12 }))).toBe("warn");
  });

  it("says how long, because blocked and blocked 40d are different problems", () => {
    expect(boardAttention(row({ blockedDays: 12 }))).toContain("blocked 12d");
  });

  it("still says blocked when nobody recorded when it started", () => {
    expect(boardAttention(row({ blockedDays: 0 }))).toEqual(["blocked"]);
    expect(boardTone(row({ blockedDays: 0 }))).toBe("warn");
  });

  it("leads the line: it outranks the things there are counts of", () => {
    expect(boardAttention(row({ blockedDays: 3, overdue: 2, openParts: 1 }))[0]).toBe("blocked 3d");
  });
});

describe("the rest of the priority holds", () => {
  it("keeps down above blocked - cannot run beats not moving", () => {
    expect(boardTone(row({ down: true, blockedDays: 12 }))).toBe("bad");
  });

  it("leaves a quiet system alone", () => {
    expect(boardAttention(row())).toEqual([]);
    expect(boardTone(row({ queueMine: false }))).toBe("faint");
  });

  it("did not lose any of the signals it already had", () => {
    const busy = row({
      overdue: 2, openParts: 1, gasIssues: ["N2 low"], assetIssues: ["pump attn"],
      docIssues: ["cal expired"], missingFromSheet: true,
    });
    expect(boardAttention(busy)).toEqual([
      "2 overdue", "1 open part", "N2 low", "pump attn", "cal expired", "not on sheet",
    ]);
    expect(boardTone(busy)).toBe("warn");
  });

  it("counts one part singular and two plural", () => {
    expect(boardAttention(row({ openParts: 1 }))).toEqual(["1 open part"]);
    expect(boardAttention(row({ openParts: 2 }))).toEqual(["2 open parts"]);
  });
});
