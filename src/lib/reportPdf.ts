// An expense report as one PDF: the claim, its rows, and the paper behind them.
//
// This is the thing that gets emailed to an accountant, and the reason it is a
// PDF rather than the CSV next door is that a spreadsheet cannot hold a
// receipt. A bookkeeper substantiating a $340 hotel line wants to see the
// folio, on the page after the line, without opening a second attachment and
// working out which of forty files it is.
//
// So: a summary page, a table of rows, then one page per receipt, captioned
// with the row it belongs to. Receipts that are already PDFs have their pages
// copied in whole - an emailed invoice is often several pages and cropping it
// to the first would lose the total.
//
// pdf-lib only, which is plain JavaScript: no native binaries, so this runs in
// a serverless function and in vitest, where the tests re-parse the output
// rather than trusting that drawing calls happened. Same discipline and the
// same palette as lib/pdfCombine, which does the neighbouring job.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { dollars } from "@/lib/accountingExport";
import { policyCell, receiptCell, reportCents, reportStanding, type ExportReport } from "@/lib/reportExport";

const NAVY = rgb(0.09, 0.165, 0.29);
const MUT = rgb(0.39, 0.45, 0.55);
const LINE = rgb(0.85, 0.88, 0.92);
const WARN = rgb(0.62, 0.36, 0.03);

/** US Letter, portrait - the shop prints on it. */
const PAGE: [number, number] = [612, 792];
const MARGIN = 54;

/** The receipt bytes for one row, fetched by the caller. */
export type ReceiptBlob = {
  /** Index into the report's own expense list, so a caption can name the row. */
  expenseIndex: number;
  name: string;
  /** image/jpeg, image/png or application/pdf. Anything else is listed, not drawn. */
  contentType: string;
  bytes: Uint8Array;
};

/** Trim to what fits; a cell must never bleed into the next column. */
const fit = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** Right-align a number in a money column. */
function drawRight(page: PDFPage, text: string, right: number, y: number, size: number, font: PDFFont, color = NAVY) {
  page.drawText(text, { x: right - font.widthOfTextAtSize(text, size), y, size, font, color });
}

/**
 * Wrap on words, to a pixel width rather than a character count.
 *
 * A purpose line is free text somebody typed on a phone; measuring it is the
 * difference between a paragraph and a sentence with its end cut off.
 */
