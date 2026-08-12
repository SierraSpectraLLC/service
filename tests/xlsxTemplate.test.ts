import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { fillWorkbook, substitute, templateTokens, tokensIn } from "@/lib/xlsxTemplate";

/**
 * The service report is an Excel workbook somebody else designed, and the whole
 * point of filling it rather than redrawing it is that the design survives. So
 * these tests care about two things: that values land in the right cells, and
 * that the formatting around them is exactly what the template said - including
 * on rows that did not exist until the fill created them.
 */

/** A workbook shaped like the real one: header fields, then a table that grows. */
async function template(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet("Report");
  s.getCell("A1").value = "REPORT #";
  s.getCell("B1").value = "{{reportNumber}}";
  s.getCell("A2").value = "Instrument";
  s.getCell("B2").value = "{{instrumentType}} · SN {{serial}}";
  s.getCell("A3").value = "Visit";
  s.getCell("B3").value = "{{visitDate}}";

  s.getCell("A5").value = "Description";
  s.getCell("B5").value = "Part Num.";
  s.getCell("C5").value = "Qty";
  s.getCell("D5").value = "Unit";
  for (const c of ["A5", "B5", "C5", "D5"]) {
    s.getCell(c).font = { bold: true };
    s.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
  }

  // The model row, styled the way every parts row should be.
  s.getCell("A6").value = "{{parts.description}}";
  s.getCell("B6").value = "{{parts.partNumber}}";
  s.getCell("C6").value = "{{parts.quantity}}";
  s.getCell("D6").value = "{{parts.unit}}";
  s.getRow(6).height = 22;
  for (const c of ["A6", "B6", "C6", "D6"]) {
    s.getCell(c).border = { bottom: { style: "thin", color: { argb: "FFB7B7B7" } } };
  }
  s.getCell("D6").numFmt = '"$"#,##0.00';

  s.getCell("A8").value = "Total";
  s.getCell("D8").value = { formula: "SUM(D6:D6)" };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function open(bytes: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  return wb.getWorksheet("Report")!;
}

const parts = [
  { description: "D2 Deuterium Lamp", partNumber: "062-65055-05", quantity: 1, unit: 600 },
  { description: "W1 Tungsten/Halogen Bulb", partNumber: "062-65005-00", quantity: 1, unit: 200 },
  { description: "PM Charge", partNumber: "SVC. UVPM", quantity: 1, unit: 2400 },
];

const data = {
  values: {
    reportNumber: "030181_SR2",
    instrumentType: "Shimadzu UV-1900 UV-Vis",
    serial: "A12425650267",
    visitDate: "Monday, August 25, 2025",
  },
  rows: { parts },
};

describe("finding what the template asks for", () => {
  it("reads tokens out of a cell, including two in one string", () => {
    expect(tokensIn("{{instrumentType}} · SN {{serial}}")).toEqual(["instrumentType", "serial"]);
  });

  it("separates flat fields from repeating blocks", () => {
    const t = templateTokens("{{reportNumber}} {{parts.description}} {{labor.total}}");
    expect(t.flat).toEqual(["reportNumber"]);
    expect(t.list).toEqual(["labor", "parts"]);
  });

  it("keeps a value's type when the cell holds nothing else", () => {
    // So a price stays a number and the template's currency format applies to it.
    expect(substitute("{{unit}}", () => 600).value).toBe(600);
    // Mixed with text it has to become text, and that is fine.
    expect(substitute("SN {{serial}}", () => 12345).value).toBe("SN 12345");
  });

  it("leaves an unknown token visible rather than blanking the cell", () => {
    const r = substitute("{{nope}}", () => undefined);
    expect(r.value).toBe("{{nope}}");
    expect(r.missing).toEqual(["nope"]);
  });
});

describe("filling the workbook", () => {
  it("writes the header fields where the tokens were", async () => {
    const { bytes } = await fillWorkbook(await template(), data);
    const s = await open(bytes);
    expect(s.getCell("B1").value).toBe("030181_SR2");
    expect(s.getCell("B2").value).toBe("Shimadzu UV-1900 UV-Vis · SN A12425650267");
    expect(s.getCell("B3").value).toBe("Monday, August 25, 2025");
  });

  it("grows the table to the number of line items", async () => {
    const { bytes, report } = await fillWorkbook(await template(), data);
    const s = await open(bytes);
    expect(report.rowsAdded).toBe(2);
    expect(s.getCell("A6").value).toBe("D2 Deuterium Lamp");
    expect(s.getCell("A7").value).toBe("W1 Tungsten/Halogen Bulb");
    expect(s.getCell("A8").value).toBe("PM Charge");
    expect(s.getCell("C8").value).toBe(1);
  });

  it("carries the model row's formatting onto rows it created", async () => {
    // This is the whole reason for filling her workbook rather than redrawing it:
    // row three of a parts table has to look like row one, down to the border and
    // the currency format, without anybody restating them in code.
    const { bytes } = await fillWorkbook(await template(), data);
    const s = await open(bytes);
    expect(s.getCell("D8").numFmt).toBe('"$"#,##0.00');
    expect(s.getCell("A8").border?.bottom?.style).toBe("thin");
    expect(s.getRow(8).height).toBe(22);
    // And a price is still a number, so Excel formats and sums it.
    expect(s.getCell("D8").value).toBe(2400);
  });

  it("moves the formula under a table down as the table grows", async () => {
    const { bytes } = await fillWorkbook(await template(), data);
    const s = await open(bytes);
    // Total was at row 8 above a one-row table; two inserted rows push it to 10.
    expect(s.getCell("A10").value).toBe("Total");
  });

  it("leaves an empty block's row in place, blanked", async () => {
    // The template's empty rows are part of how the document reads. A parts table
    // that vanished when a visit fitted no parts would be a different form.
    const { bytes, report } = await fillWorkbook(await template(), { values: data.values, rows: { parts: [] } });
    const s = await open(bytes);
    expect(report.rowsAdded).toBe(0);
    expect(s.getCell("A6").value ?? "").toBe("");
    expect(s.getCell("A6").border?.bottom?.style).toBe("thin");
  });

  it("does not touch a template that asks for nothing", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Report").getCell("A1").value = "Just a heading";
    const { report } = await fillWorkbook(Buffer.from(await wb.xlsx.writeBuffer()), data);
    expect(report.filled).toBe(0);
  });
});

describe("telling the operator what happened", () => {
  it("names tokens the template wanted and the data lacked", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Report").getCell("A1").value = "{{poNumber}}";
    const { report } = await fillWorkbook(Buffer.from(await wb.xlsx.writeBuffer()), { values: {}, rows: {} });
    expect(report.unknown).toEqual(["poNumber"]);
  });

  it("names data the template never asked for", async () => {
    // How somebody finds out they typed {{serialNo}} where the app sends
    // {{serial}} - before a client is holding the report.
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Report").getCell("A1").value = "{{reportNumber}}";
    const { report } = await fillWorkbook(Buffer.from(await wb.xlsx.writeBuffer()), data);
    expect(report.unused).toContain("serial");
    expect(report.unused).toContain("parts.description");
    expect(report.unknown).toEqual([]);
  });

  it("counts what it filled, so a template that matched nothing is obvious", async () => {
    const { report } = await fillWorkbook(await template(), data);
    expect(report.filled).toBeGreaterThan(0);
    expect(report.unknown).toEqual([]);
  });
});
