// The geometry of a printed PM sheet, in one place, frozen onto every sheet.
//
// The sheet has to be READ BACK by pixels, so where each box sits is not a
// style choice - it is a contract between the printer and the mark reader.
// Coordinates are fractions of the page (0..1 of width and height), so a
// dewarped photo of any resolution maps onto them by multiplication, and the
// same numbers draw the boxes in CSS as percentages. Letter, portrait.
//
// Frozen onto sheet_instances.layout at print time and never recomputed for
// a sheet already printed: LAYOUT_VERSION changes when these numbers do, and a
// sheet printed under the old numbers is read under the old numbers.

export const LAYOUT_VERSION = 1;

/** A box, as fractions of the page. */
export type Box = { x: number; y: number; w: number; h: number };

export type SheetRowSpec = {
  key: string;
  title: string;
  unit?: string;
  intervalDays?: number | null;
  partNumber?: string;
  /** Whether a reading is expected - draws comb cells. */
  reading?: boolean;
};

export type RowLayout = {
  key: string;
  /** The three tri-state boxes. */
  done: Box; skip: Box; na: Box;
  /** Comb cells for a reading, left to right. Empty when no reading is asked. */
  comb: Box[];
};

export type SheetLayout = {
  version: number;
  /** Letter portrait, but only the ratio is load-bearing. */
  page: { widthIn: number; heightIn: number };
  /** Rows per page one; further rows continue on page two at the same pitch. */
  rowsPerPage: number;
  header: { qr: Box; title: Box };
  rows: RowLayout[];
  findings: Box;
  privateNotes: Box;
  technicianSign: Box;
  custodianSign: Box;
};

// Geometry, in fractions. Chosen so a 7 mm box prints at ~0.9 x 0.9 of a
// row pitch and a phone photo at 1500 px tall gives ~36 px per box - enough
// for a fill ratio to be unambiguous with a pen.
const MARGIN_X = 0.06;
const HEADER_H = 0.15;
const ROW_PITCH = 0.034;
const BOX = 0.026;          // box edge as fraction of page HEIGHT
const BOX_W = BOX * (11 / 8.5); // same edge as fraction of page WIDTH (keeps it square)
const ROWS_PER_PAGE = 16;
const COMB_CELLS = 6;

export function buildLayout(rows: SheetRowSpec[]): SheetLayout {
  const rowLayouts: RowLayout[] = rows.map((r, i) => {
    const onPage = i % ROWS_PER_PAGE;
    const y = HEADER_H + onPage * ROW_PITCH + (ROW_PITCH - BOX) / 2;
    const box = (x: number): Box => ({ x, y, w: BOX_W, h: BOX });
    // Title occupies the left; the three boxes sit in a fixed column; the comb
    // sits right of them so a reading is never mistaken for a tick.
    const doneX = 0.60, skipX = doneX + BOX_W * 1.4, naX = skipX + BOX_W * 1.4;
    const combX0 = naX + BOX_W * 1.9;
    const comb = r.reading
      ? Array.from({ length: COMB_CELLS }, (_, c) => ({ x: combX0 + c * BOX_W * 0.85, y, w: BOX_W * 0.8, h: BOX }))
      : [];
    return { key: r.key, done: box(doneX), skip: box(skipX), na: box(naX), comb };
  });
  return {
    version: LAYOUT_VERSION,
    page: { widthIn: 8.5, heightIn: 11 },
    rowsPerPage: ROWS_PER_PAGE,
    header: { qr: { x: MARGIN_X, y: 0.03, w: 0.11, h: 0.085 }, title: { x: MARGIN_X + 0.13, y: 0.03, w: 0.75, h: 0.085 } },
    rows: rowLayouts,
    findings: { x: MARGIN_X, y: 0.72, w: 1 - 2 * MARGIN_X, h: 0.10 },
    privateNotes: { x: MARGIN_X, y: 0.83, w: 1 - 2 * MARGIN_X, h: 0.06 },
    technicianSign: { x: MARGIN_X, y: 0.905, w: 0.40, h: 0.05 },
    custodianSign: { x: 0.54, y: 0.905, w: 0.40, h: 0.05 },
  };
}

/** Which page (0-based) a row prints on. */
export const pageOfRow = (layout: SheetLayout, index: number): number => Math.floor(index / layout.rowsPerPage);

/** A layout coming back out of jsonb, checked before the reader trusts it. */
export function isSheetLayout(x: unknown): x is SheetLayout {
  const l = x as SheetLayout;
  return !!l && typeof l === "object" && typeof l.version === "number" && Array.isArray(l.rows)
    && l.rows.every((r) => r && typeof r.key === "string" && r.done && r.skip && r.na && Array.isArray(r.comb));
}
