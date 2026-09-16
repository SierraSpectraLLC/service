// A document as the PDF a client is sent, in the house style.
//
// "Send clients PDFs. Keep the .docx internal." So the PDF is the copy that
// matters, and it is drawn here from the same blocks and the same
// lib/docStyle the Word file is, rather than printed from a browser whose
// margins and fonts nobody controls. pdf-lib only, which is plain
// JavaScript: no headless browser, no LibreOffice, so this runs in a
// serverless function and in vitest, where the test re-parses the output.
//
// Helvetica stands in for Arial and Courier for Consolas - the fourteen
// standard fonts are what a PDF can rely on without embedding a typeface the
// shop does not have a licence to ship. The metrics are close enough that
// the guide's sizes read as the guide's sizes.
//
// One cursor, top to bottom. Every block asks for the room it needs and
// gets a new page when there is none; a heading keeps with what follows it,
// and a table repeats its header row on the page it continues onto.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { DOC_COLOR, PAGE, SIZE, SPECTRUM, cellIndent, columnShares, footerLine2, winAnsi, wordmark, type DocSpec } from "@/lib/docStyle";
import type { ProposalBlock } from "@/lib/proposal";

const hex = (h: string): RGB => rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
const C = {
  ink: hex(DOC_COLOR.ink), coral: hex(DOC_COLOR.coral), slate: hex(DOC_COLOR.slate), mist: hex(DOC_COLOR.mist),
  sky: hex(DOC_COLOR.sky), paper: hex(DOC_COLOR.paper), blush: hex(DOC_COLOR.blush), line: hex(DOC_COLOR.line),
};
const TEXT_W = PAGE.width - PAGE.left - PAGE.right;
const TOP = PAGE.height - PAGE.top;
const BOTTOM = PAGE.bottom;
const LINE = 1.15;
const PAD = 4;

type Fonts = { reg: PDFFont; bold: PDFFont; ital: PDFFont; mono: PDFFont };

