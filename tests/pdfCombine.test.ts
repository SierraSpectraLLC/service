import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { assemblePdf, combinePdfs, looksLikePdf } from "@/lib/pdfCombine";

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
});
