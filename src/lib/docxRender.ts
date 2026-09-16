// A document as a Word file, in the house style.
//
// The style guide is a Word document itself, and "keep the .docx internal"
// is its own rule: the Word file is the copy the shop edits, the PDF the
// copy the client gets. This draws the same blocks lib/pdfRender draws,
// from the same lib/docStyle, so the two never disagree about a colour or
// a size. Anything the guide fixes is taken from there, not typed here.
//
// docx-js. Sizes are half-points, spacing and widths are twips (1/20 pt):
// the two helpers below keep the arithmetic in one place.

import {
  AlignmentType, BorderStyle, Document, Footer, Header, HeightRule, LevelFormat, LineRuleType,
  Packer, PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TabStopType, TextRun,
  VerticalAlign, WidthType,
} from "docx";
import { DOC_COLOR, PAGE, SIZE, SPECTRUM, cellIndent, columnShares, footerLine2, wordmark, type DocSpec } from "@/lib/docStyle";
import type { ProposalBlock } from "@/lib/proposal";

/** Points to half-points, the unit a run's size is in. */
const hp = (ptSize: number) => Math.round(ptSize * 2);
/** Points to twips, the unit spacing and widths are in. */
const tw = (ptSize: number) => Math.round(ptSize * 20);

/** 8.5" less two 0.75" margins, in twips. */
const TEXT_W = tw(PAGE.width - PAGE.left - PAGE.right);
/** 1.15 line, as docx states it: 240 = single. */
const LINE = 276;

type Border = { style: (typeof BorderStyle)[keyof typeof BorderStyle]; size: number; color: string };
/** 0.5pt, the guide's hairline: docx sizes borders in eighths of a point. */
const HAIRLINE: Border = { style: BorderStyle.SINGLE, size: 4, color: DOC_COLOR.line };
const NONE: Border = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const box = (b: Border) => ({ top: b, bottom: b, left: b, right: b });
const CELL_PAD = { top: tw(4), bottom: tw(4), left: tw(4), right: tw(4) };

type RunOpts = { bold?: boolean; italic?: boolean; size?: number; color?: string; mono?: boolean; caps?: boolean };
const run = (text: string, o: RunOpts = {}) => new TextRun({
  text, bold: o.bold, italics: o.italic, size: hp(o.size ?? SIZE.body),
  color: o.color ?? DOC_COLOR.ink, font: o.mono ? "Consolas" : "Arial", allCaps: o.caps,
});

type ParaOpts = { before?: number; after?: number; line?: number; keepNext?: boolean; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; bullet?: boolean; indent?: number; pageBreakBefore?: boolean };
const para = (children: TextRun[], o: ParaOpts = {}) => new Paragraph({
  children,
  spacing: { before: tw(o.before ?? 0), after: tw(o.after ?? 0), line: o.line ?? LINE, lineRule: LineRuleType.AUTO },
  keepNext: o.keepNext,
  pageBreakBefore: o.pageBreakBefore,
  alignment: o.align,
  indent: o.indent ? { left: tw(o.indent) } : undefined,
  numbering: o.bullet ? { reference: "bullets", level: 0 } : undefined,
});

const shade = (fill: string) => ({ fill, type: ShadingType.CLEAR, color: "auto" });

const cell = (children: Paragraph[], width: number, o: { fill?: string; borders?: ReturnType<typeof box> } = {}) => new TableCell({
  width: { size: width, type: WidthType.DXA },
  shading: o.fill ? shade(o.fill) : undefined,
  margins: CELL_PAD,
  borders: o.borders ?? box(HAIRLINE),
  verticalAlign: VerticalAlign.TOP,
  children,
});

/** Five equal segments, 3pt tall, full text width, directly under the header line. */
function spectrumBar(): Table {
  const w = Math.floor(TEXT_W / SPECTRUM.length);
  return new Table({
    width: { size: w * SPECTRUM.length, type: WidthType.DXA },
    columnWidths: SPECTRUM.map(() => w),
    borders: { ...box(NONE), insideHorizontal: NONE, insideVertical: NONE },
    rows: [new TableRow({
      height: { value: tw(PAGE.barHeight), rule: HeightRule.EXACT },
      children: SPECTRUM.map((fill) => new TableCell({
        width: { size: w, type: WidthType.DXA },
        shading: shade(fill),
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        borders: box(NONE),
        children: [new Paragraph({
          spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT },
          children: [new TextRun({ text: "", size: 2 })],
        })],
      })),
    })],
  });
}

