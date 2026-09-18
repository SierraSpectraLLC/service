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
// Read off the original with a ruler: the sheet prints with a 20pt margin,
// bands 13.5pt tall, rows 13pt apart, the label column of the overview
// ending at 124pt and its values starting at 127. Every number below is one
// of those, not a design decision made here.
const PAGE = { w: 612, h: 792 };
const M = 20;                        // outer margin
const RIGHT = PAGE.w - M;            // the right edge of everything
const ROW = 13;                      // the pitch of every row of text
const INK = rgb(0.05, 0.05, 0.05);
const MUT = rgb(0.35, 0.35, 0.35);
const RULE = rgb(0.72, 0.72, 0.72);
const BAND = rgb(0.898, 0.898, 0.898);   // section header bands
const HEAD = rgb(0.937, 0.937, 0.937);   // table column headings
const LABEL = rgb(0.94, 0.94, 0.94);     // the grey behind a label column
const BOX = rgb(0.98, 0.98, 0.98);       // a value cell

/**
 * The sizes, in points. The sheet sets its body in a narrow face at 9.3; the
 * standard Helvetica is wider, so each is a half-point under the original to
 * land the same words in the same columns.
 */
const S = { title: 13.5, band: 9.5, body: 8.5, cell: 8, foot: 8.5 };

/** The mark on page one is an IMAGE the caller hands in - see ServiceReport.logo. */
const LOGO_W = 150;

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
  /**
   * Which visit of the contract this was - "05". The master sheet carries it
   * beside the PO number and a client counts down by it. Blank prints a dash,
   * which is what a visit under no contract is.
   */
  visitNumber: string;
  engineer: string;
  provider: { name: string; lines: string[] };
  customer: { name: string; lines: string[] };
  /**
   * `module` is the unit the work was on, when it was on one: "Pump VF-P10
   * (Asset ID# EQ-227)". The original's own rule - a report names the module
   * OR the model, never both, because the row is "which thing is this about".
   */
  instrument: { type: string; model: string; serial: string; module?: string };
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
    /** The service company issuing the report - the operator, not the platform. */
    providerOrg?: string;
    /** PNG bytes for a captured signature, when there is one. */
    providerImage?: Uint8Array; customerImage?: Uint8Array;
  };
  contact: string;
  /**
   * The mark on the first page: PNG or JPEG bytes, embedded as given. It is
   * the one thing on the page that is the operator's rather than the
   * layout's, and it is NOT part of the frozen report - the loader supplies it
   * at render time from templates/ServiceReportLogo.png, or from the logo
   * uploaded under the operator's appearance. Absent, the operator's name is
   * typed where the mark would be, and no other company's mark stands in.
   */
  logo?: Uint8Array;
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
  y = await overview(doc, page1, F, r, y);
  y = requestBlock(page1, F, r, y);
  let left = notesBlock(page1, F, r, y, r.notes.body.split("\n"), false).left;
  // A long visit gets more paper rather than a shorter record.
  while (left.length) {
    const extra = doc.addPage([PAGE.w, PAGE.h]);
    left = notesBlock(extra, F, r, header(extra, F, r), left, true).left;
  }

  const page2 = doc.addPage([PAGE.w, PAGE.h]);
  // The first table sits a row and a half under the header, as on the sheet.
  let y2 = header(page2, F, r) - 23;
  y2 = lineTable(page2, F, "Calibration & Equpment",
    ["Description", "Part Num.", "Quantity", "Lot #", "Cal #", "Exp. Date"], r.calibration, y2, "calibration", 6);
  y2 = lineTable(page2, F, "Parts Summary",
    ["Description", "Part Num.", "Quantity", "Unit Price", "Tax Exempt", "Total"], r.parts, y2, "billed", 11);
  y2 = lineTable(page2, F, "Labor & Travel Summary",
    ["Description", "Part Num.", "Quantity", "Unit Price", "Tax Exempt", "Total"], r.labor, y2, "billed", 4);
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

