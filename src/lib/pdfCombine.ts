// Merge several PDFs into one packet: an optional cover page, a header bar
// naming each source document, and continuous page numbering - the thing a
// validation binder needs so "page 14 of 31" means something after printing.
//
// Pure over bytes: callers fetch the files, this composes them. pdf-lib only,
// which is plain JavaScript - no native binaries, so it runs in a serverless
// function (and in vitest, where the tests build real PDFs and re-parse the
// output rather than trusting that drawing calls happened).
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export type CombineItem = {
  bytes: Uint8Array | ArrayBuffer;
  /** Header-bar title for this document's pages. "" = no header on these. */
  title: string;
};

export type CombineOptions = {
  /** Cover page headline. "" = no cover page. */
  coverTitle: string;
  /** Cover page lines under the headline (system id, client, date, author). */
  coverLines: string[];
  /** "Page N of M" in every footer. */
  pageNumbers: boolean;
  /** Draw each document's title as a header bar on its pages. */
  headers: boolean;
};

const NAVY = rgb(0.09, 0.165, 0.29);
const MUT = rgb(0.39, 0.45, 0.55);
const LINE = rgb(0.85, 0.88, 0.92);

/** Trim to what fits; a header bar must never wrap onto the page's content. */
const fit = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export async function combinePdfs(items: CombineItem[], options: CombineOptions): Promise<Uint8Array> {
  if (!items.length) throw new Error("Nothing to combine");
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);

  if (options.coverTitle) {
    const cover = out.addPage([612, 792]); // US Letter - the shop prints on it
    const { width, height } = cover.getSize();
    cover.drawText(fit(options.coverTitle, 60), {
      x: 72, y: height - 180, size: 24, font: bold, color: NAVY,
      maxWidth: width - 144,
    });
    cover.drawLine({ start: { x: 72, y: height - 200 }, end: { x: width - 72, y: height - 200 }, thickness: 2, color: NAVY });
    options.coverLines.filter(Boolean).forEach((line, i) => {
      cover.drawText(fit(line, 90), { x: 72, y: height - 232 - i * 20, size: 12, font, color: MUT });
    });
    // Contents list, so a printed binder can be navigated from page one.
    const tocTop = height - 232 - options.coverLines.length * 20 - 36;
    cover.drawText("Contents", { x: 72, y: tocTop, size: 11, font: bold, color: NAVY });
    items.forEach((item, i) => {
      cover.drawText(fit(`${i + 1}.  ${item.title || "(untitled document)"}`, 88), {
        x: 72, y: tocTop - 20 - i * 16, size: 10, font, color: MUT,
      });
    });
  }

  // Copy every page, remembering which source document each came from so the
  // header pass can label it.
  const owner: number[] = new Array(options.coverTitle ? 1 : 0).fill(-1);
  for (let i = 0; i < items.length; i++) {
    const src = await PDFDocument.load(items[i].bytes, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) { out.addPage(p); owner.push(i); }
  }

  const total = out.getPageCount();
  for (let n = 0; n < total; n++) {
    const page = out.getPage(n);
    const { width, height } = page.getSize();
    const docIx = owner[n];
    if (options.headers && docIx >= 0 && items[docIx].title) {
      // A translucent-feel bar ABOVE the content area is impossible without
      // reflowing the source, so the bar sits in the top margin: most lab
      // reports leave one, and a title over content still beats no title.
      page.drawRectangle({ x: 0, y: height - 22, width, height: 22, color: rgb(0.96, 0.97, 0.99), opacity: 0.9 });
      page.drawLine({ start: { x: 0, y: height - 22 }, end: { x: width, y: height - 22 }, thickness: 0.7, color: LINE });
      page.drawText(fit(items[docIx].title, 95), { x: 14, y: height - 15, size: 8, font: bold, color: NAVY });
      page.drawText(`Document ${docIx + 1} of ${items.length}`, {
        x: width - 110, y: height - 15, size: 8, font, color: MUT,
      });
    }
    if (options.pageNumbers) {
      const label = `Page ${n + 1} of ${total}`;
      page.drawText(label, {
        x: width - 14 - font.widthOfTextAtSize(label, 8), y: 8, size: 8, font, color: MUT,
      });
    }
  }

  return out.save();
}

/** Cheap magic-number check so a mislabeled upload fails with words, not a parser stack. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  // %PDF- ; some generators pad a BOM or junk before it, so scan the first 1kb.
  const head = bytes.subarray(0, 1024);
  for (let i = 0; i + 4 < head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true;
  }
  return false;
}
