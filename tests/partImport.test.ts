import { describe, expect, it } from "vitest";
import {
  COLUMNS, blankRow, checkRows, exportGrid, matchHeader, readGrid, summarize, templateGrid,
} from "@/lib/partImport";
import { parseCsv, toCsv } from "@/lib/csv";

/**
 * One sheet, carrying a part and everybody who sells it.
 *
 * The property that matters most is the ROUND TRIP: what comes out has to go
 * back in unchanged, because the way this will actually be used is export,
 * edit forty prices in Excel, import. A column that survives the export but
 * not the parse loses data silently, which is the one failure mode a CSV
 * feature has and the reason the column list has exactly one copy.
 */

const part = (over: Record<string, unknown> = {}) => ({
  partNumber: "228-35145-91", name: "Plunger seal, 10 mL", manufacturer: "Shimadzu",
  mfrPartNumber: "SHM-228", kind: "consumable", assetTypes: ["Pump"], models: ["LC-20AD"],
  note: "Replace with the wash seal", ...over,
});

const price = (over: Record<string, unknown> = {}) => ({
  partNumber: "228-35145-91", vendor: "Shimadzu", priceCents: 4850, isOem: true,
  leadDays: 5, dropShips: false, expediteOk: true, url: "https://example.com/x", ...over,
});

describe("the template", () => {
  it("is the column list, headers then one filled-in line", () => {
    const grid = templateGrid();
    expect(grid).toHaveLength(2);
    expect(grid[0]).toEqual(COLUMNS.map((c) => c.header));
    expect(grid[1].filter(Boolean).length).toBe(COLUMNS.length);
  });

  it("READS ITSELF BACK - the example line survives its own headers", () => {
    // If the template's own row cannot be parsed by the parser, nothing a
    // person edits from it will be either.
    const [row] = readGrid(templateGrid());
    expect(row.partNumber).toBe("228-35145-91");
    expect(row.vendor).toBe("Shimadzu");
    expect(row.price).toBe("48.50");
  });

  it("survives a trip through a real CSV", () => {
    const [row] = readGrid(parseCsv(toCsv(templateGrid())));
    expect(row.name).toBe("Plunger seal, 10 mL");   // the comma inside the cell
    expect(row.fits).toBe("Pump; Autosampler");
  });
});

describe("reading somebody else's headers", () => {
  it("matches the template's own, punctuation and all", () => {
    expect(matchHeader("Part number")).toBe("partNumber");
    expect(matchHeader("Kind (part/consumable/kit)")).toBe("kind");
    expect(matchHeader("Kind")).toBe("kind");
  });

  it("takes the shorthand a vendor's export actually uses", () => {
    // Refusing a file over a header spelling is how an import goes unused.
    expect(matchHeader("PN")).toBe("partNumber");
    expect(matchHeader("Description")).toBe("name");
    expect(matchHeader("Cost")).toBe("price");
    expect(matchHeader("Supplier")).toBe("vendor");
    expect(matchHeader("Lead time")).toBe("leadDays");
  });

  it("drops a column it does not know rather than guessing", () => {
    // The generosity is about HEADERS, never about data: a stray column must
    // not shift everything after it one to the left.
    expect(matchHeader("Warehouse bin")).toBeNull();
    const rows = readGrid([
      ["Part number", "Warehouse bin", "Vendor", "Price"],
      ["PN-1", "A4", "Acme", "10.00"],
    ]);
    expect(rows[0]).toMatchObject({ partNumber: "PN-1", vendor: "Acme", price: "10.00" });
  });

  it("takes a headerless paste in the template's own order", () => {
    // Somebody pasting a block of data out of a sheet whose header row they
    // did not select. Losing their first part would be the worse guess.
    const rows = readGrid([["PN-1", "A seal", "Acme"]]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partNumber: "PN-1", name: "A seal", manufacturer: "Acme" });
  });

  it("ignores blank lines a spreadsheet leaves behind", () => {
    expect(readGrid([["Part number", "Name"], ["", ""], ["PN-1", "A seal"]])).toHaveLength(1);
  });
});

describe("what a sheet is about", () => {
  it("counts a part once however many vendors it has", () => {
    const rows = [
      { ...blankRow(), partNumber: "PN-1", vendor: "A", price: "1.00" },
      { ...blankRow(), partNumber: "PN-1", vendor: "B", price: "2.00" },
      { ...blankRow(), partNumber: "PN-2", vendor: "A", price: "3.00" },
    ];
    // Eighty lines is alarming until it reads as twenty parts, four vendors each.
    expect(summarize(rows)).toEqual({ parts: 2, prices: 3 });
  });

  it("counts a part with no vendor at all", () => {
    expect(summarize([{ ...blankRow(), partNumber: "PN-1", name: "A seal" }]))
      .toEqual({ parts: 1, prices: 0 });
  });
});

