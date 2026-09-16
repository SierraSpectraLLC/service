// The two renderers, against the bytes they write.
//
// The style guide is the spec; what is proved here is that the Word file and
// the PDF both carry it: Arial and Consolas where the guide says, the typed
// wordmark and the coral tag in the header, the confidentiality line in the
// footer, US Letter, and every block kind drawn without throwing - including
// the characters a PDF's standard fonts cannot draw, which are swapped
// rather than crashing the download.
//
// Set DOC_SAMPLE_DIR to also write the sample files out, for looking at.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { renderDocx } from "@/lib/docxRender";
import { renderPdf } from "@/lib/pdfRender";
import type { DocSpec } from "@/lib/docStyle";
import { quoteDocument } from "@/lib/quoteDoc";

const spec: DocSpec = {
  type: "Proposal", tag: "LABZEN PROPOSAL", client: "LabZen", number: "030304_Ar1",
  operatorName: "Sierra Spectra", contactLine: "Sierra Spectra | jrharris@sierraspectra.com",
  blocks: [
    { kind: "title", text: "Service Contract Proposal", sub: "Sciex TripleTOF 6600 · LabZen · Reno" },
    { kind: "facts", rows: [["Customer", "LabZen"], ["Date", "September 16, 2026"], ["Contact", "Dr. Ada Park"], ["Quote #", "030304_Ar1"], ["System", "6600"], ["Pricing Valid", "30 days from issue"]] },
    { kind: "head", text: "Executive Summary" },
    { kind: "para", text: "Lead with the answer → the section concludes here. Tick ✓ and a long dash — survive." },
    { kind: "sub", text: "What this covers" },
    { kind: "list", items: ["Two PM visits a year", "Remote support, business hours", "Parts to the allowance"] },
    { kind: "head", text: "Tier Comparison" },
    { kind: "para", text: "Tiers structured to fit different risk profiles.", lead: true },
    { kind: "table", head: ["", "Essential", "Standard", "Complete"], rows: [["Annual Investment", "$32,000", "$41,000", "$46,000"], ["Preventive Maintenance", "2 / year", "2 / year", "4 / year"]], lead: true, highlightCol: 2 },
    { kind: "head", text: "Pricing" },
    { kind: "table", head: ["Description", "Part no.", "Qty", "Unit price", "Amount"], rows: [["Full service contract", "SVC-12", "12 mo", "$2,000", "$24,000"]], foot: [["Total", "", "", "", "$24,000"]], align: ["l", "l", "r", "r", "r"], mono: [1] },
    { kind: "head", text: "What We Recommend" },
    { kind: "callout", text: "Recommended Tier: Standard ($41,000/year)", body: ["It covers the two visits the lab actually books.", "The parts allowance matches last year's spend."] },
    ...Array.from({ length: 40 }, (_, i) => ({ kind: "para" as const, text: `Paragraph ${i + 1} of a long section, so the document runs onto a second and third page and the header, the bar and the footer are drawn again there.` })),
  ],
};

const SLOW = 30_000;
const out = process.env.DOC_SAMPLE_DIR;

describe("renderDocx", () => {
  it("writes a Word file in the house style", async () => {
    const buf = await renderDocx(spec);
    if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, "sample.docx"), buf); }
    const zip = await JSZip.loadAsync(buf);
    const doc = await zip.file("word/document.xml")!.async("string");
    const header = await zip.file("word/header1.xml")!.async("string");
    const footer = await zip.file("word/footer1.xml")!.async("string");
    const styles = await zip.file("word/styles.xml")!.async("string");

    expect(doc).toContain("Service Contract Proposal");
    expect(doc).toContain("Recommended Tier: Standard");
    expect(doc).toContain("SVC-12");
    expect(doc).toContain('w:ascii="Consolas"');     // the part number
    expect(doc).toContain('w:fill="FDF2F1"');        // the recommended column
    expect(doc).toContain('w:fill="F8F7F5"');        // the table header row
    expect(doc).toContain('<w:color w:val="E8756A"/>'); // an H1
    expect(styles).toContain('w:ascii="Arial"');
    expect(header).toContain("S I E R R A  •  S P E C T R A");
    expect(header).toContain("LABZEN PROPOSAL");
    expect(header).toContain('w:fill="9B8EB8"');     // the last spectrum segment
    expect(footer).toContain("CONFIDENTIAL");
    expect(footer).toContain("PAGE");                // the page number field
    // US Letter with the guide's margins, in twips.
    expect(doc).toMatch(/w:pgSz w:w="12240" w:h="15840"/);
    expect(doc).toMatch(/w:pgMar[^>]*w:top="1440"[^>]*w:right="1080"[^>]*w:bottom="900"[^>]*w:left="1080"/);
    // This sample is a proposal but sets no section breaks, so the Word file
    // carries none either - the flag is the document's, not the renderer's.
    expect(doc).not.toContain("w:pageBreakBefore");
  }, SLOW);

  it("breaks the page before each section when the document asks, and never before the first block", async () => {
    const zip = await JSZip.loadAsync(await renderDocx({
      ...spec, sectionBreaks: true,
      blocks: [
        { kind: "title", text: "Service Contract Proposal", sub: "" },
        { kind: "head", text: "One" },
        { kind: "para", text: "A sentence." },
        { kind: "head", text: "Two" },
      ],
    }));
    const doc = await zip.file("word/document.xml")!.async("string");
    expect([...doc.matchAll(/w:pageBreakBefore/g)]).toHaveLength(2);
    // The title opens the file; a break there would be a blank first sheet.
    expect(doc.indexOf("w:pageBreakBefore")).toBeGreaterThan(doc.indexOf("Service Contract Proposal"));
  }, SLOW);
});

