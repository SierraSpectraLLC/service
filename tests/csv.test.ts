import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "@/lib/csv";

describe("csv parsing (spreadsheet-shaped input)", () => {
  it("handles quotes, embedded commas, newlines and doubled quotes", () => {
    const text = 'name,note\r\n"Pump, spare","said ""ok""\nline two"\r\nplain,also plain\r\n';
    expect(parseCsv(text)).toEqual([
      ["name", "note"],
      ["Pump, spare", 'said "ok"\nline two'],
      ["plain", "also plain"],
    ]);
  });

  it("strips a UTF-8 BOM and trailing blank lines", () => {
    expect(parseCsv("﻿a,b\r\n1,2\r\n\r\n,,\r\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("keeps empty cells positional", () => {
    expect(parseCsv("a,,c\n,,\nx,y,z")).toEqual([["a", "", "c"], ["x", "y", "z"]]);
  });

  it("round-trips through toCsv", () => {
    const rows = [["id", "note"], ["T-1", 'has "quotes", commas\nand newlines'], ["T-2", ""]];
    expect(parseCsv(toCsv(rows))).toEqual([["id", "note"], ["T-1", 'has "quotes", commas\nand newlines'], ["T-2"].concat([""])]);
  });
});
