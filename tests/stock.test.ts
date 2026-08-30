import { describe, expect, it } from "vitest";
import {
  needsReorder, shortBy, reorderLines, stockTotals, canIssue, stockAccess, findLine,
  checkStockItem, findStockLine, stockKey, stockLabel,
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

/*
 * Tools on the shelf.
 *
 * A part is bought by its number and a tool mostly is not - a 4 mm hex key is
 * a 4 mm hex key - so the identity of a shelf line had to stop being "the part
 * number" and start being "the number, or the name when there isn't one". Some
 * tools DO carry an OEM number and want it, which is why the number is
 * optional here rather than absent.
 *
 * The failure these fence off is a shelf counted under two identities: two
 * lines for one wrench that never add up, and a van that can hold exactly one
 * numberless tool because every one of them collides on the empty string.
 */
describe("what identifies a shelf line", () => {
  it("takes the number when there is one", () => {
    expect(stockKey({ partNumber: "228-35145-91", name: "Plunger seal kit" })).toBe("228-35145-91");
  });

  it("falls back to the name when there is not", () => {
    expect(stockKey({ partNumber: "", name: "4 mm hex key" })).toBe("4 mm hex key");
    expect(stockKey({ partNumber: "  ", name: "Torque wrench" })).toBe("torque wrench");
  });

  it("is case-blind, the way the database's index is", () => {
    // The whole point of this function is to be the SAME rule the unique index
    // enforces. If it were looser, it would call two rows one line while the
    // index happily stored both.
    expect(stockKey({ partNumber: "", name: "Torque Wrench" }))
      .toBe(stockKey({ partNumber: "", name: "torque wrench" }));
    expect(stockKey({ partNumber: "AB-1", name: "" })).toBe(stockKey({ partNumber: "ab-1", name: "x" }));
  });

  it("keeps a numbered tool on the line it already had", () => {
    // A tool that later earns an OEM number must not fork into a second line
    // counted separately from the three already in the drawer.
    expect(stockKey({ partNumber: "G1946-80006", name: "CDS alignment tool" }))
      .toBe(stockKey({ partNumber: "g1946-80006", name: "Alignment tool, CDS" }));
  });

  it("has nothing to say about a line with neither", () => {
    expect(stockKey({ partNumber: "", name: "" })).toBe("");
    expect(findStockLine([{ partNumber: "a", name: "b" }], { partNumber: "", name: "" })).toBeUndefined();
  });

  it("finds a tool on a shelf by its name", () => {
    const shelf = [
      { partNumber: "228-35145-91", name: "Plunger seal kit" },
      { partNumber: "", name: "4 mm hex key" },
    ];
    expect(findStockLine(shelf, { partNumber: "", name: "4 MM HEX KEY" })?.name).toBe("4 mm hex key");
    expect(findStockLine(shelf, { partNumber: "228-35145-91", name: "" })?.name).toBe("Plunger seal kit");
  });
});

describe("what to call a line in a sentence", () => {
  it("says the number for a part", () => {
    expect(stockLabel({ partNumber: "5181-3323", name: "Inlet septa" })).toBe("PN 5181-3323");
  });

  it("says the name for a tool, rather than a bare PN with nothing after it", () => {
    // The ledger line this feeds used to read "received 3 × PN " for a tool.
    expect(stockLabel({ partNumber: "", name: "4 mm hex key" })).toBe("4 mm hex key");
    expect(stockLabel({ partNumber: "", name: "" })).toBe("an unnamed line");
  });
});

describe("what may go on a shelf", () => {
  it("refuses a part with no number - it could never be ordered or priced", () => {
    expect(checkStockItem({ kind: "part", partNumber: "", name: "Some seal" })).toBeTruthy();
    expect(checkStockItem({ partNumber: "", name: "Some seal" })).toBeTruthy(); // absent kind = part
  });

  it("takes a tool on its name alone", () => {
    expect(checkStockItem({ kind: "tool", partNumber: "", name: "4 mm hex key" })).toBeNull();
  });

  it("takes a tool that does carry an OEM number", () => {
    // The hybrid the shop asked for: knowing we have three 4 mm keys, AND
    // knowing the number of the alignment tool so another can be ordered.
    expect(checkStockItem({ kind: "tool", partNumber: "G1946-80006", name: "CDS alignment tool" })).toBeNull();
  });

  it("refuses a tool with no name, which is a count of nothing", () => {
    expect(checkStockItem({ kind: "tool", partNumber: "", name: "  " })).toBeTruthy();
  });
});
