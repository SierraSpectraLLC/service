import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { fillInvoiceXlsx, fillPoXlsx, fillQuoteXlsx, type DocLine } from "@/lib/xlsxDocs";

/**
 * The exported paperwork, read back cell by cell.
 *
 * The templates in /templates are the layout authority; what these prove is
 * that the fill writes the right DATA into the cells the maps in
 * lib/xlsxDocs name - and that a document longer than the table widens the
 * table instead of dropping its seventeenth line out of the total. That last
 * case is the money one: a total that quietly excludes a line is exactly the
 * kind of wrong that gets found by the client.
 */

const read = async (buf: Buffer, sheet: string) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet(sheet)!;
  const v = (addr: string) => {
    const val = ws.getCell(addr).value;
    if (val && typeof val === "object" && "formula" in val) return `=${(val as { formula: string }).formula}`;
    if (val && typeof val === "object" && "richText" in val)
      return (val as { richText: { text: string }[] }).richText.map((t) => t.text).join("");
    return val;
  };
  return { ws, v };
};

const CUSTOMER = { name: "Lab Zen, LLC.", address: "780 Chadbourne Ave.,\nFairfield, CA 94535" };
const line = (d: string, qty = 1, price = 100, pn = ""): DocLine =>
  ({ description: d, partNumber: pn, qty, unitPrice: price, taxExempt: true });

describe("invoice export", () => {
  it("writes the header, customer, lines and terms where the template expects them", async () => {
    const buf = await fillInvoiceXlsx({
      number: "INV-1001", date: "2026-07-01", customerPo: "PO-772", customer: CUSTOMER,
      description: "Monthly service retainer", detail: "cycle of 2026-07-01",
      terms: "Net 15, due 2026-07-16", contactLine: "Sierra Spectra | billing@example.com",
      lines: [line("Onsite Availability", 1, 20000, "ONS-30Day")],
    });
    const { v } = await read(buf, "Invoice_");
    expect(v("C4")).toBe("INV-1001");
    expect(v("C5")).toBe("PO-772");
    expect((v("C2") as Date).toISOString().slice(0, 10)).toBe("2026-07-01");
    expect(v("I9")).toBe("Lab Zen, LLC.");
    expect(v("I10")).toBe("780 Chadbourne Ave.");
    expect(v("I11")).toBe("Fairfield, CA 94535");
    expect(v("B17")).toBe("Monthly service retainer");
    expect(v("B25")).toBe("Onsite Availability");
    expect(v("F25")).toBe("ONS-30Day");
    expect(v("H25")).toBe(1);
    expect(v("I25")).toBe(20000);
    expect(v("J25")).toBe("X");
    expect(String(v("K25"))).toContain("SUM(I25*H25)");
    expect(v("K41")).toBe("=SUM(K25:L40)");
    expect(v("K45")).toBe("=SUM(K41:L44)");
    expect(v("B43")).toBe("Net 15, due 2026-07-16");
    expect(v("B51")).toBe("Sierra Spectra | billing@example.com");
    // The template's own furniture survived the fill.
    expect(v("G17")).toBe("Bank: U.S. Bank");
  });

  it("widens the table for a 20-line invoice and the total still covers every line", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => line(`Item ${i + 1}`, 1, 10));
    const buf = await fillInvoiceXlsx({
      number: "INV-1002", date: "2026-07-01", customerPo: "", customer: CUSTOMER,
      description: "Big job", detail: "", terms: "", contactLine: "", lines,
    });
    const { v } = await read(buf, "Invoice_");
    expect(v("B25")).toBe("Item 1");
    expect(v("B44")).toBe("Item 20");                    // 25 + 20 - 1
    expect(v("K45")).toBe("=SUM(K25:L44)");              // subtotal covers all 20
    expect(v("K49")).toBe("=SUM(K45:L48)");              // total shifted with it
    expect(String(v("K30"))).toContain("SUM(I30*H30)");  // inserted row computes its own row
    expect(v("B47")).toBe("Payment due upon Invoice");   // terms line moved down too
  });
});

describe("quote export", () => {
  it("fills the job, the equipment table and the comments", async () => {
    const buf = await fillQuoteXlsx({
      number: "030212_Ar1", date: "2026-03-02", customer: CUSTOMER,
      title: "Preventative Maintenance | Agilent 6495C QQQ",
      comments: ["Unlimited labor & travel for return visits", "Payment due upon acceptance"],
      contactLine: "Sierra Spectra | quotes@example.com",
      equipment: [{ module: "QQQ", model: "G6495C", serial: "SG2130D201" }],
      lines: [line("6495C | PM Kit", 1, 3000, "AGI-6495-PMK"), line("Zone 3 Labor", 1, 2400)],
    });
    const { v } = await read(buf, "Quote");
    expect(v("C5")).toBe("030212_Ar1");
    expect(v("B17")).toBe("Preventative Maintenance | Agilent 6495C QQQ");
    expect(v("S17")).toBe("QQQ");
    expect(v("U17")).toBe("SG2130D201");
    expect(v("B25")).toBe("6495C | PM Kit");
    expect(v("B26")).toBe("Zone 3 Labor");
    expect(v("K41")).toBe("=SUM(K25:L40)");
    expect(v("K45")).toBe("=K41+K42");                   // the quote's own total shape
    expect(v("B43")).toBe("Unlimited labor & travel for return visits");
    expect(v("B51")).toBe("Sierra Spectra | quotes@example.com");
  });
});

describe("purchase order export", () => {
  it("fills the vendor, the order row and the lines", async () => {
    const buf = await fillPoXlsx({
      number: "PO-2026-014", date: "2026-08-25",
      vendor: { name: "Restek", address: "110 Benner Circle\nBellefonte, PA 16823" },
      orderedBy: "Dev Owner", reference: "Q-88121", shipVia: "FedEx", terms: "Net 30",
      comments: ["Please ship 2-day via FedEx."], contactLine: "purchasing@example.com",
      lines: [line("Vespel ferrule 1/4in", 10, 12.5, "20211")],
    });
    const { v } = await read(buf, "Purchase Order");
    expect(v("C4")).toBe("PO-2026-014");
    expect(v("I8")).toBe("Restek");
    expect(v("I9")).toBe("110 Benner Circle");
    expect(v("B15")).toBe("Dev Owner");
    expect(v("D15")).toBe("Q-88121");
    expect(v("J15")).toBe("Net 30");
    expect(v("B20")).toBe("Vespel ferrule 1/4in");
    expect(v("H20")).toBe(10);
    expect(v("I20")).toBe(12.5);
    expect(v("J36")).toBe("=SUM(J20:K35)");
    expect(v("J39")).toBe("=SUM(J36:K38)");
    expect(v("B38")).toBe("Please ship 2-day via FedEx.");
    expect(v("C45")).toBe("purchasing@example.com");
  });

  it("widens the PO table past sixteen lines", async () => {
    const lines = Array.from({ length: 18 }, (_, i) => line(`Part ${i + 1}`, 1, 5));
    const buf = await fillPoXlsx({
      number: "PO-2026-015", date: "2026-08-25", vendor: { name: "Agilent", address: "" },
      orderedBy: "", reference: "", shipVia: "", terms: "", comments: [], contactLine: "",
      lines,
    });
    const { v } = await read(buf, "Purchase Order");
    expect(v("B20")).toBe("Part 1");
    expect(v("B37")).toBe("Part 18");
    expect(v("J38")).toBe("=SUM(J20:K37)");
    expect(v("J41")).toBe("=SUM(J38:K40)");
  });
});