/** Centered between two x's. Shrinks a line that would not fit rather than spilling it. */
function centered(page: PDFPage, s: string, x0: number, x1: number, y: number, f: PDFFont, size: number, color = INK) {
  let sz = size;
  while (sz > 5 && f.widthOfTextAtSize(s, sz) > x1 - x0 - 4) sz -= 0.5;
  page.drawText(s, { x: x0 + (x1 - x0 - f.widthOfTextAtSize(s, sz)) / 2, y, size: sz, font: f, color });
}

/** The repeated top-of-page band: date and report number boxed left, title right. */
function header(page: PDFPage, F: Fonts, r: ServiceReport): number {
  const top = PAGE.h - 34;
  const rowH = 15.5;
  const labelW = 61, valueW = 97;

  for (const [i, [label, value]] of [["Date", r.date], ["REPORT #", r.reportNumber]].entries()) {
    const ry = top - rowH * (i + 1);
    page.drawRectangle({ x: M, y: ry, width: labelW, height: rowH, color: BAND });
    page.drawRectangle({ x: M + labelW, y: ry, width: valueW, height: rowH, color: BOX, borderColor: RULE, borderWidth: 0.5 });
    right(page, label, M + labelW - 6, ry + 4.5, F.bold, S.body);
    page.drawText(value, { x: M + labelW + 6, y: ry + 4.5, size: S.body, font: F.font, color: INK });
  }

  // The title sits in its own band on the right, as tall as both rows.
  const bandX = 384;
  page.drawRectangle({ x: bandX, y: top - rowH * 2, width: RIGHT - bandX, height: rowH * 2, color: BAND });
  centered(page, "SERVICE REPORT", bandX, RIGHT, top - rowH * 2 + 9.5, F.bold, S.title);

  return top - rowH * 2;
}

/** Logo, then the provider and customer columns side by side. */
async function parties(doc: PDFDocument, page: PDFPage, F: Fonts, r: ServiceReport, y: number): Promise<number> {
  // The mark fills the left third under the header, at the width the sheet
  // gives it. PNG or JPEG, told apart by their first bytes; anything else,
  // or bytes that will not decode, cost the mark and not the report.
  let drawn = false;
  if (r.logo && r.logo.length > 4) {
    try {
      const isPng = r.logo[0] === 0x89 && r.logo[1] === 0x50;
      const img = isPng ? await doc.embedPng(r.logo) : await doc.embedJpg(r.logo);
      const h = (LOGO_W * img.height) / img.width;
      page.drawImage(img, { x: M, y: y - 1 - h, width: LOGO_W, height: h });
      drawn = true;
    } catch { /* no mark rather than no report */ }
  }
  if (!drawn) {
    // Whoever is issuing the report, letter-spaced the way the wordmark is
    // typed - not a company name baked into the generator.
    const words = r.provider.name.trim().toUpperCase().split(/\s+/).filter(Boolean);
    const wordmark = words.map((w) => [...w].join(" ")).join("   \u2022   ");
    centered(page, wordmark, M, M + LOGO_W, y - 80, F.bold, 7, rgb(0.25, 0.25, 0.25));
  }

  const cols = [
    { x: 241, head: "Service Provider:", who: r.provider },
    { x: 412, head: "Customer Info:", who: r.customer },
  ];
  for (const c of cols) {
    let cy = y - 24;
    page.drawText(c.head, { x: c.x, y: cy, size: S.body, font: F.bold, color: INK });
    cy -= ROW;
    for (const line of [c.who.name, ...c.who.lines]) {
      page.drawText(line, { x: c.x, y: cy, size: S.body, font: F.font, color: INK });
      cy -= ROW;
    }
  }
  // The first band sits a fixed distance under the header: the sheet's rows
  // are the sheet's rows, whether or not an address fills all of them.
  return y - 139;
}

/** A grey full-width section header, as used five times in the original. */
function band(page: PDFPage, F: Fonts, label: string, y: number, o: { centered?: boolean; width?: number } = {}): number {
  const h = 13.5;
  const w = o.width ?? RIGHT - M;
  page.drawRectangle({ x: M, y: y - h, width: w, height: h, color: BAND });
  if (o.centered) centered(page, label, M, M + w, y - h + 3.5, F.bold, S.band);
  else page.drawText(label, { x: M + 1, y: y - h + 3.5, size: S.band, font: F.bold, color: INK });
  return y - h;
}

