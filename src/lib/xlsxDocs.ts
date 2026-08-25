import path from "node:path";
import ExcelJS from "exceljs";

/**
 * The paperwork, in the shop's own Excel layouts.
 *
 * The three files in /templates ARE the layout: fonts, merges, the wire
 * transfer block, the FedEx note - all of it is edited in Excel, committed,
 * and deployed, and this module never touches any of it. What it does is
 * write DATA into a fixed set of cells, listed per document below. Move a
 * label, restyle a block, add a logo: no code changes. Move one of the cells
 * this module WRITES, and its entry below is the only thing to update.
 *
 * Two conventions the templates carry and this module honors:
 *   - A line row computes its own total (the K/J formula the template ships),
 *     so a person can open the exported file and tweak a quantity and watch
 *     the total move. We write inputs, never computed totals.
 *   - The table holds 16 rows. A document with more lines gets rows INSERTED
 *     inside the table (style copied from the row above) and the summary
 *     formulas rewritten to cover the widened range - the alternative is a
 *     17th line that silently falls out of the total.
 */

export type DocLine = {
  description: string;
  partNumber?: string;
  /** Real units - 2.5 hours is 2.5, not thousandths. */
  qty: number;
  /** Dollars, not cents: the sheet is a human surface and formats currency itself. */
  unitPrice: number;
  taxExempt?: boolean;
};

export type DocParty = { name: string; address: string };

const templatePath = (file: string) => path.join(process.cwd(), "templates", file);

/** "780 Chadbourne Ave.,\nFairfield, CA" -> up to `n` display lines. */
const addressLines = (address: string, n: number): string[] => {
  const parts = address.split(/\n|,\s*(?=[A-Z][a-z]+,?\s+[A-Z]{2})/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= n) return parts;
  return [...parts.slice(0, n - 1), parts.slice(n - 1).join(", ")];
};