function wrap(text: string, font: PDFFont, size: number, width: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
    if (line) lines.push(line);
    line = w;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

/**
 * The claim as a PDF.
 *
 * `receipts` is what the caller managed to fetch. A row whose receipt could
 * not be downloaded is not silently dropped: it keeps its "MISSING" in the
 * table, which is exactly the column an auditor sorts on, and the packet is
 * honest about having less paper than the claim says it should.
 */
export async function reportPdf(report: ExportReport, receipts: ReceiptBlob[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const inner = PAGE[0] - MARGIN * 2;

  doc.setTitle(report.title || `Expense report ${report.id}`);
  doc.setSubject(`Reimbursement claim for ${report.person}`);

  let page = doc.addPage(PAGE);
  let y = PAGE[1] - MARGIN;

  // ── The claim ──────────────────────────────────────────────────────────
  page.drawText(fit(report.title || `Expense report ${report.id}`, 52), {
    x: MARGIN, y: y - 20, size: 20, font: bold, color: NAVY,
  });
  y -= 30;
  page.drawLine({
    start: { x: MARGIN, y }, end: { x: PAGE[0] - MARGIN, y }, thickness: 2, color: NAVY,
  });
  y -= 22;

  const facts: [string, string][] = [
    ["Claimant", report.person],
    ["Job", report.workOrderNumber || "Overhead - no job"],
    ["Standing", reportStanding(report)],
    ["Opened by", report.openedBy || report.person],
    ["Report", `#${report.id}`],
  ];
  for (const [label, value] of facts) {
    page.drawText(label, { x: MARGIN, y, size: 9, font, color: MUT });
    page.drawText(fit(value, 70), { x: MARGIN + 90, y, size: 9, font: bold, color: NAVY });
    y -= 15;
  }

  if (report.purpose) {
    y -= 6;
    page.drawText("What it was for", { x: MARGIN, y, size: 9, font, color: MUT });
    y -= 14;
    for (const line of wrap(report.purpose, font, 10, inner, 4)) {
      page.drawText(line, { x: MARGIN, y, size: 10, font, color: NAVY });
      y -= 13;
    }
  }

  // ── The rows ───────────────────────────────────────────────────────────
  y -= 16;
  const COLS = { date: MARGIN, kind: MARGIN + 62, desc: MARGIN + 140, receipt: MARGIN + 330, policy: MARGIN + 400, amount: PAGE[0] - MARGIN };

  const header = () => {
    page.drawText("Date", { x: COLS.date, y, size: 8, font: bold, color: MUT });
    page.drawText("Category", { x: COLS.kind, y, size: 8, font: bold, color: MUT });
    page.drawText("What it was", { x: COLS.desc, y, size: 8, font: bold, color: MUT });
    page.drawText("Receipt", { x: COLS.receipt, y, size: 8, font: bold, color: MUT });
    page.drawText("Policy", { x: COLS.policy, y, size: 8, font: bold, color: MUT });
    drawRight(page, "Amount", COLS.amount, y, 8, bold, MUT);
    y -= 6;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE[0] - MARGIN, y }, thickness: 0.7, color: LINE });
    y -= 13;
  };
  header();

  for (const e of report.expenses) {
    // Two lines per row at worst - the description and a policy note - so the
    // break is checked against both rather than against the row's first line.
    if (y < MARGIN + 60) {
      page = doc.addPage(PAGE);
      y = PAGE[1] - MARGIN;
      header();
    }
    page.drawText(e.incurredOn || "-", { x: COLS.date, y, size: 8.5, font, color: NAVY });
    page.drawText(fit(e.kind, 14), { x: COLS.kind, y, size: 8.5, font, color: NAVY });
    page.drawText(fit(e.description, 36), { x: COLS.desc, y, size: 8.5, font, color: NAVY });
    page.drawText(fit(receiptCell(e.receiptName), 12), {
      x: COLS.receipt, y, size: 8.5, font,
      // The one cell worth colouring: no paper behind a line is the thing an
      // auditor is looking for, and it should be findable at arm's length.
      color: e.receiptName.trim() ? MUT : WARN,
    });
    page.drawText(fit(policyCell(e.allowanceState), 14), {
      x: COLS.policy, y, size: 8.5, font,
      color: e.allowanceState === "flagged" ? WARN : MUT,
    });
    drawRight(page, dollars(e.amountCents), COLS.amount, y, 8.5, bold);
    y -= 12;
    if (e.allowanceNote && e.allowanceState) {
      for (const line of wrap(e.allowanceNote, font, 7.5, inner - 80, 2)) {
        page.drawText(line, { x: COLS.desc, y, size: 7.5, font, color: MUT });
        y -= 10;
      }
      if (e.allowanceBy) {
        page.drawText(fit(`Approved by ${e.allowanceBy}`, 60), { x: COLS.desc, y, size: 7.5, font, color: MUT });
        y -= 10;
      }
    }
    y -= 3;
  }

  if (!report.expenses.length) {
    page.drawText("Nothing on this report.", { x: MARGIN, y, size: 9, font, color: MUT });
    y -= 14;
  }

  y -= 4;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE[0] - MARGIN, y }, thickness: 1, color: NAVY });
  y -= 16;
  page.drawText("Total", { x: COLS.policy, y, size: 11, font: bold, color: NAVY });
  drawRight(page, dollars(reportCents(report)), COLS.amount, y, 11, bold);

  // ── The paper ──────────────────────────────────────────────────────────
  for (const r of receipts) {
    const e = report.expenses[r.expenseIndex];
    const caption = e
      ? `${e.incurredOn} · ${e.kind} · ${dollars(e.amountCents)} · ${e.description}`
      : r.name;

    if (r.contentType === "application/pdf") {
      // Copied whole. An emailed invoice is often several pages and taking the
      // first would lose the total, which is the number being substantiated.
      try {
        const src = await PDFDocument.load(r.bytes, { ignoreEncryption: true });
        const copied = await doc.copyPages(src, src.getPageIndices());
        for (const p of copied) doc.addPage(p);
        continue;
      } catch {
        // A PDF pdf-lib will not parse gets a placeholder page rather than
        // sinking the whole export - the claim is still worth sending.
        const p = doc.addPage(PAGE);
        p.drawText(fit(caption, 70), { x: MARGIN, y: PAGE[1] - MARGIN, size: 10, font: bold, color: NAVY });
        p.drawText(`Receipt "${fit(r.name, 50)}" could not be read.`, {
          x: MARGIN, y: PAGE[1] - MARGIN - 24, size: 9, font, color: WARN,
        });
        continue;
      }
    }

    let image;
    try {
      image = r.contentType === "image/png"
        ? await doc.embedPng(r.bytes)
        : await doc.embedJpg(r.bytes);
    } catch {
      const p = doc.addPage(PAGE);
      p.drawText(fit(caption, 70), { x: MARGIN, y: PAGE[1] - MARGIN, size: 10, font: bold, color: NAVY });
      p.drawText(`Receipt "${fit(r.name, 50)}" is in a format this export cannot embed.`, {
        x: MARGIN, y: PAGE[1] - MARGIN - 24, size: 9, font, color: WARN,
      });
      continue;
    }

    const p = doc.addPage(PAGE);
    p.drawText(fit(caption, 78), { x: MARGIN, y: PAGE[1] - MARGIN, size: 9, font: bold, color: NAVY });
    // Fit inside the margins, keeping the aspect ratio: a receipt is usually
    // tall and narrow, and stretching one to the page makes the print unreadable.
    const boxW = inner;
    const boxH = PAGE[1] - MARGIN * 2 - 24;
    const scale = Math.min(boxW / image.width, boxH / image.height, 1);
    const w = image.width * scale;
    const h = image.height * scale;
    p.drawImage(image, { x: MARGIN + (boxW - w) / 2, y: MARGIN + (boxH - h) / 2, width: w, height: h });
  }

  // ── Numbering, over the finished packet ────────────────────────────────
  const total = doc.getPageCount();
  for (let n = 0; n < total; n++) {
    const p = doc.getPage(n);
    const { width } = p.getSize();
    const label = `${report.person} · report #${report.id} · page ${n + 1} of ${total}`;
    p.drawText(label, {
      x: width - MARGIN - font.widthOfTextAtSize(label, 7.5), y: 24, size: 7.5, font, color: MUT,
    });
  }

  return doc.save();
}