/** Wrap on words to a width in points. A word longer than the line is cut rather than lost. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of winAnsi(text).split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(""); continue; }
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
      if (line) out.push(line);
      line = w;
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}

class Sheet {
  page!: PDFPage;
  y = TOP;
  pageNo = 0;
  constructor(readonly doc: PDFDocument, readonly f: Fonts, readonly spec: DocSpec) { this.newPage(); }

  newPage() {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.pageNo += 1;
    this.y = TOP;
    this.frame();
  }

  /** The header, the spectrum bar and the footer, on every page. */
  frame() {
    const p = this.page;
    const hy = PAGE.height - PAGE.headerFromEdge - SIZE.wordmark;
    p.drawText(winAnsi(wordmark(this.spec.operatorName)), { x: PAGE.left, y: hy, size: SIZE.wordmark, font: this.f.bold, color: C.ink });
    const tag = winAnsi(this.spec.tag);
    p.drawText(tag, { x: PAGE.width - PAGE.right - this.f.reg.widthOfTextAtSize(tag, SIZE.tag), y: hy, size: SIZE.tag, font: this.f.reg, color: C.coral });
    const barY = hy - 6 - PAGE.barHeight;
    const seg = TEXT_W / SPECTRUM.length;
    SPECTRUM.forEach((h, i) => p.drawRectangle({ x: PAGE.left + i * seg, y: barY, width: seg, height: PAGE.barHeight, color: hex(h) }));
    const l1 = winAnsi(this.spec.contactLine);
    const l2 = winAnsi(footerLine2(this.spec.client, this.pageNo));
    const fy = PAGE.footerFromEdge;
    p.drawText(l1, { x: (PAGE.width - this.f.reg.widthOfTextAtSize(l1, SIZE.footer)) / 2, y: fy + SIZE.footer + 2, size: SIZE.footer, font: this.f.reg, color: C.mist });
    p.drawText(l2, { x: (PAGE.width - this.f.reg.widthOfTextAtSize(l2, SIZE.footer)) / 2, y: fy, size: SIZE.footer, font: this.f.reg, color: C.mist });
  }

  /** Room for `h` points, or a new page. */
  ensure(h: number) { if (this.y - h < BOTTOM) this.newPage(); }

  /** A paragraph of wrapped lines. Returns the height used. */
  lines(lines: string[], font: PDFFont, size: number, color: RGB, x: number, width: number, align: "l" | "r" = "l") {
    const lh = size * LINE;
    for (const ln of lines) {
      this.ensure(lh);
      const w = font.widthOfTextAtSize(ln, size);
      const px = align === "r" ? x + width - w : x;
      this.page.drawText(ln, { x: px, y: this.y - size, size, font, color });
      this.y -= lh;
    }
  }

  text(text: string, o: { font?: PDFFont; size?: number; color?: RGB; before?: number; after?: number; keepNext?: boolean; indent?: number }) {
    const font = o.font ?? this.f.reg, size = o.size ?? SIZE.body;
    const indent = o.indent ?? 0;
    const ls = wrap(text, font, size, TEXT_W - indent);
    const h = ls.length * size * LINE;
    // A heading keeps with what follows: it wants its own height plus two
    // lines of the body under it, or it moves to the next page.
    this.ensure((o.before ?? 0) + h + (o.keepNext ? 2 * SIZE.body * LINE : 0));
    this.y -= o.before ?? 0;
    this.lines(ls, font, size, o.color ?? C.ink, PAGE.left + indent, TEXT_W - indent);
    this.y -= o.after ?? 0;
  }

  bullet(text: string, after: number) {
    const size = SIZE.body, indent = 14;
    const ls = wrap(text, this.f.reg, size, TEXT_W - indent);
    this.ensure(size * LINE);
    this.page.drawText("•", { x: PAGE.left + 4, y: this.y - size, size, font: this.f.reg, color: C.ink });
    this.lines(ls, this.f.reg, size, C.ink, PAGE.left + indent, TEXT_W - indent);
    this.y -= after;
  }

  /**
   * A grid: widths in points, cells as text, per-row styling. The header row
   * is drawn again after a page break. Returns nothing; moves the cursor.
   */
  grid(o: {
    widths: number[];
    head: string[] | null;
    rows: { cells: string[]; bold?: boolean; fills?: (RGB | null)[]; monos?: boolean[]; aligns?: ("l" | "r")[]; colors?: (RGB | null)[]; boldCols?: boolean[] }[];
    size: number;
  }) {
    const x0 = PAGE.left;
    const lh = o.size * LINE;
    const drawRow = (raw: string[], st: { bold?: boolean; fills?: (RGB | null)[]; monos?: boolean[]; aligns?: ("l" | "r")[]; colors?: (RGB | null)[]; boldCols?: boolean[] }) => {
      const cells = raw.map(cellIndent);
      const fonts = cells.map((_, i) => (st.monos?.[i] ? this.f.mono : st.bold || st.boldCols?.[i] ? this.f.bold : this.f.reg));
      const wrapped = cells.map((c, i) => wrap(c.text, fonts[i], o.size, o.widths[i] - 2 * PAD - (c.indent ? 10 : 0)));
      const h = Math.max(...wrapped.map((w) => w.length)) * lh + 2 * PAD;
      return { fonts, wrapped, h, indents: cells.map((c) => c.indent) };
    };
    const paint = (cells: string[], st: Parameters<typeof drawRow>[1], r: ReturnType<typeof drawRow>) => {
      let x = x0;
      const top = this.y;
      cells.forEach((_, i) => {
        const fill = st.fills?.[i];
        if (fill) this.page.drawRectangle({ x, y: top - r.h, width: o.widths[i], height: r.h, color: fill });
        this.page.drawRectangle({ x, y: top - r.h, width: o.widths[i], height: r.h, borderColor: C.line, borderWidth: 0.5 });
        let ly = top - PAD - o.size;
        const ind = r.indents[i] ? 10 : 0;
        for (const ln of r.wrapped[i]) {
          const w = r.fonts[i].widthOfTextAtSize(ln, o.size);
          const px = st.aligns?.[i] === "r" ? x + o.widths[i] - PAD - w : x + PAD + ind;
          this.page.drawText(ln, { x: px, y: ly, size: o.size, font: r.fonts[i], color: st.colors?.[i] ?? (r.indents[i] ? C.slate : C.ink) });
          ly -= lh;
        }
        x += o.widths[i];
      });
      this.y = top - r.h;
    };
    const headSt = o.head ? { bold: true, fills: o.head.map(() => C.paper), colors: o.head.map(() => C.sky), aligns: o.rows[0]?.aligns } : null;
    const headRow = o.head && headSt ? drawRow(o.head, headSt) : null;
    const drawHead = () => { if (o.head && headSt && headRow) paint(o.head, headSt, headRow); };
    this.ensure((headRow?.h ?? 0) + (o.rows[0] ? drawRow(o.rows[0].cells, o.rows[0]).h : 0));
    drawHead();
    for (const row of o.rows) {
      const r = drawRow(row.cells, row);
      if (this.y - r.h < BOTTOM) { this.newPage(); drawHead(); }
      paint(row.cells, row, r);
    }
  }
}

