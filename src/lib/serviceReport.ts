// The service report, laid out the way it has always been laid out.
//
// This is a reproduction of an existing document - the one Sierra Spectra has
// been sending clients - not a new design. Section order, the grey header bands,
// the right-aligned label column, the fixed-height tables with their empty rows,
// the totals block and the two signature lines are all deliberate copies. If a
// change here makes it look "better" but different, that is a bug.
//
// Why rebuilt in code rather than filled into the original: the original is a
// flat page with no text layer and no form fields, so nothing can be typed into
// it, and three of its sections have to grow - the engineer's notes run from six
// lines to sixty, and parts and labor are as long as the visit was. A drawn
// layout reflows and paginates; an overlay cannot.
//
// Everything here is pure: data in, PDF bytes out, no database and no session.
// That is what lets tests assert the wording and the arithmetic.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

// ── the page's own measurements ──────────────────────────────────────────────
const PAGE = { w: 612, h: 792 };
const M = 36;                       // outer margin
const INK = rgb(0.05, 0.05, 0.05);
const MUT = rgb(0.35, 0.35, 0.35);
const RULE = rgb(0.72, 0.72, 0.72);
const BAND = rgb(0.898, 0.898, 0.898);   // section header bands
const HEAD = rgb(0.937, 0.937, 0.937);   // table column headings
const BOX = rgb(0.98, 0.98, 0.98);
const MONEY_GREEN = rgb(0.1, 0.5, 0.2);

/** The spectrum mark, drawn rather than embedded so no image has to travel with the code. */
const MARK = [
  { from: [0, 6], to: [14, 30], color: rgb(0.91, 0.30, 0.24) },
  { from: [14, 30], to: [28, 16], color: rgb(0.95, 0.61, 0.24) },
  { from: [28, 16], to: [42, 44], color: rgb(0.65, 0.78, 0.25) },
  { from: [42, 44], to: [56, 26], color: rgb(0.40, 0.72, 0.85) },
  { from: [56, 26], to: [78, 0], color: rgb(0.45, 0.66, 0.88) },
];

export type ReportLine = {
  description: string;
  partNumber: string;
  quantity: number;
  /** Cents. Calibration rows leave this null - they are not billed here. */
  unitCents: number | null;
  taxExempt: boolean;
  /** Lot / cal / expiry only appear in the calibration table. */
  lot?: string;
  cal?: string;
  expires?: string;
};

export type ServiceReport = {
  reportNumber: string;
  date: string;                 // header date, as printed
  visitDate: string;            // "Monday, August 25, 2025"
  serviceType: string;          // PM | Repair | Install
  engineer: string;
  provider: { name: string; lines: string[] };
  customer: { name: string; lines: string[] };
  instrument: { type: string; model: string; serial: string };
  workCompleted: string;
  poNumber: string;
  request: { date: string; from: string; text: string };
  /** Free text with its own small grammar - see drawNotes. */
  notes: { date: string; body: string };
  calibration: ReportLine[];
  parts: ReportLine[];
  labor: ReportLine[];
  balances: {
    visitsRemaining: string;
    partsRemaining: string;
    /** The contract's parts figure printed on page one, which is not the visit's sum. */
    partsTotal: string;
  };
  /** Cents, negative to reduce. Contract work bills nothing and says so here. */
  adjustmentCents: number;
  signatures: {
    providerName: string; customerName: string; customerOrg: string;
    /** PNG bytes for a captured signature, when there is one. */
    providerImage?: Uint8Array; customerImage?: Uint8Array;
  };
  contact: string;
};

