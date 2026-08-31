// The railing around a two thousand line catalog sheet.
//
// The parser is the easy half and barely tested here. What is pinned is the
// planner: every way a line can turn out to be something the catalog already
// has. A duplicate model in this book is not a cosmetic problem - every picker
// in the app reads from it, so two spellings of one pump means half the fleet
// matches each, and the maintenance a model owes lands on some of its units.
//
// Pure: no db, no tenancy. Literals in, verdicts out.
import { describe, expect, it } from "vitest";
import {
  COLUMNS, exportGrid, looseKey, matchHeader, modelKey, needsReading,
  planCatalogImport, readGrid, templateGrid, writesSomething,
  type CatalogImportRow, type ExistingModel,
} from "@/lib/catalogImport";

const row = (over: Partial<CatalogImportRow> = {}): CatalogImportRow =>
  ({ moduleType: "", model: "", manufacturer: "", systemTypes: "", ...over });

const onFile = (over: Partial<ExistingModel> = {}): ExistingModel =>
  ({ id: 1, moduleType: "Pump", name: "LC-20AD", manufacturer: "Shimadzu", categories: ["HPLC"], ...over });

const plan = (
  rows: CatalogImportRow[],
  over: Partial<Parameters<typeof planCatalogImport>[1]> = {},
) => planCatalogImport(rows, {
  models: [], moduleTypes: ["Pump", "Detector"], systemTypes: ["HPLC", "LC-MS"], makers: ["Shimadzu"],
  ...over,
});

const verdicts = (p: ReturnType<typeof plan>) => p.rows.map((r) => r.verdict);

describe("reading the sheet", () => {
  it("maps the headers people actually send, and drops what it cannot place", () => {
    expect(matchHeader("Module type")).toBe("moduleType");
    expect(matchHeader("module_type")).toBe("moduleType");
    expect(matchHeader("OEM")).toBe("manufacturer");
    // The template's own parenthetical header, and the bare word under it.
    expect(matchHeader("Manufacturer (OEM)")).toBe("manufacturer");
    expect(matchHeader("Manufacturer")).toBe("manufacturer");
    expect(matchHeader("Categories")).toBe("systemTypes");
    // Not guessed at: an unknown column is dropped, never assigned to the next
    // one along - a mis-mapped column is invisible in a CSV.
    expect(matchHeader("Serial number")).toBeNull();
  });

  it("reads a headerless paste as the template's own column order", () => {
    const rows = readGrid([["Pump", "LC-20AD", "Shimadzu", "HPLC"]]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ moduleType: "Pump", model: "LC-20AD", manufacturer: "Shimadzu" });
  });

  it("does not eat the first line of data when it is data", () => {
    // One junk line in a preview is recoverable; a silently eaten model is not.
    const rows = readGrid([["Pump", "LC-20AD", "Shimadzu", ""], ["Pump", "LC-20AT", "Shimadzu", ""]]);
    expect(rows.map((r) => r.model)).toEqual(["LC-20AD", "LC-20AT"]);
  });

  it("round-trips its own export", () => {
    const grid = exportGrid([
      { moduleType: "Pump", name: "LC-20AD", manufacturer: "Shimadzu", categories: ["HPLC", "LC-MS"] },
    ], ["Agilent"]);
    const back = readGrid(grid);
    expect(back[0]).toMatchObject({
      moduleType: "Pump", model: "LC-20AD", manufacturer: "Shimadzu", systemTypes: "HPLC; LC-MS",
    });
    // A maker who makes nothing still survives the trip, on a line of its own.
    expect(back[1]).toMatchObject({ model: "", manufacturer: "Agilent" });
    // And what comes back out reads as nothing to do.
    const p = plan(back, {
      models: [onFile({ categories: ["HPLC", "LC-MS"] })],
      makers: ["Shimadzu", "Agilent"],
    });
    expect(verdicts(p)).toEqual(["same", "same"]);
    expect(p.rows.every((r) => !r.write)).toBe(true);
  });

  it("keeps the template and the parser talking about the same columns", () => {
    const [headers] = templateGrid();
    expect(headers).toHaveLength(COLUMNS.length);
    expect(headers.map(matchHeader)).toEqual(COLUMNS.map((c) => c.key));
  });
});