function header(spec: DocSpec): Header {
  return new Header({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: TEXT_W }],
        spacing: { before: 0, after: tw(3), line: 240, lineRule: LineRuleType.AUTO },
        children: [
          run(wordmark(spec.operatorName), { bold: true, size: SIZE.wordmark }),
          new TextRun({ text: "\t" }),
          run(spec.tag, { size: SIZE.tag, color: DOC_COLOR.coral }),
        ],
      }),
      spectrumBar(),
    ],
  });
}

function footer(spec: DocSpec): Footer {
  const mist = { size: SIZE.footer, color: DOC_COLOR.mist };
  return new Footer({
    children: [
      para([run(spec.contactLine, mist)], { align: AlignmentType.CENTER, line: 240 }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO },
        children: [
          run(footerLine2(spec.client, ""), mist),
          new TextRun({ children: [PageNumber.CURRENT], size: hp(SIZE.footer), color: DOC_COLOR.mist, font: "Arial" }),
        ],
      }),
    ],
  });
}

/** The summary block: label, value, twice across. Labels Sky on Paper. */
function facts(rows: [string, string][]): Table {
  const widths = [tw(72), tw(180), tw(72), tw(180)];
  const trs: TableRow[] = [];
  for (let r = 0; r < Math.ceil(rows.length / 2); r++) {
    const pair = [rows[r * 2], rows[r * 2 + 1]];
    trs.push(new TableRow({
      children: pair.flatMap((kv, i) => {
        const [k, v] = kv ?? ["", ""];
        const mono = /#|number/i.test(k);
        return [
          cell([para([run(k, { bold: true, size: SIZE.table, color: DOC_COLOR.sky })], { line: 240 })], widths[i * 2], { fill: DOC_COLOR.paper }),
          cell([para([run(v, { size: SIZE.table, mono })], { line: 240 })], widths[i * 2 + 1]),
        ];
      }),
    }));
  }
  return new Table({
    width: { size: widths.reduce((n, w) => n + w, 0), type: WidthType.DXA },
    columnWidths: widths,
    borders: { ...box(HAIRLINE), insideHorizontal: HAIRLINE, insideVertical: HAIRLINE },
    rows: trs,
  });
}

/**
 * A table the guide's way: header row Sky on Paper, bold; body white with
 * hairline borders and 4pt padding; numbers right; model and part numbers in
 * Consolas; a total row bold with no second fill; the recommended column
 * Blush. Full text width unless it has three or fewer columns.
 */
function table(b: Extract<ProposalBlock, { kind: "table" }>): Table {
  const n = b.head.length;
  const total = n <= 3 ? Math.round(TEXT_W * 0.66) : TEXT_W;
  const shares = b.shares ?? columnShares(b.head);
  const unit = total / shares.reduce((a, s) => a + s, 0);
  const widths = shares.map((s) => Math.floor(s * unit));
  const align = (i: number) => (b.align?.[i] === "r" ? AlignmentType.RIGHT : AlignmentType.LEFT);
  const mono = (i: number) => (b.mono ?? []).includes(i);

  const row = (cells: string[], o: { head?: boolean; bold?: boolean; lead?: boolean }) => new TableRow({
    tableHeader: o.head,
    children: cells.map((raw, i) => {
      const { text, indent } = cellIndent(raw);
      return cell(
        [para([run(text, {
          bold: o.head || o.bold || (b.lead && i === 0),
          size: SIZE.table,
          color: o.head ? DOC_COLOR.sky : indent ? DOC_COLOR.slate : DOC_COLOR.ink,
          mono: !o.head && mono(i) && text.trim() !== "",
        })], { line: 240, align: align(i), indent: indent ? 10 : 0 })],
        widths[i],
        { fill: o.head ? DOC_COLOR.paper : !o.head && b.highlightCol === i ? DOC_COLOR.blush : undefined },
      );
    }),
  });

  return new Table({
    width: { size: widths.reduce((a, w) => a + w, 0), type: WidthType.DXA },
    columnWidths: widths,
    borders: { ...box(HAIRLINE), insideHorizontal: HAIRLINE, insideVertical: HAIRLINE },
    rows: [
      row(b.head, { head: true }),
      ...b.rows.map((r, j) => row(r, { lead: b.lead && j === 0, bold: b.lead && j === 0 })),
      ...(b.foot ?? []).map((r) => row(r, { bold: true })),
    ],
  });
}

