import { describe, expect, it } from "vitest";
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { assemblePdf, combinePdfs, looksLikePdf } from "@/lib/pdfCombine";

/**
 * The text actually drawn on one page of the output, read back out of its
 * content stream. Asserting on page counts alone would pass a build that
 * silently stopped drawing headers, which is exactly the regression that
 * matters once titles are per page.
 */
function pageText(doc: PDFDocument, ix: number): string {
  const contents = doc.getPage(ix).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  let raw = "";
  for (const s of streams) {
    if (s instanceof PDFRawStream) raw += Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
  }
  // pdf-lib writes show-text operands as hex strings: <48656C6C6F> Tj
  return [...raw.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)]
    .map((m) => winAnsi(Buffer.from(m[1], "hex")))
    .join("\n");
}

// The standard fonts encode WinAnsi, which differs from latin1 exactly in the
// 0x80-0x9F range - where the punctuation this library draws happens to live.
const WIN_ANSI: Record<number, string> = { 0x85: "…", 0x91: "‘", 0x92: "’", 0x96: "–", 0x97: "—" };
const winAnsi = (buf: Buffer) =>
  [...buf].map((b) => WIN_ANSI[b] ?? String.fromCharCode(b)).join("");

/** A real n-page PDF, built rather than fixtured, so the test owns its input. */
async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  return doc.save();
}

const OPTS = { coverTitle: "", coverLines: [], pageNumbers: true, headers: true };

describe("combinePdfs", () => {
  it("concatenates in order and counts pages correctly", async () => {
    const out = await combinePdfs(
      [{ bytes: await makePdf(2), title: "A" }, { bytes: await makePdf(3), title: "B" }],
      OPTS,
    );
    const parsed = await PDFDocument.load(out);
    expect(parsed.getPageCount()).toBe(5);
    expect(looksLikePdf(out)).toBe(true);
  });

  it("adds a cover page only when asked", async () => {
    const src = [{ bytes: await makePdf(2), title: "Report" }];
    const bare = await PDFDocument.load(await combinePdfs(src, OPTS));
    expect(bare.getPageCount()).toBe(2);
    const covered = await PDFDocument.load(await combinePdfs(
      [{ bytes: await makePdf(2), title: "Report" }],
      { ...OPTS, coverTitle: "Validation packet", coverLines: ["SS-1042", "LabZen"] },
    ));
    expect(covered.getPageCount()).toBe(3);
  });

  it("refuses an empty combine", async () => {
    await expect(combinePdfs([], OPTS)).rejects.toThrow("Nothing to combine");
  });

  it("survives odd page sizes without normalizing them", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([842, 595]); // A4 landscape
    const out = await PDFDocument.load(await combinePdfs(
      [{ bytes: await doc.save(), title: "wide" }], OPTS,
    ));
    const { width, height } = out.getPage(0).getSize();
    expect(Math.round(width)).toBe(842);
    expect(Math.round(height)).toBe(595);
  });
});

describe("looksLikePdf", () => {
  it("accepts a real header, even padded", async () => {
    expect(looksLikePdf(await makePdf(1))).toBe(true);
    const padded = new Uint8Array([0xef, 0xbb, 0xbf, ...(await makePdf(1))]);
    expect(looksLikePdf(padded)).toBe(true);
  });

  it("rejects not-a-pdf", () => {
    expect(looksLikePdf(new TextEncoder().encode("PNG or whatever"))).toBe(false);
    expect(looksLikePdf(new Uint8Array(0))).toBe(false);
  });
});

