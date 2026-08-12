// Filling a workbook that somebody else designed.
//
// The service report was built in Excel, and it stays built in Excel. This module
// opens a copy of that workbook, writes values into the cells that ask for them,
// grows the tables to fit the visit, and hands back .xlsx bytes. The layout,
// fonts, borders, greys, merged cells, print area and logo are never touched -
// they are whatever the template says they are.
//
// ── The bargain this makes ──────────────────────────────────────────────────
// Cells are found by what is typed in them, not by coordinate. A cell containing
// {{visitDate}} receives the visit date wherever it happens to sit. So the
// template can be rearranged, restyled, or have a column inserted in Excel by
// somebody who has never seen this file, and the fill still lands correctly. The
// alternative - "row 12, column C" - breaks the first time a row is inserted, and
// breaks silently.
//
// ── Repeating rows ──────────────────────────────────────────────────────────
// A row holding {{parts.description}} is a model row: it is filled for the first
// line item and copied, with its styles, for each one after. Copies inherit the
// model's height and every cell's format, so a table of three parts and a table
// of thirty look like the same table.
//
// Server-only: exceljs is large and has no business in a browser bundle.
import ExcelJS from "exceljs";

/** What a fill is given: flat values, and lists for the repeating blocks. */
export type FillData = {
  values: Record<string, string | number | null>;
  rows: Record<string, Record<string, string | number | null>[]>;
};

export type FillReport = {
  /** Tokens the template asked for that the data did not have. */
  unknown: string[];
  /** Tokens the data offered that the template never asked for. */
  unused: string[];
  filled: number;
  rowsAdded: number;
};

const TOKEN = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** Every token in a string, in order. */
export function tokensIn(text: string): string[] {
  return [...text.matchAll(TOKEN)].map((m) => m[1]);
}

/**
 * Which tokens a template contains, so a template can be checked against the
 * data the app can actually supply before anybody trusts it with a client's
 * report. `list` names the repeating blocks - `parts` for `{{parts.description}}`.
 */
export function templateTokens(text: string): { flat: string[]; list: string[] } {
  const flat = new Set<string>();
  const list = new Set<string>();
  for (const t of tokensIn(text)) {
    const dot = t.indexOf(".");
    if (dot > 0) list.add(t.slice(0, dot));
    else flat.add(t);
  }
  return { flat: [...flat].sort(), list: [...list].sort() };
}

/** The substitution itself: a lone token adopts its value's type, so numbers stay numbers. */
export function substitute(
  text: string, lookup: (name: string) => string | number | null | undefined,
): { value: string | number | null; missing: string[] } {
  const missing: string[] = [];
  const names = tokensIn(text);
  if (!names.length) return { value: text, missing };

  const whole = text.trim().match(/^\{\{\s*([A-Za-z0-9_.]+)\s*\}\}$/);
  if (whole) {
    const v = lookup(whole[1]);
    if (v === undefined) { missing.push(whole[1]); return { value: text, missing }; }
    // A cell that is nothing but a token keeps the value's own type, so Excel
    // still treats a price as a price and the template's number format applies.
    return { value: v, missing };
  }
  const out = text.replace(TOKEN, (_m, name: string) => {
    const v = lookup(name);
    if (v === undefined) { missing.push(name); return `{{${name}}}`; }
    return v === null ? "" : String(v);
  });
  return { value: out, missing };
}

/**
 * Fill a template workbook. Returns the new bytes and what happened, because a
 * report with a silently unfilled field is worse than one that refuses.
 */
export async function fillWorkbook(
  template: ArrayBuffer | Buffer, data: FillData,
): Promise<{ bytes: Buffer; report: FillReport }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(template as ArrayBuffer);

  const unknown = new Set<string>();
  const asked = new Set<string>();
  let filled = 0;
  let rowsAdded = 0;

  for (const sheet of wb.worksheets) {
    // Repeating blocks first: growing the sheet moves later rows, so scalar
    // fills have to happen against the final geometry, not the original.
    rowsAdded += expandBlocks(sheet, data, asked, unknown);
    filled += fillScalars(sheet, data, asked, unknown);
  }

  const offered = [
    ...Object.keys(data.values),
    ...Object.entries(data.rows).flatMap(([k, list]) =>
      [...new Set(list.flatMap((r) => Object.keys(r)))].map((c) => `${k}.${c}`)),
  ];
  const report: FillReport = {
    unknown: [...unknown].sort(),
    unused: offered.filter((k) => !asked.has(k)).sort(),
    filled, rowsAdded,
  };
  const bytes = Buffer.from(await wb.xlsx.writeBuffer());
  return { bytes, report };
}

type Sheet = ExcelJS.Worksheet;

/** Text of a cell, whether it holds a plain string or rich text. */
function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "richText" in v) {
    return (v.richText as { text: string }[]).map((r) => r.text).join("");
  }
  return "";
}

function fillScalars(sheet: Sheet, data: FillData, asked: Set<string>, unknown: Set<string>): number {
  let filled = 0;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const text = cellText(cell);
      if (!text.includes("{{")) return;
      const { value, missing } = substitute(text, (name) => {
        // A dotted token outside a repeating block is a mistake worth surfacing
        // rather than quietly blanking.
        asked.add(name);
        return data.values[name];
      });
      for (const m of missing) unknown.add(m);
      if (value !== text) { cell.value = value as ExcelJS.CellValue; filled++; }
    });
  });
  return filled;
}

/**
 * Grow each repeating block to the length of its list.
 *
 * Excel's own row insertion is what keeps this honest: `duplicateRow` carries
 * styles, and `insertRow` shifts formulas and merges below the block, so the
 * totals that sit under a parts table still point at the parts table.
 */
function expandBlocks(sheet: Sheet, data: FillData, asked: Set<string>, unknown: Set<string>): number {
  let added = 0;
  for (const [block, list] of Object.entries(data.rows)) {
    const modelRow = findModelRow(sheet, block);
    if (modelRow === null) continue;

    // One model row exists already, so N items need N-1 more. An empty list
    // leaves the model row in place and blanks it: the template's empty rows are
    // part of how the document looks, and a table that collapsed to nothing
    // would read as a different form.
    const extra = Math.max(0, list.length - 1);
    if (extra > 0) {
      sheet.duplicateRow(modelRow, extra, true);
      added += extra;
    }

    for (let i = 0; i < Math.max(1, list.length); i++) {
      const row = sheet.getRow(modelRow + i);
      const item = list[i] ?? {};
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = cellText(cell);
        if (!text.includes("{{")) return;
        const { value, missing } = substitute(text, (name) => {
          if (!name.startsWith(`${block}.`)) return undefined;
          const key = name.slice(block.length + 1);
          asked.add(name);
          // Past the end of the list the cell empties, keeping its borders.
          return list[i] === undefined ? null : item[key] ?? null;
        });
        for (const m of missing) unknown.add(m);
        cell.value = value as ExcelJS.CellValue;
      });
    }
  }
  return added;
}

/** The first row containing a token for this block. */
function findModelRow(sheet: Sheet, block: string): number | null {
  let found: number | null = null;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (found !== null) return;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (found !== null) return;
      if (tokensIn(cellText(cell)).some((t) => t.startsWith(`${block}.`))) found = rowNumber;
    });
  });
  return found;
}
