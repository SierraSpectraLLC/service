import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { buildServiceReport, type ServiceReport } from "@/lib/serviceReport";
import { notesRecord, type RecordTask } from "@/lib/serviceReportDoc";
import { serializeTable, tableIsRecorded, tableVerdict } from "@/lib/resultTable";
import { evaluateResult, resultIsRecorded } from "@/lib/testResult";

/**
 * What a PM visit checked off, on the page the client signs.
 *
 * The Quattro Ultima PM is the case this was built from: six readings, six
 * boxes, and three tune tables (MS1, MS2, MRM) of masses with an intensity
 * and a verdict each. Ticked in Ridgeline at the bench, printed in the notes
 * box the way the hand-typed sheets always laid it out.
 */
const grid = (rows: [string, string, string][]) =>
  serializeTable({ cols: ["Mass (Da)", "m/z Intensity Measured"], rows });

const PM: RecordTask[] = [
  { title: "Collision Cell w/Collision Gas", state: "Done", checklist: [], resultType: "measured", result: { value: "4.80e-3 OK", passed: null } },
  { title: "Source CID On", state: "Done", checklist: [], resultType: "pass_fail", result: { value: "Pass", passed: true } },
  {
    title: "Quattro Ultima PM", state: "Done", resultType: null, result: null,
    checklist: [
      { text: "Checked for front-end contamination", done: true, heading: false },
      { text: "Replaced Air Filter", done: true, heading: false },
      { text: "Pump down minimum 60 mins", done: false, heading: false },
    ],
  },
  {
    title: "Positive Scan Mode - MS1", state: "Done", checklist: [], resultType: "table",
    result: { value: grid([["132.9", "6.50E+07", "Pass"], ["172.9", "8.52E+07", "Pass"], ["622.6", "1.39E+07", "Pass"], ["1971.6", "4.01E+06", "Pass"]]), passed: true },
  },
  {
    title: "Positive Scan Mode - MRM", state: "Done", checklist: [], resultType: "table",
    result: { value: grid([["172.8", "6.60E+06", "Pass"]]), passed: true },
  },
  { title: "Tightened all vacuum and electrical connections", state: "Done", checklist: [], resultType: null, result: null },
];

function pageText(doc: PDFDocument, ix: number): string {
  const contents = doc.getPage(ix).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  let raw = "";
  for (const s of streams) {
    if (s instanceof PDFRawStream) raw += Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
  }
  return [...raw.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1")).join("\n");
}

const report = (over: Partial<ServiceReport> = {}): ServiceReport => ({
  reportNumber: "030190_PM1", date: "2026-01-15", visitDate: "Thursday, January 15, 2026",
  serviceType: "PM", visitNumber: "01", engineer: "Joe Harris",
  provider: { name: "Sierra Spectra, LLC.", lines: ["2393 Anglers Ct", "Mariposa, CA 95338"] },
  customer: { name: "UCSF - HAL", lines: ["580 Parnassus Ave.,", "RM# S920", "San Francisco, CA 94143"] },
  instrument: { type: "Waters Quattro Ultima MS", model: "Quattro Ultima", serial: "VC389" },
  workCompleted: "Performed PM on Q. Ultima", poNumber: "030182_Ar2",
  request: { date: "2026-01-12", from: "Weaver, Alexa", text: "PM Request" },
  notes: { date: "2026-01-15", body: "" },
  calibration: [], parts: [], labor: [],
  balances: { visitsRemaining: "-", partsRemaining: "-", partsTotal: "-" },
  adjustmentCents: 0,
  signatures: { providerName: "Joe Harris", customerName: "Unspecified", customerOrg: "UCSF" },
  contact: "Sierra Spectra",
  ...over,
});

describe("the results table", () => {
  it("is recorded once every read row has a verdict, and fails on any failed row", () => {
    const ok = grid([["132.9", "6.50E+07", "Pass"], ["172.9", "8.52E+07", "Pass"]]);
    expect(tableIsRecorded(ok)).toBe(true);
    expect(resultIsRecorded("table", ok)).toBe(true);
    expect(evaluateResult({ resultType: "table", target: null, tolerancePct: null }, ok).passed).toBe(true);
    expect(tableIsRecorded(grid([["132.9", "6.50E+07", ""]]))).toBe(false);
    const bad = grid([["132.9", "6.50E+07", "Pass"], ["622.6", "1.0E+03", "Fail"]]);
    expect(tableVerdict(bad)).toMatchObject({ passed: false });
    expect(tableVerdict(bad).why).toContain("622.6");
  });
});

describe("the visit's record in the notes box", () => {
  it("lays the readings, boxes and tables out from the job's tasks", () => {
    const rec = notesRecord(PM, "PM")!;
    expect(rec.checks[0]).toEqual({ kind: "heading", text: "PM Validation Checks" });
    expect(rec.checks).toContainEqual({ kind: "reading", text: "Collision Cell w/Collision Gas: 4.80e-3 OK" });
    expect(rec.checks).toContainEqual({ kind: "reading", text: "Source CID On: OK" });
    expect(rec.checks).toContainEqual({ kind: "box", text: "Replaced Air Filter", done: true });
    expect(rec.checks).toContainEqual({ kind: "box", text: "Pump down minimum 60 mins", done: false });
    // A plain task with no checklist is a box of its own.
    expect(rec.checks).toContainEqual({ kind: "box", text: "Tightened all vacuum and electrical connections", done: true });
    expect(rec.tables.map((t) => t.title)).toEqual(["Positive Scan Mode - MS1", "Positive Scan Mode - MRM"]);
    expect(rec.tables[0].rows[3]).toEqual(["1971.6", "4.01E+06", "Pass"]);
  });

  it("draws nothing for a job with nothing on it", () => {
    expect(notesRecord([], "Repair")).toBeUndefined();
  });

  it("prints the record on page one, and an old report without one exactly as before", async () => {
    const bytes = await buildServiceReport(report({ record: notesRecord(PM, "PM") }));
    if (process.env.REPORT_OUT) writeFileSync(process.env.REPORT_OUT, bytes);
    const doc = await PDFDocument.load(bytes);
    const p1 = pageText(doc, 0);
    for (const s of ["PM Validation Checks", "Replaced Air Filter", "Positive Scan Mode - MS1", "Mass (Da)", "6.50E+07", "Pass/Fail"]) {
      expect(p1).toContain(s);
    }
    expect(doc.getPageCount()).toBe(2);
    const plain = await PDFDocument.load(await buildServiceReport(report({ notes: { date: "2026-01-15", body: "Replaced filter" } })));
    expect(plain.getPageCount()).toBe(2);
  });

  it("carries a record too long for one sheet onto the next", async () => {
    const many: RecordTask[] = Array.from({ length: 6 }, (_, k) => ({
      title: `Scan ${k + 1}`, state: "Done", checklist: [], resultType: "table",
      result: { value: grid(Array.from({ length: 8 }, (_, i) => [`${100 + i}`, "1.0E+06", "Pass"] as [string, string, string])), passed: true },
    }));
    const doc = await PDFDocument.load(await buildServiceReport(report({ record: notesRecord(many, "PM") })));
    expect(doc.getPageCount()).toBeGreaterThan(2);
    const all = [0, 1].map((i) => pageText(doc, i)).join("\n");
    expect(all).toContain("Scan 6");
  });
});