/** What we recommend: a Blush box, the heading in coral, the reasons under it. */
function callout(b: Extract<ProposalBlock, { kind: "callout" }>): Table {
  return new Table({
    width: { size: TEXT_W, type: WidthType.DXA },
    columnWidths: [TEXT_W],
    borders: { ...box(HAIRLINE), insideHorizontal: NONE, insideVertical: NONE },
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: TEXT_W, type: WidthType.DXA },
        shading: shade(DOC_COLOR.blush),
        margins: { top: tw(8), bottom: tw(8), left: tw(10), right: tw(10) },
        borders: box(HAIRLINE),
        children: [
          para([run(b.text, { bold: true, color: DOC_COLOR.coral })], { after: 4 }),
          ...b.body.map((t, i) => para([run(t)], { after: i === b.body.length - 1 ? 0 : 6 })),
        ],
      })],
    })],
  });
}

/**
 * `breakBefore` is set on a section heading when the document puts each
 * section on its own page - never on the first block, which would open the
 * file with a blank sheet.
 */
function blockToDocx(b: ProposalBlock, breakBefore = false): (Paragraph | Table)[] {
  switch (b.kind) {
    case "title":
      return [
        para([run(b.text, { bold: true, size: SIZE.title })], { after: 2, line: 240 }),
        ...(b.sub ? [para([run(b.sub, { size: SIZE.subtitle, color: DOC_COLOR.slate })], { after: 14, line: 240 })] : [para([], { after: 14 })]),
      ];
    case "facts":
      return [facts(b.rows), para([], { after: 8, line: 240 })];
    case "head":
      return [para([run(b.text, { bold: true, size: SIZE.h1, color: DOC_COLOR.coral })],
        { before: 10, after: 5, line: 240, keepNext: true, pageBreakBefore: breakBefore })];
    case "sub":
      return [para([run(b.text, { bold: true, size: SIZE.h2 })], { before: 6, after: 4, line: 240, keepNext: true })];
    case "para":
      return [para(
        [run(b.text, b.lead ? { italic: true, size: SIZE.lead, color: DOC_COLOR.slate } : { bold: b.strong })],
        { after: 7 },
      )];
    case "list":
      return b.items.map((it, i) => para([run(it)], { after: i === b.items.length - 1 ? 7 : 3, bullet: true }));
    case "table":
      return [table(b), para([], { after: 6, line: 240 })];
    case "callout":
      return [callout(b), para([], { after: 6, line: 240 })];
  }
}

/** The whole document, as the bytes of a .docx. */
export async function renderDocx(spec: DocSpec): Promise<Buffer> {
  const doc = new Document({
    creator: spec.operatorName,
    title: `${spec.type} ${spec.number}`.trim(),
    styles: {
      default: {
        document: {
          run: { font: "Arial", size: hp(SIZE.body), color: DOC_COLOR.ink },
          paragraph: { spacing: { line: LINE, lineRule: LineRuleType.AUTO, after: tw(7) } },
        },
      },
    },
    numbering: {
      config: [{
        reference: "bullets",
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: tw(18), hanging: tw(12) } } },
        }],
      }],
    },
    sections: [{
      properties: {
        page: {
          size: { width: tw(PAGE.width), height: tw(PAGE.height) },
          margin: {
            top: tw(PAGE.top), right: tw(PAGE.right), bottom: tw(PAGE.bottom), left: tw(PAGE.left),
            header: tw(PAGE.headerFromEdge), footer: tw(PAGE.footerFromEdge),
          },
        },
      },
      headers: { default: header(spec) },
      footers: { default: footer(spec) },
      children: spec.blocks.flatMap((b, i) => blockToDocx(b, Boolean(spec.sectionBreaks) && i > 0)),
    }],
  });
  return Packer.toBuffer(doc);
}
