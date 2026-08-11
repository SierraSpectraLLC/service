import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { combinePdfs, looksLikePdf } from "@/lib/pdfCombine";

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