describe("what will not import", () => {
  it("refuses a line with no part number", () => {
    // Everything on the sheet describes a part number; without one there is
    // nothing to describe.
    const { ok, problems } = checkRows([{ ...blankRow(), name: "A seal", vendor: "Acme", price: "1" }]);
    expect(ok).toEqual([]);
    expect(problems[0]).toMatchObject({ line: 1, problem: "No part number" });
  });

  it("reports half a price rather than importing half of it", () => {
    const { ok, problems } = checkRows([
      { ...blankRow(), partNumber: "PN-1", vendor: "Acme" },
      { ...blankRow(), partNumber: "PN-2", price: "9.99" },
    ]);
    expect(ok).toEqual([]);
    expect(problems.map((p) => p.problem))
      .toEqual(["A vendor with no price", "A price with no vendor"]);
  });

  it("lets a part through with no vendor at all", () => {
    // Cataloguing a number without pricing it is the ordinary case: this is a
    // catalog first and a price sheet second.
    const { ok, problems } = checkRows([{ ...blankRow(), partNumber: "PN-1", name: "A seal" }]);
    expect(ok).toHaveLength(1);
    expect(problems).toEqual([]);
  });

  it("numbers the lines the way their spreadsheet does", () => {
    // The fix happens in their file, where a line number is the only address
    // that means anything.
    const { problems } = checkRows([
      { ...blankRow(), partNumber: "PN-1" },
      { ...blankRow(), name: "orphan" },
    ]);
    expect(problems[0].line).toBe(2);
  });
});

describe("the round trip", () => {
  it("EXPORTS WHAT THE IMPORTER READS BACK, field for field", () => {
    const grid = exportGrid([part()], [price()]);
    const [row] = readGrid(grid);
    expect(row).toMatchObject({
      partNumber: "228-35145-91", name: "Plunger seal, 10 mL", manufacturer: "Shimadzu",
      mfrPartNumber: "SHM-228", kind: "consumable",
      fits: "Pump", models: "LC-20AD", note: "Replace with the wash seal",
      vendor: "Shimadzu", price: "48.50", oem: "y",
      leadDays: "5", blindShip: "n", overnight: "y", url: "https://example.com/x",
    });
  });

  it("survives a real CSV both ways", () => {
    const csv = toCsv(exportGrid([part()], [price()]));
    const [row] = readGrid(parseCsv(csv));
    expect(row.name).toBe("Plunger seal, 10 mL");
  });

  it("gives a part with three vendors three lines, each naming the part", () => {
    // A blank continuation row loses its part the moment somebody sorts by
    // vendor, which is the first thing anybody does with a quote comparison.
    const grid = exportGrid([part()], [
      price({ vendor: "Shimadzu" }), price({ vendor: "Acme", isOem: false }),
      price({ vendor: "Restek", isOem: false }),
    ]);
    const rows = readGrid(grid);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.partNumber).toBe("228-35145-91");
    expect(rows.map((r) => r.vendor)).toEqual(["Shimadzu", "Acme", "Restek"]);
  });

  it("still exports a part nobody has priced", () => {
    const rows = readGrid(exportGrid([part()], []));
    expect(rows).toHaveLength(1);
    expect(rows[0].vendor).toBe("");
  });

  it("matches a price to its part however the number was typed", () => {
    // Same rule as everywhere else a part number is compared - case and
    // internal spaces are noise, dashes are not. See lib/priceBook.
    const rows = readGrid(exportGrid([part({ partNumber: "228-35145-91" })],
      [price({ partNumber: " 228-35145-91 " })]));
    expect(rows).toHaveLength(1);
    expect(rows[0].vendor).toBe("Shimadzu");
  });

  it("writes a price as plain digits a spreadsheet can add up", () => {
    const grid = exportGrid([part()], [price({ priceCents: 120000 })]);
    const [row] = readGrid(grid);
    expect(row.price).toBe("1200.00");
    expect(row.price).not.toMatch(/[$,]/);
  });

  it("leaves an unknown lead time blank rather than calling it zero", () => {
    const [row] = readGrid(exportGrid([part()], [price({ leadDays: null })]));
    expect(row.leadDays).toBe("");
  });
});
