// Merge several PDFs into one packet: an optional cover page, a header bar
// naming each source document, and continuous page numbering - the thing a
// validation binder needs so "page 14 of 31" means something after printing.
//
// Pure over bytes: callers fetch the files, this composes them. pdf-lib only,
// which is plain JavaScript - no native binaries, so it runs in a serverless
// function (and in vitest, where the tests build real PDFs and re-parse the
// output rather than trusting that drawing calls happened).
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

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

// ── Page-level assembly (the PDF studio) ────────────────────────────────────

/** One page of the working set: which source document, which page, how turned. */
export type PageRef = {
  docIx: number;
  pageIx: number;
  /** Extra quarter-turns applied on top of the page's own rotation: 0|90|180|270. */
  rotate: 0 | 90 | 180 | 270;
  /**
   * Header-bar title for THIS page, overriding its document's. Blank or absent
   * inherits the document title, which is what most pages want - a nine-page
   * report is one title, typed once. The override is for the pages that carry
   * their own meaning: "Leak check - post-repair", "As-found chromatogram".
   */
  title?: string;
};

/**
 * Compose an arbitrary page list drawn from several documents - reordered,
 * subset, interleaved, rotated, individually titled - into one PDF, with a
 * cover page, header bars and continuous page numbering.
 *
 * Numbering is over the finished packet, not the sources: "Page 7 of 31" means
 * the seventh sheet you'd hold, cover included. Titles resolve per page, so a
 * packet can read "As-found chromatogram" on one sheet and "Post-repair" on the
 * next even though both came out of the same report.
 *
 * Runs in the browser as well as in Node (pdf-lib is plain JS both places):
 * the studio assembles client-side, so a 60MB working set never has to fit
 * through a serverless request body.
 */
export async function assemblePdf(
  docs: { bytes: Uint8Array | ArrayBuffer; title: string }[],
  pages: PageRef[],
  options: CombineOptions,
): Promise<Uint8Array> {
  if (!pages.length) throw new Error("Nothing to assemble - the page list is empty");
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);

  // Load each source once however many of its pages are used. Before the cover,
  // so a page list naming a document nobody supplied fails immediately.
  const used = [...new Set(pages.map((p) => p.docIx))];
  const loaded = new Map<number, PDFDocument>();
  for (const ix of used) {
    if (!docs[ix]) throw new Error(`Page list names document ${ix + 1}, which wasn't provided`);
    loaded.set(ix, await PDFDocument.load(docs[ix].bytes, { ignoreEncryption: true }));
  }

  // Every page's header, resolved up front: the page's own title wins, its
  // document's is the fallback, "" means no bar. Kept as text rather than as a
  // document index because a title is page-level - two pages of one report can
  // say different things - and because the cover's contents list is built from
  // this same array, so a binder's contents and its header bars cannot disagree.
  const coverOffset = options.coverTitle ? 1 : 0;
  const heading = new Array<string>(coverOffset).fill("")
    .concat(pages.map((ref) => (ref.title ?? "").trim() || docs[ref.docIx].title));

  if (options.coverTitle) {
    const cover = out.addPage([612, 792]);
    const { width, height } = cover.getSize();
    cover.drawText(fit(options.coverTitle, 60), { x: 72, y: height - 180, size: 24, font: bold, color: NAVY, maxWidth: width - 144 });
    cover.drawLine({ start: { x: 72, y: height - 200 }, end: { x: width - 72, y: height - 200 }, thickness: 2, color: NAVY });
    options.coverLines.filter(Boolean).forEach((line, i) => {
      cover.drawText(fit(line, 90), { x: 72, y: height - 232 - i * 20, size: 12, font, color: MUT });
    });
    // Contents by section: each run of consecutive pages sharing a header, and
    // the packet page it opens on. With no per-page titles that collapses to one
    // line per source document, which is what it always was - plus the page
    // number a printed binder needs to be navigable.
    const runs: { title: string; page: number }[] = [];
    heading.forEach((h, i) => {
      if (i < coverOffset) return;
      if (!runs.length || runs[runs.length - 1].title !== h) runs.push({ title: h, page: i + 1 });
    });
    const tocTop = height - 232 - options.coverLines.length * 20 - 36;
    cover.drawText("Contents", { x: 72, y: tocTop, size: 11, font: bold, color: NAVY });
    // A 60-section packet used to draw its contents off the bottom of the page.
    // Fill what fits and say how much didn't.
    const room = Math.max(1, Math.floor((tocTop - 20 - 72) / 16) + 1);
    const shown = runs.length > room ? runs.slice(0, room - 1) : runs;
    shown.forEach((run, i) => {
      cover.drawText(fit(`${i + 1}.  ${run.title || "(untitled)"} - p. ${run.page}`, 88), {
        x: 72, y: tocTop - 20 - i * 16, size: 10, font, color: MUT,
      });
    });
    if (shown.length < runs.length) {
      cover.drawText(`and ${runs.length - shown.length} more section${runs.length - shown.length === 1 ? "" : "s"}`, {
        x: 72, y: tocTop - 20 - shown.length * 16, size: 10, font, color: MUT,
      });
    }
  }

  for (const ref of pages) {
    const src = loaded.get(ref.docIx)!;
    if (ref.pageIx < 0 || ref.pageIx >= src.getPageCount()) {
      throw new Error(`Document ${ref.docIx + 1} has no page ${ref.pageIx + 1}`);
    }
    const [page] = await out.copyPages(src, [ref.pageIx]);
    if (ref.rotate) {
      const current = page.getRotation().angle;
      page.setRotation(degrees(((current + ref.rotate) % 360) as 0 | 90 | 180 | 270));
    }
    out.addPage(page);
  }

  const total = out.getPageCount();
  for (let n = 0; n < total; n++) {
    const page = out.getPage(n);
    const { width, height } = page.getSize();
    if (options.headers && heading[n]) {
      page.drawRectangle({ x: 0, y: height - 22, width, height: 22, color: rgb(0.96, 0.97, 0.99), opacity: 0.9 });
      page.drawLine({ start: { x: 0, y: height - 22 }, end: { x: width, y: height - 22 }, thickness: 0.7, color: LINE });
      page.drawText(fit(heading[n], 95), { x: 14, y: height - 15, size: 8, font: bold, color: NAVY });
    }
    if (options.pageNumbers) {
      const label = `Page ${n + 1} of ${total}`;
      page.drawText(label, { x: width - 14 - font.widthOfTextAtSize(label, 8), y: 8, size: 8, font, color: MUT });
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
