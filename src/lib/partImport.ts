// One sheet that carries a part and everybody who sells it.
//
// The catalog and the price book were two entries with two shapes: what a
// number IS lived in one, what it costs lived in the other, and filling both
// meant typing the same forty part numbers twice. A vendor's quote sheet
// arrives with the number, the description and the price on ONE line, which is
// the shape this reads.
//
// THE COLUMN LIST IS THE ONLY COPY. The template somebody downloads, the
// parser that reads what they send back, and the export of what is already on
// file all come from COLUMNS below - so a sheet exported from here can be
// edited and imported straight back, and adding a column cannot leave the
// template and the parser disagreeing about what row three means.
//
// Pure. The upsert lives in actions.importParts.

/** A column, and how a person filling it in should read the header. */
export type PartImportColumn = {
  key: keyof PartImportRow;
  header: string;
  /** Shown under the template's header row, as the example line. */
  example: string;
  /** Named so the parser can say "no part number" rather than "row 12 bad". */
  required?: boolean;
};

export type PartImportRow = {
  partNumber: string;
  name: string;
  manufacturer: string;
  mfrPartNumber: string;
  kind: string;
  fits: string;
  models: string;
  note: string;
  vendor: string;
  price: string;
  oem: string;
  leadDays: string;
  blindShip: string;
  overnight: string;
  url: string;
};

/**
 * The sheet, left to right in the order somebody fills it in: what the part is,
 * then who sells it.
 *
 * Multi-value cells (fits, models) are semicolon-separated rather than
 * comma-separated for the obvious reason - this is a CSV, and a comma inside a
 * cell survives only if the whole cell is quoted, which is exactly the thing
 * people's spreadsheets get wrong when they hand-edit an export.
 */
export const COLUMNS: PartImportColumn[] = [
  { key: "partNumber", header: "Part number", example: "228-35145-91", required: true },
  { key: "name", header: "Name", example: "Plunger seal, 10 mL" },
  { key: "manufacturer", header: "Manufacturer", example: "Shimadzu" },
  { key: "mfrPartNumber", header: "Manufacturer part number", example: "SHM-228-35145" },
  { key: "kind", header: "Kind (part/consumable/kit)", example: "consumable" },
  { key: "fits", header: "Fits module types (; separated)", example: "Pump; Autosampler" },
  { key: "models", header: "Fits models (; separated)", example: "LC-20AD; LC-20AT" },
  { key: "note", header: "Note", example: "Replace with the wash seal" },
  { key: "vendor", header: "Vendor", example: "Shimadzu" },
  { key: "price", header: "Price", example: "48.50" },
  { key: "oem", header: "OEM? (y/n)", example: "y" },
  { key: "leadDays", header: "Lead time (business days)", example: "5" },
  { key: "blindShip", header: "Blind-ships? (y/n)", example: "n" },
  { key: "overnight", header: "Overnight available? (y/n)", example: "y" },
  { key: "url", header: "Link", example: "https://example.com/228-35145-91" },
];

export const blankRow = (): PartImportRow =>
  Object.fromEntries(COLUMNS.map((c) => [c.key, ""])) as PartImportRow;

/** Header noise a spreadsheet round-trip adds: case, spaces, punctuation. */
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Match a header cell to a column.
 *
 * Generous on purpose. Somebody will send back a sheet with "PN" where the
 * template said "Part number", or their vendor's own export with "Cost" - and
 * refusing the whole file over a header spelling is how an import feature goes
 * unused. What is NOT guessed is the data: an unrecognised column is dropped
 * rather than assigned to whatever came next.
 */
const ALIASES: Record<string, keyof PartImportRow> = {
  pn: "partNumber", partno: "partNumber", partnumber: "partNumber", number: "partNumber",
  description: "name", partname: "name", part: "name",
  maker: "manufacturer", mfr: "manufacturer", brand: "manufacturer",
  mfrpn: "mfrPartNumber", manufacturerpn: "mfrPartNumber", oempartnumber: "mfrPartNumber",
  type: "kind",
  fits: "fits", moduletypes: "fits", assettypes: "fits",
  model: "models",
  notes: "note", comment: "note",
  supplier: "vendor", seller: "vendor",
  cost: "price", unitprice: "price", listprice: "price",
  oem: "oem", isoem: "oem",
  lead: "leadDays", leadtime: "leadDays", leaddays: "leadDays",
  blindship: "blindShip", dropship: "blindShip", dropships: "blindShip",
  overnight: "overnight", expedite: "overnight", rush: "overnight",
  link: "url", website: "url", vendorlink: "url",
};

export function matchHeader(cell: string): keyof PartImportRow | null {
  const k = key(cell);
  if (!k) return null;
  const exact = COLUMNS.find((c) => key(c.header) === k);
  if (exact) return exact.key;
  // The header as the template writes it carries a parenthetical; try the part
  // before it, so "Kind (part/consumable/kit)" also matches a bare "Kind".
  const head = COLUMNS.find((c) => key(c.header.split("(")[0]) === k);
  if (head) return head.key;
  return ALIASES[k] ?? null;
}

