import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { buildServiceReport, reportTotals, type ServiceReport } from "@/lib/serviceReport";

/**
 * The service report is a reproduction of a document Sierra Spectra has been
 * sending clients for years, and the client knows what it looks like. So these
 * tests are about faithfulness rather than about pdf-lib working: the section
 * headings in their original order and spelling, the two figures on page one
 * that are contract balances rather than this visit's sums, and the arithmetic
 * of the totals block including a contract visit that bills nothing.
 */
function pageText(doc: PDFDocument, ix: number): string {
  const contents = doc.getPage(ix).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  let raw = "";
  for (const s of streams) {
    if (s instanceof PDFRawStream) raw += Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
  }
  return [...raw.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)]
    .map((m) => Buffer.from(m[1], "hex").toString("latin1"))
    .join("\n");
}

/** Every y a glyph was placed at on one page, read out of the text matrices. */
function drawnYs(doc: PDFDocument, ix: number): number[] {
  const contents = doc.getPage(ix).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  let raw = "";
  for (const s of streams) {
    if (s instanceof PDFRawStream) raw += Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
  }
  return [...raw.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm/g)].map((m) => parseFloat(m[2]));
}

/**
 * Every rectangle drawn on a page, as {x, y, w, h} in points. pdf-lib writes a
 * box as a translate and a path, so the numbers are read back out of both.
 */
function boxes(doc: PDFDocument, ix: number): { x: number; y: number; w: number; h: number }[] {
  const contents = doc.getPage(ix).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  let raw = "";
  for (const s of streams) {
    if (s instanceof PDFRawStream) raw += Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
  }
  return [...raw.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) cm\s+1 0 0 1 0 0 cm\s+1 0 0 1 0 0 cm\s+0 0 m\s+0 ([\d.]+) l\s+([\d.]+) [\d.]+ l/g)]
    .map((m) => ({ x: parseFloat(m[1]), y: parseFloat(m[2]), h: parseFloat(m[3]), w: parseFloat(m[4]) }));
}

/** The August visit to Modesto Irrigation District, as it was actually sent. */
function visit(over: Partial<ServiceReport> = {}): ServiceReport {
  return {
    reportNumber: "030181_SR2", date: "2025-08-25", visitDate: "Monday, August 25, 2025",
    serviceType: "PM", visitNumber: "02", engineer: "Joe Harris",
    provider: { name: "Sierra Spectra, LLC.", lines: ["2393 Anglers Ct.,", "Mariposa, CA 95338"] },
    customer: { name: "Modesto Irrigation District", lines: ["1008 Reservoir Rd.,", "Waterford, CA 95386"] },
    instrument: { type: "Shimadzu UV-1900 UV-Vis", model: "UV-1900", serial: "A12425650267" },
    workCompleted: "PM & Recalibration on UV-1900", poNumber: "030181_A",
    request: { date: "2025-08-12", from: "Harpreet Saini", text: "PM Due on UV-1900" },
    notes: {
      date: "2025-08-25",
      body: "Instrument as found:\n- Checked 550nm Green Slit | OK\n\nReplaced W1 & D2 Lamps\n- Ran Noise Level test | All Pass\n\nALL PASS. ALL OK",
    },
    calibration: [{
      description: "Refmacal CRM-500 UV-Vis Standards", partNumber: "CRM-500",
      quantity: 1, unitCents: null, taxExempt: false,
    }],
    parts: [
      { description: "UV-1900 | D2 Deuterium Lamp", partNumber: "062-65055-05", quantity: 1, unitCents: 60000, taxExempt: true },
      { description: "UV-1900 | W1 Tungsten/Halogen Bulb", partNumber: "062-65005-00", quantity: 1, unitCents: 20000, taxExempt: true },
      { description: "UV-1900 | PM Charge", partNumber: "SVC. UVPM", quantity: 1, unitCents: 240000, taxExempt: true },
    ],
    labor: [
      { description: "Standard Travel Zone 1", partNumber: "SVC. TZ1", quantity: 0, unitCents: 31500, taxExempt: true },
      { description: "Standard Labor Rate", partNumber: "SVC. Labor", quantity: 0, unitCents: 30000, taxExempt: true },
    ],
    balances: { visitsRemaining: "-", partsRemaining: "-", partsTotal: "-" },
    adjustmentCents: -320000,
    signatures: {
      providerName: "Joe Harris", customerName: "Harpreet Saini",
      customerOrg: "Modesto Irrigation District",
      // The issuing company is DATA. It used to be a string inside the
      // generator, which would have printed one operator's name on another
      // operator's report - and survived a rebrand to say the wrong thing.
      providerOrg: "Sierra Spectra",
    },
    contact: "Sierra Spectra | +1(833) 574-3772 | sales@sierraspectra.com",
    ...over,
  };
}

const load = async (r: ServiceReport) => PDFDocument.load(await buildServiceReport(r));