function drawBlock(s: Sheet, b: ProposalBlock) {
  switch (b.kind) {
    case "title":
      s.text(b.text, { font: s.f.bold, size: SIZE.title, after: 2 });
      if (b.sub) s.text(b.sub, { size: SIZE.subtitle, color: C.slate, after: 14 }); else s.y -= 14;
      return;
    case "facts": {
      const widths = [72, 180, 72, 180];
      const rows = [];
      for (let r = 0; r < Math.ceil(b.rows.length / 2); r++) {
        const pair = [b.rows[r * 2] ?? ["", ""], b.rows[r * 2 + 1] ?? ["", ""]];
        rows.push({
          cells: pair.flatMap(([k, v]) => [k, v]),
          fills: [C.paper, null, C.paper, null],
          colors: [C.sky, null, C.sky, null],
          boldCols: [true, false, true, false],
          monos: pair.flatMap(([k]) => [false, /#|number/i.test(k)]),
        });
      }
      s.grid({ widths, head: null, rows, size: SIZE.table });
      s.y -= 12;
      return;
    }
    case "head":
      s.text(b.text, { font: s.f.bold, size: SIZE.h1, color: C.coral, before: 10, after: 5, keepNext: true });
      return;
    case "sub":
      s.text(b.text, { font: s.f.bold, size: SIZE.h2, before: 6, after: 4, keepNext: true });
      return;
    case "para":
      s.text(b.text, b.lead
        ? { font: s.f.ital, size: SIZE.lead, color: C.slate, after: 7 }
        : { font: b.strong ? s.f.bold : s.f.reg, after: 7 });
      return;
    case "list":
      b.items.forEach((it, i) => s.bullet(it, i === b.items.length - 1 ? 7 : 3));
      return;
    case "table": {
      const n = b.head.length;
      const total = n <= 3 ? Math.round(TEXT_W * 0.66) : TEXT_W;
      const shares = columnShares(b.head);
      const unit = total / shares.reduce((a, x) => a + x, 0);
      const widths = shares.map((x) => Math.floor(x * unit));
      const aligns = b.head.map((_, i) => b.align?.[i] ?? "l");
      const monos = (cells: string[]) => cells.map((c, i) => (b.mono ?? []).includes(i) && c.trim() !== "");
      const fills = b.head.map((_, i) => (b.highlightCol === i ? C.blush : null));
      const rows = [
        ...b.rows.map((cells, j) => ({
          cells, aligns, monos: monos(cells), fills,
          bold: b.lead && j === 0,
          boldCols: b.head.map((_, i) => b.lead === true && i === 0),
        })),
        ...(b.foot ?? []).map((cells) => ({ cells, aligns, monos: monos(cells), fills, bold: true })),
      ];
      s.grid({ widths, head: b.head, rows, size: SIZE.table });
      s.y -= 10;
      return;
    }
    case "callout": {
      const inner = TEXT_W - 20;
      const headLs = wrap(b.text, s.f.bold, SIZE.body, inner);
      const bodyLs = b.body.map((t) => wrap(t, s.f.reg, SIZE.body, inner));
      const h = 16 + headLs.length * SIZE.body * LINE + 4 + bodyLs.reduce((n, ls) => n + ls.length * SIZE.body * LINE + 6, 0);
      s.ensure(h);
      s.page.drawRectangle({ x: PAGE.left, y: s.y - h, width: TEXT_W, height: h, color: C.blush, borderColor: C.line, borderWidth: 0.5 });
      s.y -= 8;
      s.lines(headLs, s.f.bold, SIZE.body, C.coral, PAGE.left + 10, inner);
      s.y -= 4;
      for (const ls of bodyLs) { s.lines(ls, s.f.reg, SIZE.body, C.ink, PAGE.left + 10, inner); s.y -= 6; }
      s.y -= 8 + 10;
      return;
    }
  }
}

/** The whole document, as the bytes of a PDF. */
export async function renderPdf(spec: DocSpec): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${spec.type} ${spec.number}`.trim());
  doc.setAuthor(spec.operatorName);
  const f: Fonts = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    ital: await doc.embedFont(StandardFonts.HelveticaOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  const s = new Sheet(doc, f, spec);
  for (const b of spec.blocks) drawBlock(s, b);
  return doc.save();
}
