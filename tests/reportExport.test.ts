// The bookkeeper's copy of a claim: the sheet, and the PDF with the paper in it.
//
// Two failures worth fencing off, and neither is a crash.
//
// The first is the factor of a hundred. Every accounting package reads
// 1234.56; hand one 123456 and nobody notices until a quarter closes. That is
// why lib/accountingExport converts at the very edge and why this converts in
// exactly the same place.
//
// The second is quieter: a claim that exports as if it had paper when it does
// not. "Receipt" is the column an auditor sorts on, and an empty cell there
// reads as "nobody filled this column in" rather than "there is no receipt for
// this money". So it says MISSING, out loud, in both formats.
//
// The PDF is re-parsed rather than trusted - the same discipline
// tests/pdfCombine follows. A drawing call that ran is not a page that exists.
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { parseCsv } from "@/lib/csv";
import {
  exportName, packetName, policyCell, receiptCell, reportCents, reportRows, reportStanding,
  reportsCsv, type ExportExpense, type ExportReport,
} from "@/lib/reportExport";
import { reportPdf } from "@/lib/reportPdf";

const expense = (over: Partial<ExportExpense> = {}): ExportExpense => ({
  incurredOn: "2026-08-04", kind: "Lodging", description: "Cannery Pier, 2 nights",
  amountCents: 33_000, billable: true, workOrderNumber: "WO-2045", siteName: "Pier Road",
  receiptName: "folio.pdf", allowanceState: "", allowanceNote: "", allowanceBy: "", ...over,
});

const report = (over: Partial<ExportReport> = {}): ExportReport => ({
  id: 14, title: "Astoria commissioning, week of the 8th", person: "Tess Nakamura",
  purpose: "Two nights on site bringing the Pier Road LC-MS up.",
  status: "paid", workOrderNumber: "WO-2045", openedBy: "Tess Nakamura",
  submittedOn: "2026-08-10", paidOn: "2026-08-15", paidRef: "check 1044",
  expenses: [expense()], ...over,
});

describe("the sheet an accountant imports", () => {
  it("writes money in dollars, at the edge and nowhere else", () => {
    // The factor of a hundred. 33000 cents is 330.00, and a package handed
    // 33000 books three hundred and thirty times too much.
    const rows = parseCsv(reportsCsv([report()]));
    const amount = rows[0].indexOf("Amount");
    expect(rows[1][amount]).toBe("330.00");
  });

  it("repeats the claim's own fields on every row", () => {
    /*
     * One row per expense with the identifying columns repeated - the shape
     * lib/accountingExport uses for invoice lines, and for the same reason: a
     * sheet where the report name only appears on the first row of each group
     * is one somebody has to take apart before they can sort it.
     */
    const rows = parseCsv(reportsCsv([report({
      expenses: [expense(), expense({ kind: "Per diem", amountCents: 6500, description: "Astoria, 2 days" })],
    })]));
    expect(rows).toHaveLength(3);
    const person = rows[0].indexOf("Person");
    expect(rows[1][person]).toBe("Tess Nakamura");
    expect(rows[2][person]).toBe("Tess Nakamura");
  });

  it("says MISSING rather than leaving the receipt cell blank", () => {
    // An empty cell reads as "nobody filled this column in". This one means
    // "there is no paper behind this money", which is a different fact and the
    // one an auditor is looking for.
    expect(receiptCell("")).toBe("MISSING");
    expect(receiptCell("   ")).toBe("MISSING");
    expect(receiptCell("folio.pdf")).toBe("folio.pdf");
  });

  it("keeps an empty claim on the sheet", () => {
    // A draft nobody filled is a fact. Dropping it makes the export disagree
    // with the desk about how many claims exist.
    const rows = parseCsv(reportsCsv([report({ expenses: [] })]));
    expect(rows).toHaveLength(2);
    expect(rows[1][rows[0].indexOf("Report ID")]).toBe("14");
  });

  it("collapses the policy column to something sortable", () => {
    expect(policyCell("flagged")).toBe("Needs approval");
    expect(policyCell("approved")).toBe("Approved");
    expect(policyCell("")).toBe("Within policy");
  });

  it("survives a description with a comma, a quote and a newline", () => {
    // Free text somebody typed on a phone. lib/csv handles it; this is the
    // test that says the export actually goes through lib/csv.
    const nasty = 'Parking, "the garage"\nlevel 3';
    const rows = parseCsv(reportsCsv([report({ expenses: [expense({ description: nasty })] })]));
    expect(rows[1][rows[0].indexOf("Description")]).toBe(nasty);
  });
});