/**
 * Label-right / value-left pairs, the pattern the whole overview is built
 * from. Values are bold in the original unless told otherwise.
 */
function pairs(
  page: PDFPage, F: Fonts, rows: [string, string, PDFFont?][], labelRight: number, valueLeft: number, y: number,
): number {
  let cy = y;
  for (const [label, value, f] of rows) {
    right(page, label, labelRight, cy, F.bold, S.body);
    page.drawText(value, { x: valueLeft, y: cy, size: S.body, font: f ?? F.bold, color: INK });
    cy -= ROW;
  }
  return cy;
}

async function overview(doc: PDFDocument, page: PDFPage, F: Fonts, r: ServiceReport, yIn: number): Promise<number> {
  const y = await parties(doc, page, F, r, yIn);
  const bottom = band(page, F, "Service Overview", y);

  // The label columns are grey, left and right, and the left one runs nine
  // rows whatever the seven rows under it need - the sheet's cells are the
  // sheet's cells.
  const leftRows = 9, rightRows = 4;
  page.drawRectangle({ x: M, y: bottom - leftRows * ROW - 3, width: 105, height: leftRows * ROW + 3, color: LABEL });
  page.drawRectangle({ x: 384, y: bottom - rightRows * ROW - 3, width: 106, height: rightRows * ROW + 3, color: LABEL });

  const first = bottom - 9.5;
  pairs(page, F, [
    ["Date of Visit:", r.visitDate],
    ["Service Type:", r.serviceType],
    ["Service Engineer:", r.engineer],
    ["Instrument Type:", r.instrument.type],
    // The module, where the work was on one; otherwise the model.
    r.instrument.module?.trim()
      ? ["Module:", r.instrument.module.trim()]
      : ["Model Number:", r.instrument.model],
    ["Serial Number:", r.instrument.serial],
    ["Work Completed:", r.workCompleted, F.font],
  ], 124, 127, first);

  // These are the contract's figures, not this visit's sums.
  pairs(page, F, [
    ["PO Number:", r.poNumber || DASH],
    ["Service Visit:", r.visitNumber || DASH],
    ["Total Parts:", r.balances.partsTotal || DASH],
    ["Parts Balance:", r.balances.partsRemaining || DASH],
  ], 489, 493, first);

  return bottom - leftRows * ROW - 3 - 21;
}

function requestBlock(page: PDFPage, F: Fonts, r: ServiceReport, y: number): number {
  const boxTop = band(page, F, "Service Request Information", y);
  page.drawRectangle({ x: M, y: boxTop - 2 * ROW - 3, width: 53, height: 2 * ROW + 3, color: LABEL });
  let cursor = pairs(page, F, [["Date:", r.request.date], ["From:", r.request.from]], 72, 75, boxTop - 9.5);
  for (const line of wrap(r.request.text, F.font, S.body, RIGHT - M - 4)) {
    page.drawText(line, { x: M, y: cursor, size: S.body, font: F.font, color: INK });
    cursor -= ROW;
  }
  cursor += 4;
  page.drawRectangle({ x: M, y: cursor, width: RIGHT - M, height: boxTop - cursor, borderColor: RULE, borderWidth: 0.5 });
  return cursor - 22;
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
  const boxTop = band(page, F, continued ? "Service Engineer Notes (continued)" : "Service Engineer Notes", y);
  let cursor = boxTop - 9.5;
  if (!continued) {
    page.drawRectangle({ x: M, y: boxTop - ROW - 3, width: 53, height: ROW + 3, color: LABEL });
    cursor = pairs(page, F, [["Date:", r.notes.date, F.font]], 72, 75, cursor);
  }

  // The floor is the paper, not the last line. A visit with sixty checks on it
  // used to draw them off the bottom edge, where they were in the file and
  // invisible on the page.
  const FLOOR = M + 36;
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!line.trim()) { cursor -= ROW / 2; continue; }
    const isHeading = !line.startsWith("-") && !line.startsWith(">") && !/^Expected:/.test(line)
      && (line.endsWith(":") || line === line.toUpperCase() || /^(Replaced|Performed|Installed|Cleaned|Verified)\b/.test(line));
    const f = isHeading ? F.bold : F.font;
    const indent = line.startsWith("-") ? 2 : 0;
    const segs = wrap(line, f, S.body, RIGHT - M - 4 - indent);
    if (cursor - (segs.length - 1) * ROW < FLOOR) break;
    for (const [n, seg] of segs.entries()) {
      page.drawText(seg, { x: M + indent + (n ? 8 : 0), y: cursor, size: S.body, font: f, color: INK });
      cursor -= ROW;
    }
  }
  cursor += 4;
  page.drawRectangle({ x: M, y: cursor, width: RIGHT - M, height: boxTop - cursor, borderColor: RULE, borderWidth: 0.5 });
  return { left: lines.slice(i) };
}

