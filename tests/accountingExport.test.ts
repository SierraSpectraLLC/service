// The rows a bookkeeper's software actually accepts. Pure, no DB.
import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/csv";
import {
  dollars, exportFileName, feesCsv, inMonth, invoicesCsv, monthsWithActivity, paymentsCsv,
} from "@/lib/accountingExport";

describe("dollars", () => {
  it("converts at the very edge, and never loses a cent", () => {
    expect(dollars(123456)).toBe("1234.56");
    expect(dollars(5)).toBe("0.05");
    expect(dollars(0)).toBe("0.00");
    expect(dollars(-2466)).toBe("-24.66");
  });
});

describe("invoicesCsv", () => {
  const rows = [{
    number: "INV-0092", orgName: "Lab Zen", status: "sent",
    issuedOn: "2026-08-19", dueOn: "2026-09-02", poNumber: "PO-2026-0411",
    workOrder: "WO-0388",
    lines: [
      { kind: "labor", description: "Labor, on site", qty: 4.5, unitCents: 16000, covered: false },
      { kind: "part", description: "Membrane, PK-4402", qty: 1, unitCents: 34000, covered: true },
    ],
  }];

  it("writes one row per line with the invoice's fields repeated", () => {
    const parsed = parseCsv(invoicesCsv(rows));
    expect(parsed[0]).toContain("InvoiceNo");
    expect(parsed).toHaveLength(3);
    expect(parsed[1][0]).toBe("INV-0092");
    expect(parsed[2][0]).toBe("INV-0092");
  });

  it("exports a covered line at zero with its list price beside it", () => {
    const parsed = parseCsv(invoicesCsv(rows));
    const head = parsed[0];
    const covered = parsed[2];
    expect(covered[head.indexOf("LineAmount")]).toBe("0.00");
    expect(covered[head.indexOf("ListAmount")]).toBe("340.00");
    expect(covered[head.indexOf("CoveredByAgreement")]).toBe("yes");
  });

  it("bills an uncovered line at quantity times unit", () => {
    const parsed = parseCsv(invoicesCsv(rows));
    const head = parsed[0];
    expect(parsed[1][head.indexOf("LineAmount")]).toBe("720.00");
    expect(parsed[1][head.indexOf("Quantity")]).toBe("4.5");
  });

  it("quotes a description that carries a comma", () => {
    const csv = invoicesCsv([{ ...rows[0], lines: [
      { kind: "part", description: "Seal kit, 6-pack", qty: 1, unitCents: 100, covered: false },
    ] }]);
    expect(csv).toContain('"Seal kit, 6-pack"');
    expect(parseCsv(csv)[1][8]).toBe("Seal kit, 6-pack");
  });
});

describe("paymentsCsv and feesCsv", () => {
  it("writes payments in dollars", () => {
    const parsed = parseCsv(paymentsCsv([{
      invoiceNumber: "INV-0087", orgName: "Coastal", method: "check",
      amountCents: 100000, reference: "9911", receivedOn: "2026-08-23",
    }]));
    expect(parsed[1]).toEqual(["INV-0087", "Coastal", "check", "1000.00", "9911", "2026-08-23"]);
  });

  it("exports a waived fee too, marked", () => {
    // A fee charged and then forgiven is a real event in the books; dropping
    // the row leaves a bookkeeper reconciling a reminder nobody can explain.
    const parsed = parseCsv(feesCsv([{
      invoiceNumber: "INV-0087", orgName: "Coastal", amountCents: 5800,
      basis: "1.50% per month", postedOn: "2026-08-12",
      waived: true, waivedReason: "Their AP was down",
    }]));
    expect(parsed[1][2]).toBe("58.00");
    expect(parsed[1][5]).toBe("yes");
    expect(parsed[1][6]).toBe("Their AP was down");
  });
});

describe("the file a bookkeeper files", () => {
  it("names itself by month", () => {
    expect(exportFileName("invoices", "2026-08")).toBe("invoices-2026-08.csv");
  });

  it("offers the months there is anything in, newest first", () => {
    expect(monthsWithActivity(["2026-08-19", "2026-07-02", "2026-08-01", "", "nonsense"]))
      .toEqual(["2026-08", "2026-07"]);
  });

  it("knows what fell inside one", () => {
    expect(inMonth("2026-08-19", "2026-08")).toBe(true);
    expect(inMonth("2026-09-01", "2026-08")).toBe(false);
    expect(inMonth("", "2026-08")).toBe(false);
  });
});