describe("renderPdf", () => {
  it("writes a US Letter PDF that runs to more than one page and names itself", async () => {
    const bytes = await renderPdf(spec);
    if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, "sample.pdf"), bytes); }
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    const { width, height } = pdf.getPage(0).getSize();
    expect([width, height]).toEqual([612, 792]);
    expect(pdf.getTitle()).toBe("Proposal 030304_Ar1");
    expect(pdf.getAuthor()).toBe("Sierra Spectra");
  }, SLOW);

  it("draws a quote - the summary block, the pricing table with its total, the terms", async () => {
    const blocks = quoteDocument({
      number: "030304_In1", title: "12mo Full Service Contract Renewal", customer: "LabZen", contact: "Dr. Ada Park",
      date: "September 16, 2026", pricingValid: "through October 16, 2026",
      greeting: "Thank you for considering us. Here are the specifics of the job:",
      specs: {
        left: [{ text: "Coverage", sub: false }, { text: "Two PM visits a year", sub: true }, { text: "Remote support, business hours", sub: true }],
        right: [{ text: "Response", sub: false }, { text: "Next business day", sub: true }],
      },
      systems: [{ name: "Sciex TripleTOF", model: "6600", tag: "T-003" }],
      lines: [
        { description: "Full service contract\nCovers the source and the vacuum train", detail: "", partNumber: "SVC-12", qty: 12, unit: "mo", unitCents: 200_000, covered: false, coveredBy: "" },
        { description: "Source cleaning kit", detail: "", partNumber: "K-401", qty: 1, unit: "", unitCents: 42_000, covered: true, coveredBy: "AGR-2026-01" },
        { description: "Onsite engineering, additional day", detail: "", partNumber: "", qty: 2, unit: "day", unitCents: 180_000, covered: false, coveredBy: "" },
      ],
      subtotalCents: 2_760_000, discountCents: 276_000, discountLabel: "Loyalty discount (10%)", totalCents: 2_484_000,
      depositPct: 100, depositCents: 2_484_000, note: "Renews on the same terms unless either party gives 30 days notice.",
      expiresOn: "October 16, 2026",
    });
    const q: DocSpec = { ...spec, type: "Quote", tag: "QUOTE 030304_In1", number: "030304_In1", blocks };
    const bytes = await renderPdf(q);
    if (out) writeFileSync(join(out, "quote.pdf"), bytes);
    const docx = await renderDocx(q);
    if (out) writeFileSync(join(out, "quote.docx"), docx);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  }, SLOW);

  it("puts each section on a page of its own when the document asks for it", async () => {
    // A proposal is read a section at a time, and its title and summary
    // block are its cover. A quote sets none of this - the same rule there
    // would turn one page of price into five.
    const heads = ["One", "Two", "Three"];
    const paged = await renderPdf({
      ...spec, sectionBreaks: true,
      blocks: [
        { kind: "title", text: "Service Contract Proposal", sub: "" },
        { kind: "facts", rows: [["Customer", "LabZen"]] },
        ...heads.flatMap((text) => ([
          { kind: "head" as const, text },
          { kind: "para" as const, text: "A sentence under it." },
        ])),
      ],
    });
    // The cover, then one page per section - not a blank sheet in front.
    expect((await PDFDocument.load(paged)).getPageCount()).toBe(heads.length + 1);

    const together = await renderPdf({
      ...spec,
      blocks: [
        { kind: "title", text: "Service Quote", sub: "" },
        ...heads.flatMap((text) => ([
          { kind: "head" as const, text },
          { kind: "para" as const, text: "A sentence under it." },
        ])),
      ],
    });
    expect((await PDFDocument.load(together)).getPageCount()).toBe(1);
  }, SLOW);

  it("does not throw on the characters the standard fonts lack", async () => {
    const bytes = await renderPdf({ ...spec, blocks: [{ kind: "para", text: "\u{1F600} → ✓ ≥ café" }] });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  }, SLOW);
});