describe("the railing: what is already on file", () => {
  it("files a genuinely new module", () => {
    const p = plan([row({ moduleType: "Pump", model: "LC-40D", manufacturer: "Shimadzu", systemTypes: "HPLC" })]);
    expect(verdicts(p)).toEqual(["new"]);
    expect(p.rows[0].write?.model).toMatchObject({
      id: null, moduleType: "Pump", name: "LC-40D", manufacturer: "Shimadzu", categories: ["HPLC"],
    });
  });

  it("never files a second copy of a model already on file", () => {
    // Case and surrounding space are noise, exactly as they are for somebody
    // typing the model into the dialog by hand.
    const p = plan(
      [row({ moduleType: "pump", model: "  lc-20ad ", manufacturer: "Shimadzu", systemTypes: "HPLC" })],
      { models: [onFile()] },
    );
    expect(verdicts(p)).toEqual(["same"]);
    expect(p.rows[0].write).toBeUndefined();
  });

  it("widens what is on file rather than replacing it", () => {
    // A model that serves a second system type is one row that applies twice,
    // which is what addVocabTerm does for a hand-typed duplicate too.
    const p = plan(
      [row({ moduleType: "Pump", model: "LC-20AD", manufacturer: "Shimadzu", systemTypes: "LC-MS" })],
      { models: [onFile({ categories: ["HPLC"] })] },
    );
    expect(verdicts(p)).toEqual(["merge"]);
    expect(p.rows[0].write?.model).toMatchObject({ id: 1, categories: ["HPLC", "LC-MS"] });
  });

  it("fills a blank maker but never overwrites one somebody set", () => {
    const fills = plan(
      [row({ moduleType: "Pump", model: "LC-20AD", manufacturer: "Shimadzu" })],
      { models: [onFile({ manufacturer: "" })] },
    );
    expect(verdicts(fills)).toEqual(["merge"]);
    expect(fills.rows[0].write?.model?.manufacturer).toBe("Shimadzu");

    /*
     * The heart of it. Somebody put "Shimadzu" on this row; a spreadsheet
     * saying "Agilent" is a disagreement, not an instruction. The row is left
     * exactly as it stands and the line is reported for a person to settle.
     */
    const clash = plan(
      [row({ moduleType: "Pump", model: "LC-20AD", manufacturer: "Agilent" })],
      { models: [onFile({ manufacturer: "Shimadzu" })], makers: ["Shimadzu", "Agilent"] },
    );
    expect(verdicts(clash)).toEqual(["conflict"]);
    expect(clash.rows[0].write).toBeUndefined();
    expect(clash.rows[0].note).toContain("Shimadzu");
    expect(clash.rows[0].note).toContain("Agilent");
  });

  it("stops a second SPELLING of a model on file, and names the one that exists", () => {
    /*
     * The rail that matters on two thousand lines. "LC20AD" and "LC-20AD" are
     * one pump written twice; importing both is precisely the duplicate this
     * exists to prevent. Folding them silently would be a guess about the
     * shop's vocabulary, so the line stops and says what it collided with.
     */
    const p = plan(
      [row({ moduleType: "Pump", model: "LC 20AD", manufacturer: "Shimadzu" })],
      { models: [onFile({ name: "LC-20AD" })] },
    );
    expect(verdicts(p)).toEqual(["nearby"]);
    expect(p.rows[0].write).toBeUndefined();
    expect(p.rows[0].note).toContain("LC-20AD");
  });

  it("lets the same name live under two different module types", () => {
    // Not a duplicate: a "G1311B" pump and a "G1311B" detector are two things,
    // and the identity is the pair.
    const p = plan(
      [row({ moduleType: "Detector", model: "LC-20AD", manufacturer: "Shimadzu" })],
      { models: [onFile({ moduleType: "Pump" })] },
    );
    expect(verdicts(p)).toEqual(["new"]);
  });
});

describe("the railing: the sheet against itself", () => {
  it("files a module named twice in one file exactly once", () => {
    const p = plan([
      row({ moduleType: "Pump", model: "LC-40D", manufacturer: "Shimadzu", systemTypes: "HPLC" }),
      row({ moduleType: "Pump", model: "LC-40D", manufacturer: "Shimadzu", systemTypes: "HPLC" }),
    ]);
    expect(verdicts(p)).toEqual(["new", "repeat"]);
    expect(p.rows.filter((r) => r.write?.model)).toHaveLength(1);
  });

  it("folds a repeat's extra system type into the one line that writes", () => {
    // Two lines, one module, two platforms - the shape a real sheet arrives in
    // when somebody built it one system at a time.
    const p = plan([
      row({ moduleType: "Pump", model: "LC-40D", manufacturer: "Shimadzu", systemTypes: "HPLC" }),
      row({ moduleType: "Pump", model: "LC-40D", manufacturer: "Shimadzu", systemTypes: "LC-MS" }),
    ]);
    expect(verdicts(p)).toEqual(["new", "repeat"]);
    expect(p.rows[0].write?.model?.categories).toEqual(["HPLC", "LC-MS"]);
  });

  it("catches two spellings of one new module inside the same file", () => {
    const p = plan([
      row({ moduleType: "Pump", model: "LC-40D", manufacturer: "Shimadzu" }),
      row({ moduleType: "Pump", model: "LC40D", manufacturer: "Shimadzu" }),
    ]);
    expect(verdicts(p)).toEqual(["new", "nearby"]);
    expect(p.rows[1].note).toContain("Line 1");
  });

  it("reports two makers claiming one module in the same file", () => {
    const p = plan([
      row({ moduleType: "Pump", model: "LC-40D", manufacturer: "Shimadzu" }),
      row({ moduleType: "Pump", model: "LC-40D", manufacturer: "Agilent" }),
    ], { makers: ["Shimadzu", "Agilent"] });
    expect(verdicts(p)).toEqual(["new", "conflict"]);
    expect(p.rows[0].write?.model?.manufacturer).toBe("Shimadzu");
  });
});