const asDate = (iso: string): Date | string =>
  /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00Z`) : iso;

type Fam = {
  file: string;
  sheet: string;
  dateCell: string; numberCell: string;
  customerRows: [number, number, number]; customerCol: string;
  firstLine: number; lineRows: number;
  totalCol: "K" | "J";
  /** Columns a line writes: desc, part, qty, unit, exempt (exempt "" = none). */
  cols: { desc: string; part: string; qty: string; unit: string; exempt: string };
  /** Merged spans re-created on inserted rows: [startCol, endCol] pairs. */
  rowMerges: [string, string][];
  /** Summary rows, as offsets from the row after the table. */
  summary: (ws: ExcelJS.Worksheet, lastLine: number) => void;
};

const writeLines = (ws: ExcelJS.Worksheet, fam: Fam, lines: DocLine[]) => {
  const extra = Math.max(0, lines.length - fam.lineRows);
  if (extra > 0) {
    // Widen the table from its second row so the first row's (sometimes
    // different) formula stays put and every insertion lands INSIDE the
    // summed range rather than after it.
    ws.duplicateRow(fam.firstLine + 1, extra, true);
    for (let i = 0; i < extra; i++) {
      const r = fam.firstLine + 2 + i;
      for (const [a, b] of fam.rowMerges) {
        try { ws.mergeCells(`${a}${r}:${b}${r}`); } catch { /* already merged by the copy */ }
      }
    }
  }
  const last = fam.firstLine + fam.lineRows - 1 + extra;
  for (let i = 0; i < fam.lineRows + extra; i++) {
    const r = fam.firstLine + i;
    const l = lines[i];
    ws.getCell(`${fam.cols.desc}${r}`).value = l ? l.description : null;
    ws.getCell(`${fam.cols.part}${r}`).value = l?.partNumber || null;
    ws.getCell(`${fam.cols.qty}${r}`).value = l ? l.qty : null;
    ws.getCell(`${fam.cols.unit}${r}`).value = l ? l.unitPrice : null;
    if (fam.cols.exempt) ws.getCell(`${fam.cols.exempt}${r}`).value = l?.taxExempt ? "X" : null;
    // Every row - original and inserted - carries the template's own formula,
    // rewritten to its own row number.
    const c = fam.totalCol;
    ws.getCell(`${c}${r}`).value = {
      formula: `IF(AND(SUM(I${r}*H${r})=0, ${fam.cols.desc}${r}=""), "", SUM(I${r}*H${r}))`,
    } as ExcelJS.CellFormulaValue;
  }
  fam.summary(ws, last);
  return last;
};

const fillCommon = async (fam: Fam, d: {
  number: string; date: string; customer: DocParty; lines: DocLine[];
}) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath(fam.file));
  const ws = wb.getWorksheet(fam.sheet);
  if (!ws) throw new Error(`Sheet "${fam.sheet}" not found in ${fam.file} - was the template renamed?`);
  ws.getCell(fam.dateCell).value = asDate(d.date);
  ws.getCell(fam.numberCell).value = d.number;
  const [r1, r2, r3] = fam.customerRows;
  const addr = addressLines(d.customer.address, 2);
  ws.getCell(`${fam.customerCol}${r1}`).value = d.customer.name;
  ws.getCell(`${fam.customerCol}${r2}`).value = addr[0] ?? "";
  ws.getCell(`${fam.customerCol}${r3}`).value = addr[1] ?? "";
  writeLines(ws, fam, d.lines);
  return { wb, ws };
};

// ── Invoice: templates/InvoiceTemplate.xlsx, sheet "Invoice_" ───────────────
// C2 date · C4 invoice # · C5 customer PO · I9-I11 customer block
// B17 description · B18 detail/period · lines 25-40 (B desc, F part#, H qty,
// I unit price, J tax-exempt X, K total formula) · K41 subtotal · K43 tax
// (=subtotal * the rate in J43, which stays the template's) · K45 total ·
// B43 payment terms line · B51 footer contact line.
export async function fillInvoiceXlsx(d: {
  number: string; date: string; customerPo: string; customer: DocParty;
  description: string; detail: string; terms: string; contactLine: string;
  lines: DocLine[];
}): Promise<Buffer> {
  const fam: Fam = {
    file: "InvoiceTemplate.xlsx", sheet: "Invoice_",
    dateCell: "C2", numberCell: "C4",
    customerRows: [9, 10, 11], customerCol: "I",
    firstLine: 25, lineRows: 16, totalCol: "K",
    cols: { desc: "B", part: "F", qty: "H", unit: "I", exempt: "J" },
    rowMerges: [["B", "E"], ["F", "G"], ["K", "L"]],
    summary: (ws, last) => {
      ws.getCell(`K${last + 1}`).value = { formula: `SUM(K${25}:L${last})` };
      ws.getCell(`K${last + 3}`).value = { formula: `K${last + 1}*J${last + 3}` };
      ws.getCell(`K${last + 5}`).value = { formula: `SUM(K${last + 1}:L${last + 4})` };
    },
  };
  const { wb, ws } = await fillCommon(fam, d);
  ws.getCell("C5").value = d.customerPo || "-";
  ws.getCell("B17").value = d.description;
  ws.getCell("B18").value = d.detail || null;
  const last = fam.firstLine + fam.lineRows - 1 + Math.max(0, d.lines.length - fam.lineRows);
  ws.getCell(`B${last + 3}`).value = d.terms || "Payment due upon Invoice";
  ws.getCell(`B${last + 11}`).value = d.contactLine || "";
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── Quote: templates/QuoteTemplate.xlsx, sheet "Quote" ──────────────────────
// C3 date · C5 quote # · I9-I11 customer block · B16 greeting · B17 the job ·
// S17-U21 equipment (module/model/serial, 5 rows) · lines 25-40 as invoice ·
// K41 subtotal · K45 total · B43-B45 comments · B51 footer contact line.
export async function fillQuoteXlsx(d: {
  number: string; date: string; customer: DocParty;
  title: string; comments: string[]; contactLine: string;
  equipment?: { module: string; model: string; serial: string }[];
  lines: DocLine[];
}): Promise<Buffer> {
  const fam: Fam = {
    file: "QuoteTemplate.xlsx", sheet: "Quote",
    dateCell: "C3", numberCell: "C5",
    customerRows: [9, 10, 11], customerCol: "I",
    firstLine: 25, lineRows: 16, totalCol: "K",
    cols: { desc: "B", part: "F", qty: "H", unit: "I", exempt: "J" },
    rowMerges: [["B", "E"], ["F", "G"], ["K", "L"]],
    summary: (ws, last) => {
      ws.getCell(`K${last + 1}`).value = { formula: `SUM(K${25}:L${last})` };
      // The quote's own total formula: subtotal + adjustments.
      ws.getCell(`K${last + 5}`).value = { formula: `K${last + 1}+K${last + 2}` };
    },
  };
  const { wb, ws } = await fillCommon(fam, d);
  ws.getCell("B17").value = d.title;
  (d.equipment ?? []).slice(0, 5).forEach((e, i) => {
    ws.getCell(`S${17 + i}`).value = e.module;
    ws.getCell(`T${17 + i}`).value = e.model;
    ws.getCell(`U${17 + i}`).value = e.serial;
  });
  const last = fam.firstLine + fam.lineRows - 1 + Math.max(0, d.lines.length - fam.lineRows);
  d.comments.slice(0, 3).forEach((c, i) => { ws.getCell(`B${last + 3 + i}`).value = c; });
  ws.getCell(`B${last + 11}`).value = d.contactLine || "";
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── Purchase order: templates/POTemplate.xlsx, sheet "Purchase Order" ───────
// C2 date · C4 PO # · I8-I11 vendor block · B15 salesperson / D15 quote # /
// F15 requisitioner / H15 shipper / I15 F.O.B / J15 terms · lines 20-35
// (B desc, F part#, H qty, I unit price, J total formula) · J36 subtotal ·
// J39 total · B38-B39 comments · C45 footer contact line.
export async function fillPoXlsx(d: {
  number: string; date: string; vendor: DocParty;
  orderedBy: string; reference: string; shipVia: string; terms: string;
  comments: string[]; contactLine: string;
  lines: DocLine[];
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath("POTemplate.xlsx"));
  const ws = wb.getWorksheet("Purchase Order");
  if (!ws) throw new Error(`Sheet "Purchase Order" not found - was the template renamed?`);
  ws.getCell("C2").value = asDate(d.date);
  ws.getCell("C4").value = d.number;
  const addr = addressLines(d.vendor.address, 3);
  ws.getCell("I8").value = d.vendor.name;
  ws.getCell("I9").value = addr[0] ?? "";
  ws.getCell("I10").value = addr[1] ?? "";
  ws.getCell("I11").value = addr[2] ?? "";
  ws.getCell("B15").value = d.orderedBy || null;
  ws.getCell("D15").value = d.reference || null;
  ws.getCell("H15").value = d.shipVia || null;
  ws.getCell("J15").value = d.terms || null;

  const FIRST = 20, ROWS = 16;
  const extra = Math.max(0, d.lines.length - ROWS);
  if (extra > 0) {
    ws.duplicateRow(FIRST + 1, extra, true);
    for (let i = 0; i < extra; i++) {
      const r = FIRST + 2 + i;
      for (const [a, b] of [["B", "E"], ["F", "G"], ["J", "K"]] as const) {
        try { ws.mergeCells(`${a}${r}:${b}${r}`); } catch { /* already merged */ }
      }
    }
  }
  const last = FIRST + ROWS - 1 + extra;
  for (let i = 0; i < ROWS + extra; i++) {
    const r = FIRST + i;
    const l = d.lines[i];
    ws.getCell(`B${r}`).value = l ? l.description : null;
    ws.getCell(`F${r}`).value = l?.partNumber || null;
    ws.getCell(`H${r}`).value = l ? l.qty : null;
    ws.getCell(`I${r}`).value = l ? l.unitPrice : null;
    ws.getCell(`J${r}`).value = { formula: `IF(AND(SUM(I${r}*H${r})=0, B${r}=""), "", SUM(I${r}*H${r}))` };
  }
  ws.getCell(`J${last + 1}`).value = { formula: `SUM(J${FIRST}:K${last})` };
  ws.getCell(`J${last + 4}`).value = { formula: `SUM(J${last + 1}:K${last + 3})` };
  d.comments.slice(0, 2).forEach((c, i) => { ws.getCell(`B${last + 3 + i}`).value = c; });
  ws.getCell(`C${last + 10}`).value = d.contactLine || "";
  return Buffer.from(await wb.xlsx.writeBuffer());
}