/** Column geometry shared by the three tables, so their grids line up. */
const COLS = [
  { x: M, w: 210, align: "left" as const },
  { x: 230, w: 104, align: "center" as const },
  { x: 334, w: 52, align: "center" as const },
  { x: 386, w: 51, align: "center" as const },
  { x: 437, w: 54, align: "center" as const },
  { x: 491, w: RIGHT - 491, align: "right" as const },
];

function cell(page: PDFPage, s: string, i: number, y: number, f: PDFFont, size = S.cell) {
  const c = COLS[i];
  let sz = size;
  while (sz > 5 && f.widthOfTextAtSize(s, sz) > c.w - 6) sz -= 0.5;
  const w = f.widthOfTextAtSize(s, sz);
  const x = c.align === "left" ? c.x + 2 : c.align === "right" ? c.x + c.w - 4 - w : c.x + (c.w - w) / 2;
  page.drawText(s, { x, y, size: sz, font: f, color: INK });
}

/** A dollar sign against the left of a column and the figure against the right, the way a ledger sets it. */
function moneyCell(page: PDFPage, F: Fonts, i: number, amount: string, y: number, f = F.font) {
  const c = COLS[i];
  page.drawText("$", { x: c.x + 4, y, size: S.cell, font: f, color: INK });
  right(page, amount, c.x + c.w - 4, y, f, S.cell);
}

function lineTable(
  page: PDFPage, F: Fonts, title: string, heads: string[], rows: ReportLine[], y: number,
  kind: "calibration" | "billed", minRows: number,
): number {
  let cursor = band(page, F, title, y, { centered: true });

  page.drawRectangle({ x: M, y: cursor - ROW, width: RIGHT - M, height: ROW, color: HEAD });
  for (const [i, h] of heads.entries()) cell(page, h, i, cursor - ROW + 3.5, F.bold);
  cursor -= ROW;

  const count = Math.max(rows.length, minRows);
  const gridTop = cursor;
  for (let i = 0; i < count; i++) {
    const ry = cursor - ROW;
    const row = rows[i];
    if (row) {
      cell(page, row.description, 0, ry + 3.5, F.font);
      cell(page, row.partNumber, 1, ry + 3.5, F.font);
      cell(page, String(row.quantity), 2, ry + 3.5, F.font);
      if (kind === "calibration") {
        cell(page, row.lot || DASH, 3, ry + 3.5, F.font);
        cell(page, row.cal || DASH, 4, ry + 3.5, F.font);
        cell(page, row.expires || DASH, 5, ry + 3.5, F.font);
      } else {
        moneyCell(page, F, 3, money(row.unitCents ?? 0), ry + 3.5);
        if (row.taxExempt) cell(page, "X", 4, ry + 3.5, F.font);
        moneyCell(page, F, 5, row.quantity ? money((row.unitCents ?? 0) * row.quantity) : DASH, ry + 3.5);
      }
    }
    page.drawLine({ start: { x: M, y: ry }, end: { x: RIGHT, y: ry }, thickness: 0.4, color: RULE });
    cursor = ry;
  }
  // Verticals last, so they sit over the row rules like the original's grid.
  for (const c of [...COLS.map((c) => c.x), RIGHT]) {
    page.drawLine({ start: { x: c, y: gridTop }, end: { x: c, y: cursor }, thickness: 0.4, color: RULE });
  }
  return cursor - 16;
}