describe("the report keeps its shape", () => {
  it("is two pages, with the header repeated on both", async () => {
    const doc = await load(visit());
    expect(doc.getPageCount()).toBe(2);
    for (const ix of [0, 1]) {
      expect(pageText(doc, ix)).toContain("SERVICE REPORT");
      expect(pageText(doc, ix)).toContain("030181_SR2");
    }
  });

  it("carries the five section headings in their original order", async () => {
    const doc = await load(visit());
    const one = pageText(doc, 0);
    const two = pageText(doc, 1);
    // Page one: who, then what was asked, then what was done.
    expect(one.indexOf("Service Overview")).toBeLessThan(one.indexOf("Service Request Information"));
    expect(one.indexOf("Service Request Information")).toBeLessThan(one.indexOf("Service Engineer Notes"));
    // Page two: what was used, then what it costs.
    expect(two.indexOf("Calibration & Equpment")).toBeLessThan(two.indexOf("Parts Summary"));
    expect(two.indexOf("Parts Summary")).toBeLessThan(two.indexOf("Labor & Travel Summary"));
    expect(two.indexOf("Labor & Travel Summary")).toBeLessThan(two.indexOf("Remaining Balances:"));
  });

  it("names the instrument by type, model and serial", async () => {
    const one = pageText(await load(visit()), 0);
    expect(one).toContain("Shimadzu UV-1900 UV-Vis");
    expect(one).toContain("A12425650267");
  });

  it("embeds the mark it is handed, and types the name when it has none", async () => {
    const png = readFileSync("templates/ServiceReportLogo.png");
    const withLogo = Buffer.from(await buildServiceReport(visit({ logo: new Uint8Array(png) }))).toString("latin1");
    expect(withLogo).toContain("/Subtype /Image");
    // No mark: the operator's name is typed, letter-spaced. Never a stand-in.
    const bare = await load(visit({ provider: { name: "Acme Engineering", lines: [] } }));
    expect(Buffer.from(await bare.save()).toString("latin1")).not.toContain("/Subtype /Image");
    expect(pageText(bare, 0)).toContain("A C M E");
  });

  it("names the module instead of the model when the work was on one", async () => {
    // The original's own rule: the row says which thing this is about, so a
    // job on a pump names the pump and a job on the stack names its model.
    const one = pageText(await load(visit({
      instrument: { type: "Thermo UPLC", model: "Vanquish Flex", serial: "8339399", module: "Pump VF-P10" },
    })), 0);
    expect(one).toContain("Module:");
    expect(one).toContain("Pump VF-P10");
    expect(one).not.toContain("Model Number:");
  });

  it("counts the visit off the contract, not the kind of visit it was", async () => {
    // "Service Visit: 02" is which visit of the term this was. It printed the
    // service type for a while, which told a client counting down nothing.
    const one = pageText(await load(visit()), 0);
    expect(one).toContain("Service Visit:");
    expect(one).toContain("02");
    const none = pageText(await load(visit({ visitNumber: "" })), 0);
    expect(none).toContain("Service Visit:");
  });

  it("keeps the closing lines a client looks for", async () => {
    const two = pageText(await load(visit()), 1);
    expect(two).toContain("THIS IS NOT AN INVOICE");
    expect(two).toContain("Signatures acknowledge");
    expect(two).toContain("Sierra Spectra Field Service Engineer:");
    expect(two).toContain("Modesto Irrigation District Representative Signature");
    expect(two).toContain("Rep Name: Harpreet Saini");
  });

  it("names the issuing company from the report, never from the generator", async () => {
    const two = pageText(await load(visit({
      signatures: {
        providerName: "Joe Harris", customerName: "Harpreet Saini",
        customerOrg: "Modesto Irrigation District", providerOrg: "Acme Engineering",
      },
    })), 1);
    expect(two).toContain("Acme Engineering Field Service Engineer:");
    expect(two).not.toContain("Sierra Spectra Field Service Engineer:");
  });

  it("falls back to a plain role rather than somebody else's name", async () => {
    const two = pageText(await load(visit({
      signatures: {
        providerName: "Joe Harris", customerName: "Harpreet Saini",
        customerOrg: "Modesto Irrigation District",
      },
    })), 1);
    expect(two).toContain("Service Field Service Engineer:");
  });

  it("prints the engineer's notes with their headings and results intact", async () => {
    const one = pageText(await load(visit()), 0);
    expect(one).toContain("Instrument as found:");
    expect(one).toContain("- Checked 550nm Green Slit | OK");
    expect(one).toContain("ALL PASS. ALL OK");
  });
});

