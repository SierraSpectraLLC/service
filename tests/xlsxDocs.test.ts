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

  /*
   * The quote the shop actually sends, rebuilt from the record.
   *
   * Every cell below was filled by hand in Excel after the export, because the
   * record had nowhere to keep it: the greeting was the template's fixed
   * sentence, the address block took two lines whatever the address was, the
   * adjustment row was a literal zero, the comment block took three rows, and a
   * line item that covers seven modules was seven rows typed one at a time.
   */
  it("writes the letter: the person, the whole address, the discount and five comments", async () => {
    const buf = await fillQuoteXlsx({
      number: "030190_B", date: "2025-09-30",
      customer: {
        name: "UCSF Hair Analytical Lab",
        address: "Room 290, Box 0446\n513 Parnassus Ave.\nSan Francisco, CA 94143",
      },
      title: "Full-Service Unlimited Contract",
      greeting: "Hideaki, thank you for considering us! Here are the specifics of your quote:",
      discount: 12000,
      discountLabel: "Pooled repair part allocation",
      comments: [
        "HPLC Included w/Quattro Ultima cost", "Dedicated CA-Based Engineer",
        "Additional coverages can be bought:", "25% deposit due on approval",
        "Quote good through 2025-10-30",
      ],
      contactLine: "Sierra Spectra | quotes@example.com",
      lines: [line("Quattro Ultima | Full-Service Unlimited 12mo", 1, 18000, "FSC-QULT-UNL")],
    });
    const { v } = await read(buf, "Quote");
    expect(v("B16")).toBe("Hideaki, thank you for considering us! Here are the specifics of your quote:");
    // Three address rows, not two: a mail stop and a box number are the lines
    // that used to get folded into the city.
    expect(v("I9")).toBe("UCSF Hair Analytical Lab");
    expect(v("I10")).toBe("Room 290, Box 0446");
    expect(v("I11")).toBe("513 Parnassus Ave.");
    expect(v("I12")).toBe("San Francisco, CA 94143");
    // Negative, into the row the template's own total already adds - so the
    // exported file still recomputes if somebody edits a quantity in Excel.
    expect(v("K42")).toBe(-12000);
    expect(v("K45")).toBe("=K41+K42");
    expect(v("H42")).toBe("Pooled repair part allocation");
    expect(v("B43")).toBe("HPLC Included w/Quattro Ultima cost");
    expect(v("B47")).toBe("Quote good through 2025-10-30");
  });

  it("writes the specifics block into the two columns the template has for it", async () => {
    /*
     * Rows 17-23, B and G. Fourteen cells the template has always had and
     * nothing ever wrote to but B17 - so this block was typed into the
     * exported file by hand after every send.
     */
    const buf = await fillQuoteXlsx({
      number: "030190_C", date: "2025-09-30", customer: CUSTOMER,
      title: "Should not print - the specifics take B17",
      comments: [], contactLine: "",
      specs: {
        left: [
          { text: "Full-Service Unlimited Contract for:", sub: false },
          { text: "System A (Quattro Ultima & LC-10 LC)", sub: true },
          { text: "$12,000 pooled repair part allocation", sub: false },
        ],
        right: [
          { text: "Unlimited Emergency Service Visits", sub: false },
          { text: "Unlimited Days per Service Visit", sub: true },
        ],
      },
      lines: [line("Coverage", 1, 32000)],
    });
    const { ws, v } = await read(buf, "Quote");
    expect(v("B17")).toBe("Full-Service Unlimited Contract for:");
    // A point prints indented under its heading, the way the shop's own quote
    // does - and only the heading is bold.
    expect(v("B18")).toBe(" - System A (Quattro Ultima & LC-10 LC)");
    expect(v("B19")).toBe("$12,000 pooled repair part allocation");
    expect(ws.getCell("B17").font?.bold).toBe(true);
    expect(ws.getCell("B18").font?.bold ?? false).toBe(false);
    expect(ws.getCell("B19").font?.bold).toBe(true);
    // The right column, beside it.
    expect(v("G17")).toBe("Unlimited Emergency Service Visits");
    expect(v("G18")).toBe(" - Unlimited Days per Service Visit");
    // Rows nobody used are cleared rather than left with the template's own
    // placeholder text, and the table's header on row 24 is untouched.
    expect(v("B20")).toBe(null);
    expect(v("G19")).toBe(null);
    expect(v("B24")).toBe("Description");
  });

  it("keeps the quote's title in B17 when there is no specifics block", async () => {
    // What every quote written before this block existed says.
    const buf = await fillQuoteXlsx({
      number: "030190_D", date: "2025-09-30", customer: CUSTOMER,
      title: "Relocate the GC-2010 to lab 4", comments: [], contactLine: "",
      lines: [line("Labor", 1, 500)],
    });
    const { v } = await read(buf, "Quote");
    expect(v("B17")).toBe("Relocate the GC-2010 to lab 4");
  });

  it("leaves the template's own greeting and adjustment alone when the quote says nothing", async () => {
    const buf = await fillQuoteXlsx({
      number: "030213", date: "2026-03-02", customer: CUSTOMER,
      title: "PM visit", comments: [], contactLine: "",
      lines: [line("PM Kit", 1, 3000)],
    });
    const { v } = await read(buf, "Quote");
    expect(v("B16")).toBe("Thank you for considering us! Here are the specifics of the job:");
    // The template ships a literal 0 here. A quote with no discount must not
    // start writing to the cell at all.
    expect(v("K42")).toBe(0);
    expect(v("H42")).toBe("Adjustments");
  });

  it("prints a multi-line description as its own rows, priced once, the detail italic", async () => {
    const buf = await fillQuoteXlsx({
      number: "030214", date: "2026-03-02", customer: CUSTOMER,
      title: "Contract", comments: [], contactLine: "",
      lines: [
        { description: "LC-10 HPLC | Full-Service Unlimited 12mo", partNumber: "FSC-LC10-UNL", qty: 1, unitPrice: 8000 },
        { description: "- Shimadzu LC-10 AS", continuation: true },
        { description: "- Waters 717 Plus", continuation: true },
        { description: "LC-20 HPLC | Full Service Unlimited 12mo", partNumber: "FSC-LC20-UNL", qty: 1, unitPrice: 10000 },
      ],
    });
    const { ws, v } = await read(buf, "Quote");
    expect(v("B25")).toBe("LC-10 HPLC | Full-Service Unlimited 12mo");
    expect(v("H25")).toBe(1);
    // The detail carries no quantity and no price: the charge is stated once,
    // and the template's row formula prints "-" beside it.
    expect(v("B26")).toBe("- Shimadzu LC-10 AS");
    expect(v("H26")).toBe(null);
    expect(v("I26")).toBe(null);
    expect(ws.getCell("B26").font?.italic).toBe(true);
    // And the charge above it is NOT italic - ExcelJS shares one style object
    // across every cell of a format, so setting the font on one row once
    // italicised the whole table.
    expect(ws.getCell("B25").font?.italic ?? false).toBe(false);
    expect(ws.getCell("B28").font?.italic ?? false).toBe(false);
    expect(v("B28")).toBe("LC-20 HPLC | Full Service Unlimited 12mo");
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
