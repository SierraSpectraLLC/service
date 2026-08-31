// Several scanned pages, bound as the one file they were always going to be.
//
// A receipt is one photo, but a DOCUMENT - a signed service contract, a vendor
// packet, a calibration cert - is four or five, and five loose JPEGs named
// IMG_0421-scan.jpg are not a document anybody forwards. What Lens and every
// phone scanner taught people to expect is: keep tapping pages, get one PDF.
//
// pdf-lib does the binding, and it earns its place twice over: it is ALREADY a
// dependency (lib/reportPdf, lib/pdfCombine build packets with it on the
// server), and it is plain JavaScript, so the same call runs in the browser -
// where the pages are, since scans go straight from the tab to Blob storage
// without passing a server of ours (see lib/scanDoc, WHERE THE WORK HAPPENS).
//
// It is loaded on demand, not bundled into the dialog: the import happens when
// somebody finishes a multi-page scan, which keeps the scanner's own chunk
// small and costs nothing on the single-page path that never binds anything.
//
// The geometry is pure and lives apart from the binding so it can be tested
// with literals - same split as lib/scanDoc.

/** One captured page, as the JPEG the scanner encoded. */
export type ScanJpegPage = { bytes: Uint8Array };

/**
 * The long edge of every page, in PDF points. 792pt is 11 inches - US Letter's
 * long side, which is what the shop prints on and what viewers open at a sane
 * zoom. Points are only units: the pixels underneath are untouched.
 */
export const PAGE_LONG_EDGE_PT = 792;

/**
 * A page box for a scan of the given pixel size.
 *
 * Every page gets the SAME long edge, whatever resolution its photo happened
 * to be - a packet whose third page is suddenly half the size of the second
 * reads like a mistake in every viewer. Aspect is the scan's own: a receipt
 * page is tall and narrow, a folio landscape, and forcing either into a Letter
 * rectangle would letterbox the image or crop it.
 */
export function pageBoxFor(
  width: number, height: number, longEdge = PAGE_LONG_EDGE_PT,
): { width: number; height: number } {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const scale = longEdge / Math.max(w, h);
  return { width: w * scale, height: h * scale };
}

/**
 * Bind the pages, in order, into one PDF.
 *
 * Each JPEG is EMBEDDED, not re-encoded: pdf-lib copies the compressed bytes
 * into the file as a DCTDecode stream, so binding five 200 KB scans makes a
 * ~1 MB PDF and loses nothing to a second compression pass.
 */
export async function pagesToPdf(pages: ScanJpegPage[], title: string): Promise<Uint8Array> {
  if (!pages.length) throw new Error("A document needs at least one page");
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  for (const p of pages) {
    const img = await doc.embedJpg(p.bytes);
    const box = pageBoxFor(img.width, img.height);
    const page = doc.addPage([box.width, box.height]);
    page.drawImage(img, { x: 0, y: 0, width: box.width, height: box.height });
  }
  return doc.save();
}

/** `IMG_0421.HEIC` becomes `IMG_0421-scan.pdf` - the sibling of scanName. */
export const scanPdfName = (name: string): string =>
  `${(name.replace(/\.[^.]+$/, "") || "document").slice(0, 60)}-scan.pdf`;