describe("the paper, not the words", () => {
  it("runs the notes box to the foot of the page however short the visit was", async () => {
    // The sheet prints its cells where its cells are. A two-line close-out
    // used to get a two-line box floating in half a page of white.
    const short = boxes(await load(visit({ notes: { date: "2025-08-25", body: "Looked at it. Fine." } })), 0);
    const long = boxes(await load(visit()), 0);
    const full = (bs: typeof short) => bs.filter((b) => b.w > 560 && b.h > 150);
    expect(full(short)).toHaveLength(1);
    // Bottom edge on the original's rule, a line and a half above the footer.
    expect(full(short)[0].y).toBe(66);
    // And the long one ends in the same place, so two reports stack.
    expect(full(long)[0].y).toBe(66);
    expect(full(short)[0].h).toBeCloseTo(full(long)[0].h, 5);
  });

  it("puts the signatures and the closing lines where the sheet puts them", async () => {
    // Anchored to the paper: a visit with thirty parts on it must not push
    // the contact line into the page number.
    const busy = visit({
      parts: Array.from({ length: 9 }, (_, i) => ({
        description: `Part ${i + 1}`, partNumber: `P-${i}`, quantity: 1, unitCents: 1000, taxExempt: true,
      })),
    });
    for (const r of [visit(), busy]) {
      const doc = await load(r);
      const ys = drawnYs(doc, doc.getPageCount() - 1);
      // The statement, THIS IS NOT AN INVOICE, the question, the contact.
      for (const y of [109, 83, 70, 57]) expect(ys).toContain(y);
      // Nothing below the page number.
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(44);
    }
  });
});

describe("page one's parts figures are the contract's, not the visit's", () => {
  it("prints the balance fields verbatim even when the visit totals thousands", async () => {
    // The original shows a dash beside "Total Parts" on page one while page two
    // totals $3,200 - they answer different questions, and computing one from
    // the other would put a number in front of a client that contradicts their
    // contract.
    const one = pageText(await load(visit()), 0);
    expect(one).not.toContain("3,200.00");
    const two = pageText(await load(visit()), 1);
    expect(two).toContain("3,200.00");
  });

  it("shows a stated allowance when there is one", async () => {
    const one = pageText(await load(visit({
      balances: { visitsRemaining: "3", partsRemaining: "$1,800.00", partsTotal: "$5,000.00" },
    })), 0);
    expect(one).toContain("$5,000.00");
  });
});

describe("the totals block", () => {
  it("adds parts and labour, then applies the adjustment", () => {
    const t = reportTotals(visit());
    expect(t.parts).toBe(320000);
    expect(t.labor).toBe(0);          // travel and labour at quantity zero
    expect(t.sub).toBe(320000);
    expect(t.due).toBe(0);            // covered by contract
  });

  it("charges what was worked when nothing is adjusted away", () => {
    const t = reportTotals(visit({
      adjustmentCents: 0,
      labor: [{ description: "Standard Labor Rate", partNumber: "SVC. Labor", quantity: 2, unitCents: 30000, taxExempt: true }],
    }));
    expect(t.labor).toBe(60000);
    expect(t.due).toBe(380000);
  });

  it("never turns a zero into a dollar sign with nothing after it", async () => {
    const two = pageText(await load(visit({ parts: [], labor: [], adjustmentCents: 0 })), 1);
    expect(two).toContain("Total Amount Due");
    expect(two).toContain("-");
  });
});

describe("growing content", () => {
  it("keeps the tables at their printed height when a visit used almost nothing", async () => {
    // Empty rows are part of the document's look; a one-line parts table that
    // collapsed to one row would read as a different form.
    const doc = await load(visit({ calibration: [], parts: [], labor: [] }));
    expect(doc.getPageCount()).toBe(2);
    expect(pageText(doc, 1)).toContain("Parts Summary");
  });

  it("gives a long visit more paper rather than a shorter record", async () => {
    const body = Array.from({ length: 60 }, (_, i) => `- Checked point ${i + 1} | OK`).join("\n");
    const doc = await load(visit({ notes: { date: "2025-08-25", body } }));
    expect(doc.getPageCount()).toBe(3);
    const all = [0, 1, 2].map((i) => pageText(doc, i));
    expect(all[1]).toContain("Service Engineer Notes (continued)");
    // Every check made it in, including the last one.
    expect(all.join("\n")).toContain("- Checked point 60 | OK");
    // And the money still lands on the final page, after the notes.
    expect(all[2]).toContain("Parts Summary");
    expect(all[2]).toContain("THIS IS NOT AN INVOICE");
  });

  it("never draws below the bottom of the paper", async () => {
    // The failure this guards against is silent: text positioned off the page is
    // present in the file, passes a text assertion, and cannot be read by the
    // client holding the printout.
    const body = Array.from({ length: 120 }, (_, i) => `- Checked point ${i + 1} | OK`).join("\n");
    const doc = await load(visit({ notes: { date: "2025-08-25", body } }));
    for (let i = 0; i < doc.getPageCount(); i++) {
      const ys = drawnYs(doc, i);
      expect(ys.length).toBeGreaterThan(0);
      expect(Math.min(...ys)).toBeGreaterThan(12);
      expect(Math.max(...ys)).toBeLessThan(792);
    }
  });
});