function balancesAndTotals(page: PDFPage, F: Fonts, r: ServiceReport, y: number): number {
  const t = reportTotals(r);
  const leftW = 210;

  // Left: the contract's balances, under their own short band.
  band(page, F, "Remaining Balances:", y, { width: leftW });
  let ly = y - 13.5 - 9.5;
  for (const line of ["Remaining balances for current contract upon", "completion of this service visit."]) {
    centered(page, line, M, M + leftW, ly, F.italic, S.body);
    ly -= ROW;
  }
  for (const [label, value] of [
    ["Service Visits Remaining:", r.balances.visitsRemaining || DASH],
    ["Parts Allowance Remaining:", r.balances.partsRemaining || DASH],
  ]) {
    page.drawRectangle({ x: 125, y: ly - 3.5, width: M + leftW - 125, height: ROW, color: LABEL });
    right(page, label, 122, ly, F.bold, S.body);
    centered(page, value, 125, M + leftW, ly, F.bold, S.body);
    ly -= ROW;
  }

  // Right: the totals stack, in the table's own columns - the label across
  // Quantity and Unit Price, a spare cell where the sheet shows a tax rate,
  // then the figure under Total.
  const labelCell = { x: COLS[2].x, w: COLS[2].w + COLS[3].w };
  const rows: [string, string, boolean][] = [
    ["Total Parts", t.parts ? money(t.parts) : DASH, false],
    ["Total Labor", t.labor ? money(t.labor) : DASH, false],
    ["Sub Total", t.sub ? money(t.sub) : DASH, false],
    ["Adjustments", t.adjustment ? `(${money(Math.abs(t.adjustment))})` : DASH, true],
    ["Total Amount Due", t.due ? money(t.due) : DASH, true],
  ];
  let ty = y;
  for (const [i, [label, value, strong]] of rows.entries()) {
    const last = i === rows.length - 1;
    const f = strong ? F.bold : F.font;
    for (const c of [labelCell, COLS[4], COLS[5]]) {
      page.drawRectangle({
        x: c.x, y: ty - ROW, width: c.w, height: ROW,
        color: last ? BAND : BOX, borderColor: RULE, borderWidth: 0.5,
      });
    }
    right(page, label, labelCell.x + labelCell.w - 4, ty - ROW + 3.5, f, S.body);
    moneyCell(page, F, 5, value, ty - ROW + 3.5, f);
    ty -= ROW;
  }
  return Math.min(ly, ty) - 88;
}

async function signatures(doc: PDFDocument, page: PDFPage, F: Fonts, r: ServiceReport, lineY: number) {
  const provider = r.signatures.providerOrg?.trim() || "Service";
  const blocks = [
    { x: 75, w: 206, role: `${provider} Field Service Engineer:`, name: r.signatures.providerName, img: r.signatures.providerImage },
    { x: 331, w: 209, role: `${r.signatures.customerOrg} Representative Signature`, name: `Rep Name: ${r.signatures.customerName || "Unspecified"}`, img: r.signatures.customerImage },
  ];
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
    page.drawLine({ start: { x: b.x, y: lineY }, end: { x: b.x + b.w, y: lineY }, thickness: 1.2, color: INK });
    centered(page, b.role, b.x, b.x + b.w, lineY - 10, F.boldItalic, S.body);
    centered(page, b.name, b.x, b.x + b.w, lineY - 23, F.boldItalic, S.body);
  }

  let cy = lineY - 49;
  const line = (s: string, f: PDFFont, size: number, color = INK) => {
    centered(page, s, M, RIGHT, cy, f, size, color);
    cy -= ROW;
  };
  line("Signatures acknowledge to all information in this document to be true and service to have been completed as described.",
    F.boldItalic, 8);
  cy -= ROW;
  line("THIS IS NOT AN INVOICE", F.boldItalic, 9);
  line("Should you have any questions or require additional details about this service visit please don't hesitate to contact:",
    F.bold, S.body);
  line(r.contact, F.font, S.body, MUT);
}

function footer(page: PDFPage, F: Fonts, n: number) {
  right(page, `[Page ${n}]`, RIGHT, 44, F.bold, 8, MUT);
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