describe("assemblePdf (page-level)", () => {

  /** Pages tagged by size so the output order is verifiable. */
  async function sizedPdf(widths: number[]): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    for (const w of widths) doc.addPage([w, 700]);
    return doc.save();
  }

  it("reorders, subsets and interleaves across documents", async () => {
    const a = await sizedPdf([100, 101, 102]); // pages identified by width
    const b = await sizedPdf([200, 201]);
    const out = await PDFDocument.load(await assemblePdf(
      [{ bytes: a, title: "A" }, { bytes: b, title: "B" }],
      [
        { docIx: 1, pageIx: 1, rotate: 0 },  // B2
        { docIx: 0, pageIx: 2, rotate: 0 },  // A3
        { docIx: 0, pageIx: 0, rotate: 0 },  // A1 (A2 dropped)
      ],
      { coverTitle: "", coverLines: [], pageNumbers: true, headers: true },
    ));
    expect(out.getPageCount()).toBe(3);
    expect([0, 1, 2].map((i) => Math.round(out.getPage(i).getSize().width))).toEqual([201, 102, 100]);
  });

  it("applies rotation on top of the page's own", async () => {
    const src = await PDFDocument.create();
    src.addPage([300, 700]);
    const out = await PDFDocument.load(await assemblePdf(
      [{ bytes: await src.save(), title: "t" }],
      [{ docIx: 0, pageIx: 0, rotate: 90 }],
      { coverTitle: "", coverLines: [], pageNumbers: false, headers: false },
    ));
    expect(out.getPage(0).getRotation().angle).toBe(90);
  });

  it("names an out-of-range page instead of crashing on it", async () => {
    const a = await sizedPdf([100]);
    await expect(assemblePdf(
      [{ bytes: a, title: "A" }],
      [{ docIx: 0, pageIx: 5, rotate: 0 }],
      { coverTitle: "", coverLines: [], pageNumbers: false, headers: false },
    )).rejects.toThrow("no page 6");
  });

  it("refuses an empty page list", async () => {
    await expect(assemblePdf([], [], { coverTitle: "", coverLines: [], pageNumbers: false, headers: false }))
      .rejects.toThrow("empty");
  });

  it("cover page counts pages per document in first-use order", async () => {
    const a = await sizedPdf([100, 101]);
    const out = await PDFDocument.load(await assemblePdf(
      [{ bytes: a, title: "Calibration" }],
      [{ docIx: 0, pageIx: 0, rotate: 0 }, { docIx: 0, pageIx: 1, rotate: 0 }],
      { coverTitle: "Packet", coverLines: ["SS-1"], pageNumbers: true, headers: true },
    ));
    expect(out.getPageCount()).toBe(3); // cover + 2
  });

  it("gives each page its own header when asked, and falls back to the document's", async () => {
    const a = await sizedPdf([100, 101, 102]);
    const out = await PDFDocument.load(await assemblePdf(
      [{ bytes: a, title: "Leak check" }],
      [
        { docIx: 0, pageIx: 0, rotate: 0, title: "As found" },
        { docIx: 0, pageIx: 1, rotate: 0 },                      // inherits
        { docIx: 0, pageIx: 2, rotate: 0, title: "Post-repair" },
      ],
      { coverTitle: "", coverLines: [], pageNumbers: false, headers: false },
    ));
    // headers: false means no bar anywhere, whatever the titles say.
    expect(pageText(out, 0)).not.toContain("As found");

    const withBars = await PDFDocument.load(await assemblePdf(
      [{ bytes: await sizedPdf([100, 101, 102]), title: "Leak check" }],
      [
        { docIx: 0, pageIx: 0, rotate: 0, title: "As found" },
        { docIx: 0, pageIx: 1, rotate: 0 },
        { docIx: 0, pageIx: 2, rotate: 0, title: "Post-repair" },
      ],
      { coverTitle: "", coverLines: [], pageNumbers: false, headers: true },
    ));
    expect(pageText(withBars, 0)).toContain("As found");
    expect(pageText(withBars, 1)).toContain("Leak check");
    expect(pageText(withBars, 2)).toContain("Post-repair");
  });

  it("treats a blank or whitespace page title as 'inherit', not as 'no header'", async () => {
    const out = await PDFDocument.load(await assemblePdf(
      [{ bytes: await sizedPdf([100, 101]), title: "Report" }],
      [{ docIx: 0, pageIx: 0, rotate: 0, title: "" }, { docIx: 0, pageIx: 1, rotate: 0, title: "   " }],
      { coverTitle: "", coverLines: [], pageNumbers: false, headers: true },
    ));
    expect(pageText(out, 0)).toContain("Report");
    expect(pageText(out, 1)).toContain("Report");
  });

  it("numbers the finished packet, cover included, not the sources", async () => {
    const out = await PDFDocument.load(await assemblePdf(
      [{ bytes: await sizedPdf([100]), title: "A" }, { bytes: await sizedPdf([200, 201]), title: "B" }],
      [{ docIx: 1, pageIx: 1, rotate: 0 }, { docIx: 0, pageIx: 0, rotate: 0 }],
      { coverTitle: "Packet", coverLines: [], pageNumbers: true, headers: false },
    ));
    expect(out.getPageCount()).toBe(3);
    expect(pageText(out, 0)).toContain("Page 1 of 3"); // the cover is sheet one
    expect(pageText(out, 1)).toContain("Page 2 of 3");
    expect(pageText(out, 2)).toContain("Page 3 of 3");
  });

  it("lists contents by section with the page each opens on", async () => {
    const out = await PDFDocument.load(await assemblePdf(
      [{ bytes: await sizedPdf([100, 101, 102]), title: "Report" }],
      [
        { docIx: 0, pageIx: 0, rotate: 0, title: "Intro" },
        { docIx: 0, pageIx: 1, rotate: 0, title: "Data" },
        { docIx: 0, pageIx: 2, rotate: 0, title: "Data" }, // same run, one entry
      ],
      { coverTitle: "Packet", coverLines: ["SS-1"], pageNumbers: true, headers: true },
    ));
    const cover = pageText(out, 0);
    expect(cover).toContain("1.  Intro - p. 2");
    expect(cover).toContain("2.  Data - p. 3");
    expect(cover).not.toContain("3.  ");
  });

  it("keeps a very long contents list on the cover page instead of drawing off it", async () => {
    // 60 differently-titled pages: the list has to stop and say how many it
    // didn't show, or it draws into negative y - off the bottom of the sheet.
    const src = await sizedPdf(Array.from({ length: 60 }, (_, i) => 100 + i));
    const out = await PDFDocument.load(await assemblePdf(
      [{ bytes: src, title: "Report" }],
      Array.from({ length: 60 }, (_, i) => ({ docIx: 0, pageIx: i, rotate: 0 as const, title: `Section ${i + 1}` })),
      { coverTitle: "Packet", coverLines: ["SS-1"], pageNumbers: true, headers: true },
    ));
    const cover = pageText(out, 0);
    expect(cover).toContain("1.  Section 1 - p. 2");
    expect(cover).toMatch(/and \d+ more sections/);
    // The last entry drawn must still be the last one that fits, not entry 60.
    expect(cover).not.toContain("Section 60 - p. 61");
  });
});