const money = (cents: number) =>
  `${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A dash, the way the original writes an empty number. */
const DASH = "-";

export function reportTotals(r: ServiceReport) {
  const sum = (rows: ReportLine[]) =>
    rows.reduce((n, l) => n + (l.unitCents ?? 0) * l.quantity, 0);
  const parts = sum(r.parts);
  const labor = sum(r.labor);
  const sub = parts + labor;
  return { parts, labor, sub, adjustment: r.adjustmentCents, due: sub + r.adjustmentCents };
}

export async function buildServiceReport(r: ServiceReport): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const boldItalic = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
  const F = { font, bold, italic, boldItalic };

  doc.setTitle(`Service Report ${r.reportNumber}`);
  doc.setSubject(`${r.instrument.type} · ${r.instrument.serial}`);

  const page1 = doc.addPage([PAGE.w, PAGE.h]);
  let y = header(page1, F, r);
  y = overview(page1, F, r, y);
  y = requestBlock(page1, F, r, y);
  let left = notesBlock(page1, F, r, y, r.notes.body.split("\n"), false).left;
  // A long visit gets more paper rather than a shorter record.
  while (left.length) {
    const extra = doc.addPage([PAGE.w, PAGE.h]);
    left = notesBlock(extra, F, r, header(extra, F, r), left, true).left;
  }

  const page2 = doc.addPage([PAGE.w, PAGE.h]);
  let y2 = header(page2, F, r);
  y2 = lineTable(page2, F, "Calibration & Equpment",
    ["Description", "Part Num.", "Quantity", "Lot #", "Cal #", "Exp. Date"], r.calibration, y2, "calibration", 6);
  y2 = lineTable(page2, F, "Parts Summary",
    ["Description", "Part Num.", "Quantity", "Unit Price", "Tax Exempt", "Total"], r.parts, y2, "billed", 10);
  y2 = lineTable(page2, F, "Labor & Travel Summary",
    ["Description", "Part Num.", "Quantity", "Unit Price", "Tax Exempt", "Total"], r.labor, y2, "billed", 6);
  y2 = balancesAndTotals(page2, F, r, y2);
  await signatures(doc, page2, F, r, y2);

  for (const [i, p] of doc.getPages().entries()) footer(p, F, i + 1);
  return doc.save();
}

type Fonts = { font: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont };

/** Right-aligned text, which the label column of every block needs. */
function right(page: PDFPage, s: string, xRight: number, y: number, f: PDFFont, size: number, color = INK) {
  page.drawText(s, { x: xRight - f.widthOfTextAtSize(s, size), y, size, font: f, color });
}

/** The repeated top-of-page band: date and report number boxed left, title right. */
function header(page: PDFPage, F: Fonts, r: ServiceReport): number {
  const top = PAGE.h - M;
  const rowH = 15;
  const labelW = 62, valueW = 92;
  const x = M + 18;

  for (const [i, [label, value]] of [["Date", r.date], ["REPORT #", r.reportNumber]].entries()) {
    const ry = top - rowH * (i + 1);
    page.drawRectangle({ x, y: ry, width: labelW, height: rowH, color: BAND });
    page.drawRectangle({ x: x + labelW, y: ry, width: valueW, height: rowH, color: BOX, borderColor: RULE, borderWidth: 0.5 });
    right(page, label, x + labelW - 6, ry + 4.5, F.bold, 7.5);
    page.drawText(value, { x: x + labelW + 6, y: ry + 4.5, size: 7.5, font: F.font, color: INK });
  }

  // The title sits in its own band on the right half.
  const bandX = PAGE.w / 2 + 24;
  page.drawRectangle({ x: bandX, y: top - rowH * 2, width: PAGE.w - M - bandX, height: rowH * 2, color: BAND });
  const title = "SERVICE REPORT";
  const size = 13;
  page.drawText(title, {
    x: bandX + (PAGE.w - M - bandX - F.bold.widthOfTextAtSize(title, size)) / 2,
    y: top - rowH * 2 + 10, size, font: F.bold, color: INK,
  });

  return top - rowH * 2 - 22;
}

/** Logo, then the provider and customer columns side by side. */
function parties(page: PDFPage, F: Fonts, r: ServiceReport, y: number): number {
  const markX = M + 24, markY = y - 52;
  for (const seg of MARK) {
    page.drawLine({
      start: { x: markX + seg.from[0], y: markY + seg.from[1] },
      end: { x: markX + seg.to[0], y: markY + seg.to[1] },
      thickness: 3.4, color: seg.color,
    });
  }
  page.drawText("S I E R R A   •   S P E C T R A", {
    x: markX - 4, y: markY - 13, size: 6.5, font: F.bold, color: rgb(0.25, 0.25, 0.25),
  });

  const cols = [
    { x: 244, head: "Service Provider:", who: r.provider },
    { x: 418, head: "Customer Info:", who: r.customer },
  ];
  for (const c of cols) {
    let cy = y - 6;
    page.drawText(c.head, { x: c.x, y: cy, size: 8, font: F.bold, color: INK });
    cy -= 11;
    for (const line of [c.who.name, ...c.who.lines]) {
      page.drawText(line, { x: c.x, y: cy, size: 7.5, font: F.font, color: INK });
      cy -= 10;
    }
  }
  return Math.min(markY - 22, y - 6 - 11 - 10 * 4);
}

/** A grey full-width section header, as used five times in the original. */
function band(page: PDFPage, F: Fonts, label: string, y: number, centered = false): number {
  const h = 13;
  page.drawRectangle({ x: M, y: y - h, width: PAGE.w - 2 * M, height: h, color: BAND });
  if (centered) {
    const size = 8.5;
    page.drawText(label, {
      x: M + (PAGE.w - 2 * M - F.bold.widthOfTextAtSize(label, size)) / 2,
      y: y - h + 3.8, size, font: F.bold, color: INK,
    });
  } else {
    page.drawText(label, { x: M + 4, y: y - h + 3.8, size: 7.5, font: F.bold, color: INK });
  }
  return y - h;
}

/** Label-right / value-left pairs, the pattern the whole overview is built from. */
function pairs(
  page: PDFPage, F: Fonts, rows: [string, string][], labelRight: number, valueLeft: number, y: number,
): number {
  let cy = y;
  for (const [label, value] of rows) {
    right(page, label, labelRight, cy, F.bold, 7.5);
    page.drawText(value, { x: valueLeft, y: cy, size: 7.5, font: F.font, color: INK });
    cy -= 12.5;
  }
  return cy;
}

function overview(page: PDFPage, F: Fonts, r: ServiceReport, yIn: number): number {
  const y = parties(page, F, r, yIn);
  let cursor = band(page, F, "Service Overview", y);
  const boxTop = cursor;

  const left = pairs(page, F, [
    ["Date of Visit:", r.visitDate],
    ["Service Type:", r.serviceType],
    ["Service Engineer:", r.engineer],
    ["Instrument Type:", r.instrument.type],
    ["Model Number:", r.instrument.model],
    ["Serial Number:", r.instrument.serial],
    ["Work Completed:", r.workCompleted],
  ], 236, 244, cursor - 14);

  // These two are the contract's figures, not this visit's: the original prints
  // a dash here while page two totals three thousand dollars of parts.
  pairs(page, F, [
    ["PO Number:", r.poNumber],
    ["Service Visit:", r.serviceType],
    ["Total Parts:", r.balances.partsTotal || DASH],
    ["Parts Balance:", r.balances.partsRemaining || DASH],
  ], 486, 494, cursor - 14);

  cursor = left - 6;
  // The original boxes the overview's left column only.
  page.drawRectangle({
    x: M, y: cursor, width: 100, height: boxTop - cursor,
    borderColor: RULE, borderWidth: 0.5,
  });
  return cursor - 18;
}

function requestBlock(page: PDFPage, F: Fonts, r: ServiceReport, y: number): number {
  let cursor = band(page, F, "Service Request Information", y);
  const boxTop = cursor;
  cursor = pairs(page, F, [["Date:", r.request.date], ["From:", r.request.from]], 236, 244, cursor - 14);
  const wrapped = wrap(r.request.text, F.font, 7.5, PAGE.w - 2 * M - 12);
  for (const line of wrapped) {
    page.drawText(line, { x: M + 4, y: cursor, size: 7.5, font: F.font, color: INK });
    cursor -= 10;
  }
  cursor -= 6;
  page.drawRectangle({ x: M, y: cursor, width: PAGE.w - 2 * M, height: boxTop - cursor, borderColor: RULE, borderWidth: 0.5 });
  return cursor - 18;
}

/**
 * The engineer's notes, which carry a small grammar the original uses
 * consistently and which is worth keeping because it reads as a test record:
 *
 *   Heading:              a line ending in ':' or with no leading '-'
 *   - observation | OK    a check and its result
 *   Expected: x | Actual: y | OK
 *
 * Blank lines separate groups. Headings come out bold, everything else plain.
 */
function notesBlock(
  page: PDFPage, F: Fonts, r: ServiceReport, y: number, lines: string[], continued: boolean,
): { left: string[] } {
  let cursor = band(page, F, continued ? "Service Engineer Notes (continued)" : "Service Engineer Notes", y);
  const boxTop = cursor;
  if (!continued) cursor = pairs(page, F, [["Date:", r.notes.date]], 236, 244, cursor - 14);
  else cursor -= 12;
  cursor -= 2;

  // The floor is the paper, not the last line. A visit with sixty checks on it
  // used to draw them off the bottom edge, where they were in the file and
  // invisible on the page.
  const FLOOR = M + 24;
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!line.trim()) { cursor -= 7; continue; }
    const isHeading = !line.startsWith("-") && !line.startsWith(">") && !/^Expected:/.test(line)
      && (line.endsWith(":") || line === line.toUpperCase() || /^(Replaced|Performed|Installed|Cleaned|Verified)\b/.test(line));
    const f = isHeading ? F.bold : F.font;
    const segs = wrap(line, f, 7.5, PAGE.w - 2 * M - 12);
    if (cursor - segs.length * 10 < FLOOR) break;
    for (const [n, seg] of segs.entries()) {
      page.drawText(seg, { x: M + 4 + (n ? 8 : 0), y: cursor, size: 7.5, font: f, color: INK });
      cursor -= 10;
    }
  }
  cursor -= 8;
  page.drawRectangle({ x: M, y: cursor, width: PAGE.w - 2 * M, height: boxTop - cursor, borderColor: RULE, borderWidth: 0.5 });
  return { left: lines.slice(i) };
}

/** Column geometry shared by the three tables, so their grids line up. */
const COLS = [
  { x: M, w: 196, align: "left" as const },
  { x: M + 196, w: 84, align: "center" as const },
  { x: M + 280, w: 54, align: "center" as const },
  { x: M + 334, w: 68, align: "center" as const },
  { x: M + 402, w: 60, align: "center" as const },
  { x: M + 462, w: PAGE.w - 2 * M - 462, align: "right" as const },
];


function cell(page: PDFPage, s: string, i: number, y: number, f: PDFFont, size = 7) {
  const c = COLS[i];
  const w = f.widthOfTextAtSize(s, size);
  const x = c.align === "left" ? c.x + 4 : c.align === "right" ? c.x + c.w - 4 - w : c.x + (c.w - w) / 2;
  page.drawText(s, { x, y, size, font: f, color: INK });
}

function lineTable(
  page: PDFPage, F: Fonts, title: string, heads: string[], rows: ReportLine[], y: number,
  kind: "calibration" | "billed", minRows: number,
): number {
  let cursor = band(page, F, title, y, true);

  const rowH = 13.5;
  page.drawRectangle({ x: M, y: cursor - rowH, width: PAGE.w - 2 * M, height: rowH, color: HEAD });
  for (const [i, h] of heads.entries()) cell(page, h, i, cursor - rowH + 4, F.bold, 6.5);
  cursor -= rowH;

  const count = Math.max(rows.length, minRows);
  const gridTop = cursor;
  for (let i = 0; i < count; i++) {
    const ry = cursor - rowH;
    const row = rows[i];
    if (row) {
      cell(page, row.description, 0, ry + 4, F.font);
      cell(page, row.partNumber, 1, ry + 4, F.font);
      cell(page, String(row.quantity), 2, ry + 4, F.font);
      if (kind === "calibration") {
        cell(page, row.lot || DASH, 3, ry + 4, F.font);
        cell(page, row.cal || DASH, 4, ry + 4, F.font);
        cell(page, row.expires || DASH, 5, ry + 4, F.font);
      } else {
        // Currency sits against the left of its column and the figure against
        // the right, the way a ledger sets it.
        page.drawText("$", { x: COLS[3].x + 4, y: ry + 4, size: 7, font: F.font, color: INK });
        const amount = money(row.unitCents ?? 0);
        page.drawText(amount, {
          x: COLS[3].x + COLS[3].w - 4 - F.font.widthOfTextAtSize(amount, 7), y: ry + 4,
          size: 7, font: F.font, color: INK,
        });
        if (row.taxExempt) cell(page, "X", 4, ry + 4, F.font);
        page.drawText("$", { x: COLS[5].x + 4, y: ry + 4, size: 7, font: F.font, color: INK });
        const total = row.quantity ? money((row.unitCents ?? 0) * row.quantity) : DASH;
        cell(page, total, 5, ry + 4, F.font);
      }
    }
    page.drawLine({ start: { x: M, y: ry }, end: { x: PAGE.w - M, y: ry }, thickness: 0.4, color: RULE });
    cursor = ry;
  }
  // Verticals last, so they sit over the row rules like the original's grid.
  for (const c of [...COLS.map((c) => c.x), PAGE.w - M]) {
    page.drawLine({ start: { x: c, y: gridTop }, end: { x: c, y: cursor }, thickness: 0.4, color: RULE });
  }
  return cursor - 16;
}

function balancesAndTotals(page: PDFPage, F: Fonts, r: ServiceReport, y: number): number {
  const t = reportTotals(r);

  page.drawRectangle({ x: M, y: y - 13, width: 196, height: 13, color: BAND });
  page.drawText("Remaining Balances:", { x: M + 4, y: y - 9.2, size: 8, font: F.bold, color: INK });
  let ly = y - 26;
  for (const line of [
    "Remaining balances for current contract upon",
    "completion of this service visit.",
  ]) {
    page.drawText(line, { x: M + 12, y: ly, size: 7, font: F.italic, color: INK });
    ly -= 10;
  }
  ly -= 2;
  pairs(page, F, [
    ["Service Visits Remaining:", r.balances.visitsRemaining || DASH],
    ["Parts Allowance Remaining:", r.balances.partsRemaining || DASH],
  ], 168, 176, ly);

  // The totals stack, right-hand side, label boxed and figure boxed.
  const rows: [string, string, boolean][] = [
    ["Total Parts", t.parts ? money(t.parts) : DASH, false],
    ["Total Labor", t.labor ? money(t.labor) : DASH, false],
    ["Sub Total", t.sub ? money(t.sub) : DASH, false],
    ["Adjustments", t.adjustment ? `(${money(Math.abs(t.adjustment))})` : DASH, false],
    ["Total Amount Due", t.due ? money(t.due) : DASH, true],
  ];
  const labelX = 366, labelW = 108, figX = labelX + labelW, figW = PAGE.w - M - figX;
  let ty = y;
  for (const [label, value, emphasis] of rows) {
    const h = 14;
    page.drawRectangle({ x: labelX, y: ty - h, width: labelW, height: h, color: emphasis ? BAND : BOX, borderColor: RULE, borderWidth: 0.5 });
    page.drawRectangle({ x: figX, y: ty - h, width: figW, height: h, color: emphasis ? BAND : BOX, borderColor: RULE, borderWidth: 0.5 });
    right(page, label, figX - 6, ty - h + 4.2, emphasis ? F.bold : F.font, 7.5);
    page.drawText("$", { x: figX + 5, y: ty - h + 4.2, size: 7.5, font: F.font, color: emphasis ? MONEY_GREEN : INK });
    right(page, value, PAGE.w - M - 5, ty - h + 4.2, emphasis ? F.bold : F.font, 7.5, emphasis ? MONEY_GREEN : INK);
    ty -= h;
  }
  return Math.min(ly - 30, ty - 24);
}

async function signatures(doc: PDFDocument, page: PDFPage, F: Fonts, r: ServiceReport, y: number) {
  const blocks = [
    { x: M + 30, w: 200, role: `${r.signatures.customerOrg ? "Sierra Spectra" : "Service"} Representative`, name: r.signatures.providerName, img: r.signatures.providerImage },
    { x: PAGE.w / 2 + 24, w: 200, role: `${r.signatures.customerOrg} Rep`, name: r.signatures.customerName, img: r.signatures.customerImage },
  ];
  const lineY = y - 44;
  for (const b of blocks) {
    if (b.img) {
      // Sits on the rule, scaled to the block - a captured signature arrives at
      // whatever size the pad gave it, and must not spill into the next column.
      try {
        const png = await doc.embedPng(b.img);
        const max = { w: b.w - 20, h: 38 };
        const scale = Math.min(max.w / png.width, max.h / png.height, 1);
        page.drawImage(png, {
          x: b.x + (b.w - png.width * scale) / 2, y: lineY + 3,
          width: png.width * scale, height: png.height * scale,
        });
      } catch { /* an unreadable signature must not cost the whole report */ }
    }
    page.drawLine({ start: { x: b.x, y: lineY }, end: { x: b.x + b.w, y: lineY }, thickness: 0.8, color: INK });
    const role = b.role;
    page.drawText(role, {
      x: b.x + (b.w - F.boldItalic.widthOfTextAtSize(role, 7.5)) / 2, y: lineY - 11,
      size: 7.5, font: F.boldItalic, color: INK,
    });
    page.drawText(b.name, {
      x: b.x + (b.w - F.font.widthOfTextAtSize(b.name, 7.5)) / 2, y: lineY - 21,
      size: 7.5, font: F.font, color: INK,
    });
  }

  let cy = lineY - 44;
  const centre = (s: string, f: PDFFont, size: number, color = INK) => {
    page.drawText(s, { x: (PAGE.w - f.widthOfTextAtSize(s, size)) / 2, y: cy, size, font: f, color });
    cy -= 13;
  };
  centre("Signatures acknowledge to all information in this document to be true and service to have been completed as described.",
    F.boldItalic, 7);
  cy -= 8;
  centre("THIS IS NOT AN INVOICE", F.bold, 8);
  centre("Should you have any questions or require additional details about this service visit please don't hesitate to contact:",
    F.bold, 7.5);
  centre(r.contact, F.font, 7.5, MUT);
}

function footer(page: PDFPage, F: Fonts, n: number) {
  const s = `[Page ${n}]`;
  right(page, s, PAGE.w - M, M - 12, F.font, 7, MUT);
}

/** Greedy wrap on width, which is all any of these blocks needs. */
function wrap(text: string, f: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(next, size) > maxWidth && line) { out.push(line); line = word; }
      else line = next;
    }
    out.push(line);
  }
  return out;
}