describe("the OEMs", () => {
  it("takes a maker on a line of its own into the book", () => {
    const p = plan([row({ manufacturer: "Waters" })]);
    expect(verdicts(p)).toEqual(["oem"]);
    expect(p.rows[0].write?.maker).toBe("Waters");
    expect(p.newMakers).toEqual(["Waters"]);
  });

  it("does not add a second spelling of a maker the book already has", () => {
    // Nothing to act on - the book has this vendor - so it does not join the
    // list of lines to read. The note still names both spellings, because
    // "we write it the other way" matters when two thousand rows use the
    // other way.
    const p = plan([row({ manufacturer: "Agilent Technologies, Inc." })],
      { makers: ["Agilent Technologies Inc"] });
    expect(verdicts(p)).toEqual(["same"]);
    expect(p.rows[0].write).toBeUndefined();
    expect(p.newMakers).toEqual([]);
    expect(p.rows[0].note).toContain("Agilent Technologies, Inc.");
    expect(p.rows[0].note).toContain("Agilent Technologies Inc");
  });

  it("keeps a model whose maker is spelled loosely, under the book's spelling", () => {
    /*
     * Asymmetric with a model on purpose. A model IS the row's identity, so a
     * second spelling has to be settled by a person. A maker is an attribute,
     * and the book exists precisely so there is one spelling of it - so the
     * module lands, filed under the name the shop already uses, and the line
     * says so rather than quietly disagreeing with the sheet.
     */
    const p = plan([row({ moduleType: "Pump", model: "LC-40D", manufacturer: "shimadzu corp." })],
      { makers: ["Shimadzu Corp"] });
    expect(verdicts(p)).toEqual(["new"]);
    expect(p.rows[0].write?.model?.manufacturer).toBe("Shimadzu Corp");
    expect(p.rows[0].note).toContain("Shimadzu Corp");
    expect(p.newMakers).toEqual([]);
  });

  it("leaves two genuinely different names as two names", () => {
    // The rail is punctuation and spacing. It must not decide that a shop's
    // "Agilent" and "Agilent Technologies" are one vendor.
    expect(looseKey("Agilent")).not.toBe(looseKey("Agilent Technologies"));
    const p = plan([row({ manufacturer: "Agilent Technologies" })], { makers: ["Agilent"] });
    expect(verdicts(p)).toEqual(["oem"]);
  });
});

describe("what the sheet brings with it", () => {
  it("names the module types and system types that do not exist yet", () => {
    // A 2000-line sheet will always name types the catalog has not heard of.
    // They are created rather than refused - but they are counted, and the
    // preview says so before anybody commits.
    const p = plan([row({ moduleType: "N2 generator", model: "NM32LA", manufacturer: "Peak", systemTypes: "GC-MS" })]);
    expect(p.newModuleTypes).toEqual(["N2 generator"]);
    expect(p.newSystemTypes).toEqual(["GC-MS"]);
    expect(p.newMakers).toEqual(["Peak"]);
  });

  it("counts an existing type once, however the sheet spelled it", () => {
    const p = plan([row({ moduleType: "pump", model: "LC-40D", systemTypes: "hplc" })]);
    expect(p.newModuleTypes).toEqual([]);
    expect(p.newSystemTypes).toEqual([]);
    // And files it under the catalog's own spelling, not the sheet's.
    expect(p.rows[0].write?.model).toMatchObject({ moduleType: "Pump", categories: ["HPLC"] });
  });

  it("refuses what vocab_terms itself would refuse", () => {
    const p = plan([
      row({ model: "LC-40D" }),
      row({ moduleType: "Pump", model: "x".repeat(61) }),
      row({}),
    ]);
    expect(verdicts(p)).toEqual(["problem", "problem", "problem"]);
    expect(p.rows.every((r) => !r.write)).toBe(true);
  });
});

describe("the summary a person reads before committing", () => {
  it("tallies every verdict, and sorts them into acting and reading", () => {
    const p = plan([
      row({ moduleType: "Pump", model: "LC-40D", manufacturer: "Shimadzu" }),   // new
      row({ moduleType: "Pump", model: "LC-40D", manufacturer: "Shimadzu" }),   // repeat
      row({ moduleType: "Pump", model: "LC-20AD", manufacturer: "Shimadzu" }),  // same
      row({ moduleType: "Pump", model: "LC 20AD" }),                            // nearby
      row({ model: "no type" }),                                                // problem
    ], { models: [onFile()] });
    expect(p.counts).toMatchObject({ new: 1, repeat: 1, same: 1, nearby: 1, problem: 1 });
    expect(p.rows.filter((r) => writesSomething(r.verdict))).toHaveLength(1);
    expect(p.rows.filter((r) => needsReading(r.verdict)).map((r) => r.line)).toEqual([4, 5]);
  });

  it("keys identity on the pair, so the two indexes cannot disagree", () => {
    expect(modelKey("Pump", "LC-20AD")).toBe(modelKey(" pump ", " lc-20ad "));
    expect(modelKey("Pump", "LC-20AD")).not.toBe(modelKey("Detector", "LC-20AD"));
  });
});
