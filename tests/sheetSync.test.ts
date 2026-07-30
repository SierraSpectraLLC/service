import { describe, it, expect } from "vitest";
import { parseCsv, normalizeStages, parseTrackerRows, locateSheetCell, buildSheetRow } from "@/lib/sheetSync";

describe("parseCsv", () => {
  it("splits simple rows", () => {
    expect(parseCsv("a,b,c\nd,e,f")).toEqual([["a", "b", "c"], ["d", "e", "f"]]);
  });
  it("handles quoted fields with commas and escaped quotes", () => {
    expect(parseCsv('a,"b, c",d\n"say ""hi""",e,f')).toEqual([
      ["a", "b, c", "d"],
      ['say "hi"', "e", "f"],
    ]);
  });
  it("handles newlines inside quoted fields and CRLF line endings", () => {
    expect(parseCsv('a,"line1\nline2"\r\nb,c')).toEqual([["a", "line1\nline2"], ["b", "c"]]);
  });
  it("drops blank rows", () => {
    expect(parseCsv("a,b\n,\n\nc,d")).toEqual([["a", "b"], ["c", "d"]]);
  });
});

describe("normalizeStages", () => {
  it("maps sheet aliases onto our vocabulary", () => {
    expect(normalizeStages("Intake, Refurbishment")).toEqual(["Intake", "Refurbishment"]);
  });
  it("handles sign off with and without a hyphen", () => {
    expect(normalizeStages("sign off")).toEqual(["Sign-off"]);
    expect(normalizeStages("Sign-Off")).toEqual(["Sign-off"]);
  });
  it("returns stages in canonical order regardless of input order", () => {
    expect(normalizeStages("shipped, intake")).toEqual(["Intake", "Shipped"]);
  });
  it("ignores unknown values", () => {
    expect(normalizeStages("On the moon")).toEqual([]);
  });
});

const HEADER = ["Priority", "Location", "ID", "Equipment", "System Process", "Notes"];

describe("parseTrackerRows", () => {
  it("maps columns by header name and skips rows without an ID", () => {
    const rows = parseTrackerRows([
      HEADER,
      ["1", "_Testen", "T-003", "Agilent 5977B", "Checkout", "waiting on He"],
      ["", "", "", "", "", ""],
    ]);
    expect(rows).toEqual([
      {
        externalId: "T-003", client: "Testen", model: "Agilent 5977B",
        priority: 1, stages: ["Checkout"], notes: "waiting on He",
      },
    ]);
  });
  it("rounds fractional priorities and defaults missing ones to 99", () => {
    const rows = parseTrackerRows([HEADER, ["2.6", "GMI", "G-001", "LCMS", "", ""], ["", "Utah", "U-001", "GC", "", ""]]);
    expect(rows[0].priority).toBe(3);
    expect(rows[1].priority).toBe(99);
  });
});

describe("buildSheetRow", () => {
  const inst = {
    externalId: "MSP-002", client: "Mississippi Peptides", model: "Waters ACQUITY H-Class + QDa + PDA",
    priority: 4, stages: ["Checkout", "Waiting / blocked"], notes: "QDa detector pending",
  };
  it("lays values out in the sheet's own column order", () => {
    expect(buildSheetRow(HEADER, inst)).toEqual([
      "4", "Mississippi Peptides", "MSP-002", "Waters ACQUITY H-Class + QDa + PDA", "Checkout", "QDa detector pending",
    ]);
  });
  it("omits stages the sheet can't express", () => {
    const row = buildSheetRow(HEADER, inst)!;
    expect(row[4]).toBe("Checkout"); // "Waiting / blocked" is internal-only
  });
  it("handles a reordered header and leaves unknown columns blank", () => {
    const header = ["ID", "Equipment", "Owner", "Priority"];
    expect(buildSheetRow(header, inst)).toEqual(["MSP-002", "Waters ACQUITY H-Class + QDa + PDA", "", "4"]);
  });
  it("returns null without an ID column", () => {
    expect(buildSheetRow(["Priority", "Notes"], inst)).toBeNull();
  });
});

describe("locateSheetCell", () => {
  const rows = [HEADER, ["1", "Testen", "T-003", "5977B", "Checkout", "note"]];
  it("finds the row and column for a diff field", () => {
    expect(locateSheetCell(rows, "T-003", "Notes")).toEqual({ rowIndex: 1, colIndex: 5 });
    expect(locateSheetCell(rows, "T-003", "Priority")).toEqual({ rowIndex: 1, colIndex: 0 });
    expect(locateSheetCell(rows, "T-003", "Stage")).toEqual({ rowIndex: 1, colIndex: 4 });
  });
  it("returns null for unknown systems or fields", () => {
    expect(locateSheetCell(rows, "NOPE-1", "Notes")).toBeNull();
    expect(locateSheetCell(rows, "T-003", "Bogus")).toBeNull();
  });
});