/**
 * A pasted or uploaded grid, as rows this can act on.
 *
 * The first line is treated as headers when it looks like headers - which is
 * what an exported sheet has and what a hand-pasted block of data does not.
 * Guessing wrong in the "no headers" direction would silently eat somebody's
 * first part; guessing wrong the other way puts one junk row in a preview they
 * are about to look at anyway, so the tie breaks toward keeping data.
 */
export function readGrid(grid: string[][]): PartImportRow[] {
  if (!grid.length) return [];
  const [first, ...rest] = grid;
  const matched = first.map(matchHeader);
  const looksLikeHeaders = matched.filter(Boolean).length >= 2;
  const order = looksLikeHeaders ? matched : COLUMNS.map((c) => c.key);
  const body = looksLikeHeaders ? rest : grid;

  return body.map((cells) => {
    const row = blankRow();
    order.forEach((k, i) => {
      if (!k) return;
      const v = (cells[i] ?? "").trim();
      if (v) row[k] = v;
    });
    return row;
  }).filter((r) => Object.values(r).some((v) => v !== ""));
}

/** The template, as a grid: headers, then one filled-in line to copy. */
export const templateGrid = (): string[][] => [
  COLUMNS.map((c) => c.header),
  COLUMNS.map((c) => c.example),
];

/**
 * Rows that say something, and what is wrong with the ones that do not.
 *
 * A row with no part number is the only hard failure - everything else on the
 * sheet describes a part number, so without one there is nothing to describe.
 * A row with a vendor and no price is reported rather than dropped, because
 * silently importing half of what somebody sent is worse than telling them.
 */
export type RowProblem = { line: number; partNumber: string; problem: string };

export function checkRows(rows: PartImportRow[]): { ok: PartImportRow[]; problems: RowProblem[] } {
  const ok: PartImportRow[] = [];
  const problems: RowProblem[] = [];
  rows.forEach((r, i) => {
    const line = i + 1;
    if (!r.partNumber.trim()) {
      problems.push({ line, partNumber: "", problem: "No part number" });
      return;
    }
    if (r.vendor.trim() && !r.price.trim()) {
      problems.push({ line, partNumber: r.partNumber, problem: "A vendor with no price" });
      return;
    }
    if (r.price.trim() && !r.vendor.trim()) {
      problems.push({ line, partNumber: r.partNumber, problem: "A price with no vendor" });
      return;
    }
    ok.push(r);
  });
  return { ok, problems };
}

/**
 * How many parts, and how many vendor prices, a sheet is actually about.
 *
 * Worth counting separately and showing before anybody saves: eighty lines is
 * alarming until you can see it is twenty parts with four vendors each, which
 * is what a real quote comparison looks like.
 */
export function summarize(rows: PartImportRow[]): { parts: number; prices: number } {
  const pns = new Set(rows.map((r) => r.partNumber.trim().toLowerCase()).filter(Boolean));
  return {
    parts: pns.size,
    prices: rows.filter((r) => r.vendor.trim() && r.price.trim()).length,
  };
}

/**
 * What is already on file, in the template's own columns.
 *
 * The round trip is the point: export, open it in Excel, fix the forty prices
 * that changed, import it back. That only works if what comes out is shaped
 * like what goes in, which is why this reads COLUMNS rather than listing
 * fields of its own.
 *
 * A part with three vendors is three lines, with its description repeated on
 * each. Repetition is the right call for a sheet somebody sorts and filters:
 * a blank continuation row loses its part the moment they sort by vendor.
 */
export function exportGrid(
  parts: {
    partNumber: string; name: string; manufacturer: string; mfrPartNumber: string;
    kind: string; assetTypes: string[]; models: string[]; note: string;
  }[],
  prices: {
    partNumber: string; vendor: string; priceCents: number; isOem: boolean;
    leadDays: number | null; dropShips: boolean; expediteOk: boolean; url: string;
  }[],
): string[][] {
  const yn = (b: boolean) => (b ? "y" : "n");
  const out: string[][] = [COLUMNS.map((c) => c.header)];
  for (const p of parts) {
    const mine = prices.filter((x) =>
      x.partNumber.trim().toLowerCase().replace(/\s+/g, "")
      === p.partNumber.trim().toLowerCase().replace(/\s+/g, ""));
    const part: PartImportRow = {
      ...blankRow(),
      partNumber: p.partNumber, name: p.name, manufacturer: p.manufacturer,
      mfrPartNumber: p.mfrPartNumber, kind: p.kind,
      fits: p.assetTypes.join("; "), models: p.models.join("; "), note: p.note,
    };
    if (!mine.length) {
      out.push(COLUMNS.map((c) => part[c.key]));
      continue;
    }
    for (const v of mine) {
      const row: PartImportRow = {
        ...part,
        vendor: v.vendor,
        // Plain digits, no currency symbol: what a spreadsheet can add up and
        // what the importer reads back without an opinion about locale.
        price: (v.priceCents / 100).toFixed(2),
        oem: yn(v.isOem), leadDays: v.leadDays === null ? "" : String(v.leadDays),
        blindShip: yn(v.dropShips), overnight: yn(v.expediteOk), url: v.url,
      };
      out.push(COLUMNS.map((c) => row[c.key]));
    }
  }
  return out;
}