describe("what a claim is standing at", () => {
  it("never says paid without saying when and against what", () => {
    // "Paid" on its own is the half of the answer that prompts the phone call.
    expect(reportStanding(report())).toBe("Paid 2026-08-15 (check 1044)");
    expect(reportStanding(report({ paidRef: "" }))).toBe("Paid 2026-08-15");
  });

  it("reads the other states plainly", () => {
    expect(reportStanding(report({ status: "submitted" }))).toContain("Awaiting payout");
    expect(reportStanding(report({ status: "draft" }))).toContain("not yet submitted");
    expect(reportStanding(report({ status: "returned" }))).toContain("Returned");
  });
});

describe("naming the files in a packet", () => {
  it("numbers receipts in the report's own row order, and dates them", () => {
    // So the archive sorts the way the sheet reads, and the Receipt column can
    // be matched by eye rather than by opening forty files.
    expect(packetName(0, expense())).toBe("01-2026-08-04-lodging-cannery-pier-2-nights.pdf");
    expect(packetName(11, expense({ kind: "Per diem", receiptName: "IMG_1.JPG", description: "Lunch" })))
      .toBe("12-2026-08-04-per-diem-lunch.jpg");
  });

  it("copes with a receipt that has no usable name", () => {
    expect(packetName(0, expense({ receiptName: "", kind: "", description: "" })))
      .toBe("01-2026-08-04-receipt.jpg");
  });

  it("keeps an export file name safe for a filesystem", () => {
    expect(exportName("expense-report-14-Tess Nakamura", "pdf"))
      .toBe("expense-report-14-tess-nakamura.pdf");
    expect(exportName("../../etc/passwd", "csv")).toBe("etc-passwd.csv");
  });
});

describe("the totals", () => {
  it("sums the rows and nothing else", () => {
    expect(reportCents(report({ expenses: [expense({ amountCents: 33_000 }), expense({ amountCents: 6500 })] })))
      .toBe(39_500);
    expect(reportCents(report({ expenses: [] }))).toBe(0);
  });
});

describe("the PDF, re-parsed rather than trusted", () => {
  /** A 1x1 PNG, as the smallest thing pdf-lib will actually embed. */
  const PNG = Uint8Array.from(atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ), (c) => c.charCodeAt(0));

  it("produces a readable document with a page for the claim", async () => {
    const bytes = await reportPdf(report(), []);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    // The title is what a bookkeeper sees in their file manager and in the
    // tab, so it has to be the claim's name rather than "Untitled".
    expect(doc.getTitle()).toBe("Astoria commissioning, week of the 8th");
  });

  it("puts a page behind every receipt it was handed", async () => {
    const one = await PDFDocument.load(await reportPdf(report(), []));
    const withPaper = await PDFDocument.load(await reportPdf(report(), [
      { expenseIndex: 0, name: "folio.png", contentType: "image/png", bytes: PNG },
    ]));
    expect(withPaper.getPageCount()).toBe(one.getPageCount() + 1);
  });

  it("copies an attached PDF receipt whole rather than taking its first page", async () => {
    /*
     * An emailed invoice is often several pages and the total is rarely on the
     * first. Cropping to page one loses exactly the number being substantiated.
     */
    const src = await PDFDocument.create();
    src.addPage([200, 200]);
    src.addPage([200, 200]);
    src.addPage([200, 200]);
    const three = await src.save();

    const base = await PDFDocument.load(await reportPdf(report(), []));
    const out = await PDFDocument.load(await reportPdf(report(), [
      { expenseIndex: 0, name: "invoice.pdf", contentType: "application/pdf", bytes: three },
    ]));
    expect(out.getPageCount()).toBe(base.getPageCount() + 3);
  });

  it("still produces a document when a receipt is corrupt", async () => {
    // The claim is worth sending even when one blob is unreadable, and the row
    // keeps its MISSING in the table. A throw here would mean one bad receipt
    // makes a whole claim undownloadable.
    const junk = new Uint8Array([1, 2, 3, 4, 5]);
    const out = await PDFDocument.load(await reportPdf(report(), [
      { expenseIndex: 0, name: "broken.pdf", contentType: "application/pdf", bytes: junk },
      { expenseIndex: 0, name: "broken.jpg", contentType: "image/jpeg", bytes: junk },
    ]));
    // A placeholder page each, rather than silence.
    const base = await PDFDocument.load(await reportPdf(report(), []));
    expect(out.getPageCount()).toBe(base.getPageCount() + 2);
  });

  it("handles a long claim without running off the page", async () => {
    // Forty rows is a real month for one engineer. The table has to break onto
    // a second sheet rather than draw at a negative y, which pdf-lib will do
    // perfectly happily and invisibly.
    const many = Array.from({ length: 40 }, (_, i) =>
      expense({ description: `Row ${i + 1}`, amountCents: 1000 + i }));
    const doc = await PDFDocument.load(await reportPdf(report({ expenses: many }), []));
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it("writes a claim with no rows at all", async () => {
    const doc = await PDFDocument.load(await reportPdf(report({ expenses: [] }), []));
    expect(doc.getPageCount()).toBe(1);
  });
});
