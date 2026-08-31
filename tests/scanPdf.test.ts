// Binding scanned pages into one PDF - re-parsed, not trusted.
//
// Same discipline as reportPdf and pdfCombine: pdf-lib is plain JavaScript, so
// the tests load the produced bytes back and read what a viewer would see -
// page count, page boxes, title - rather than asserting that drawing calls
// happened. The geometry (pageBoxFor) is pure and tested with literals,
// because a wrong page box is the quiet failure: every page renders, just
// letterboxed or clipped, and nobody looks twice at a receipt PDF.
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { PAGE_LONG_EDGE_PT, pageBoxFor, pagesToPdf, scanPdfName } from "@/lib/scanPdf";

/* A real 1x1 JPEG - the smallest thing embedJpg will parse a SOF header out
   of. What matters is that it is a genuine JPEG, not that it shows anything. */
const TINY_JPEG = Uint8Array.from(atob(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
), (c) => c.charCodeAt(0));

describe("the page box", () => {
  it("gives every page the same long edge, whatever the photo's resolution", () => {
    // A packet whose third page came from an older phone must not be a third
    // the size of the others in the viewer.
    const big = pageBoxFor(4000, 3000);
    const small = pageBoxFor(1100, 2200);
    expect(Math.max(big.width, big.height)).toBeCloseTo(PAGE_LONG_EDGE_PT);
    expect(Math.max(small.width, small.height)).toBeCloseTo(PAGE_LONG_EDGE_PT);
  });

  it("keeps the scan's own aspect - tall receipts stay tall, folios stay wide", () => {
    const tall = pageBoxFor(800, 2200);
    expect(tall.height).toBeCloseTo(PAGE_LONG_EDGE_PT);
    expect(tall.width / tall.height).toBeCloseTo(800 / 2200);
    const wide = pageBoxFor(2200, 1400);
    expect(wide.width).toBeCloseTo(PAGE_LONG_EDGE_PT);
    expect(wide.height / wide.width).toBeCloseTo(1400 / 2200);
  });

  it("survives degenerate sizes rather than making a zero-area page", () => {
    const b = pageBoxFor(0, 0);
    expect(b.width).toBeGreaterThan(0);
    expect(b.height).toBeGreaterThan(0);
  });
});

describe("the binding", () => {
  it("makes one page per scan, in the order they were captured", async () => {
    const bytes = await pagesToPdf(
      [{ bytes: TINY_JPEG }, { bytes: TINY_JPEG }, { bytes: TINY_JPEG }],
      "SS-1042 service contract",
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getTitle()).toBe("SS-1042 service contract");
    // The 1x1 source is square, so every page box is the full long edge both ways.
    for (const page of doc.getPages()) {
      expect(page.getWidth()).toBeCloseTo(PAGE_LONG_EDGE_PT);
      expect(page.getHeight()).toBeCloseTo(PAGE_LONG_EDGE_PT);
    }
  });

  it("embeds the JPEG rather than repainting it", async () => {
    // The compressed bytes must survive into the file as a DCTDecode stream -
    // that is what keeps a five-page packet near the sum of its JPEGs instead
    // of a second compression pass's worth bigger and blurrier.
    const bytes = await pagesToPdf([{ bytes: TINY_JPEG }], "x");
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).toContain("DCTDecode");
  });

  it("refuses an empty document", async () => {
    await expect(pagesToPdf([], "x")).rejects.toThrow(/at least one page/);
  });
});

describe("the name", () => {
  it("is the photo's own name, said as a scan", () => {
    expect(scanPdfName("IMG_0421.HEIC")).toBe("IMG_0421-scan.pdf");
    expect(scanPdfName("")).toBe("document-scan.pdf");
  });
});
