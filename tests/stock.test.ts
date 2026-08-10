import { describe, expect, it } from "vitest";
import {
  needsReorder, shortBy, reorderLines, stockTotals, canIssue, stockAccess, findLine,
} from "@/lib/stock";

const line = (qty: number, minQty: number) => ({ qty, minQty });

describe("needsReorder / shortBy", () => {
  it("reports short at or below the floor", () => {
    expect(needsReorder(line(2, 4))).toBe(true);
    expect(needsReorder(line(4, 4))).toBe(true);
    expect(needsReorder(line(5, 4))).toBe(false);
  });

  it("never reports short when no floor was set", () => {
    // A shelf of one-off spares would otherwise drown the reorder list.
    expect(needsReorder(line(0, 0))).toBe(false);
    expect(shortBy(line(0, 0))).toBe(0);
  });

  it("asks for at least one when short", () => {
    expect(shortBy(line(1, 4))).toBe(3);
    expect(shortBy(line(4, 4))).toBe(1); // at the floor, not below it
  });
});

describe("reorderLines", () => {
  it("puts the emptiest relative to its own floor first", () => {
    const rows = [
      { partNumber: "half", ...line(2, 4) },   // 50%
      { partNumber: "empty", ...line(0, 2) },  // 0%
      { partNumber: "fine", ...line(9, 4) },   // not short
    ];
    expect(reorderLines(rows).map((r) => r.partNumber)).toEqual(["empty", "half"]);
  });
});

describe("stockTotals", () => {
  it("counts lines, units and shortages separately", () => {
    expect(stockTotals([line(2, 4), line(10, 0), line(0, 1)])).toEqual({ lines: 3, units: 12, short: 2 });
  });
});

describe("canIssue", () => {
  it("allows a draw up to what's on hand", () => {
    expect(canIssue(4, 4).ok).toBe(true);
    expect(canIssue(4, 1).ok).toBe(true);
  });

  it("refuses to go negative rather than corrupting the count", () => {
    const res = canIssue(1, 2);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Only 1 on hand");
  });

  it("rejects nonsense quantities", () => {
    for (const bad of [0, -1, 1.5, NaN]) expect(canIssue(10, bad).ok).toBe(false);
  });
});

describe("stockAccess", () => {
  const houseRoom = { orgId: null };
  const labzen = { orgId: 7 };

  it("gives the house everything", () => {
    expect(stockAccess({ role: "staff", orgId: null }, labzen, undefined))
      .toEqual({ see: true, issue: true, manage: true });
  });

  it("lets an org work its own room, editors only", () => {
    expect(stockAccess({ role: "client_editor", orgId: 7 }, labzen, undefined))
      .toEqual({ see: true, issue: true, manage: true });
    expect(stockAccess({ role: "client_viewer", orgId: 7 }, labzen, undefined))
      .toEqual({ see: true, issue: false, manage: false });
  });

  it("shows another org nothing without a share", () => {
    expect(stockAccess({ role: "client_editor", orgId: 9 }, labzen, undefined).see).toBe(false);
    expect(stockAccess({ role: "client_editor", orgId: null }, houseRoom, undefined).see).toBe(false);
  });

  it("lets a shared org draw only on an issue share, and never manage", () => {
    const provider = { role: "client_editor" as const, orgId: 9 };
    expect(stockAccess(provider, labzen, { access: "view" }))
      .toEqual({ see: true, issue: false, manage: false });
    expect(stockAccess(provider, labzen, { access: "issue" }))
      .toEqual({ see: true, issue: true, manage: false });
    // Drawing stock is a write however generous the share is.
    expect(stockAccess({ role: "client_viewer", orgId: 9 }, labzen, { access: "issue" }).issue).toBe(false);
  });
});

describe("findLine", () => {
  it("matches part numbers the way the price book does", () => {
    const lines = [{ partNumber: "228-35145-91" }, { partNumber: "G6303-80060" }];
    expect(findLine(lines, " g6303-80060")?.partNumber).toBe("G6303-80060");
    expect(findLine(lines, "")).toBeUndefined();
    expect(findLine(lines, "nope")).toBeUndefined();
  });
});
