import { describe, expect, it } from "vitest";
import {
  allNumbers, catalogEntry, catalogLabel, catalogName, cleanAliases, isCatalogued, kitContents,
  numberClash, searchCatalog, uncatalogued,
} from "@/lib/partCatalog";

const entry = (over: Partial<import("@/lib/partCatalog").CatalogEntry> = {}) => ({
  id: 1, partNumber: "AGI-7167-PMK", name: "Agilent 7176 PM Kit", manufacturer: "Agilent",
  mfrPartNumber: "G4521-67001", kind: "kit", archived: false, ...over,
});

const catalog = [
  entry(),
  entry({ id: 2, partNumber: "5181-3323", name: "Inlet septa, 11mm", kind: "consumable", manufacturer: "", mfrPartNumber: "" }),
  entry({ id: 3, partNumber: "51813-323", name: "A different part entirely", kind: "part", manufacturer: "", mfrPartNumber: "" }),
  entry({ id: 4, partNumber: "OLD-001", name: "Superseded seal", kind: "part", archived: true, manufacturer: "", mfrPartNumber: "" }),
];

describe("resolving a number to a part", () => {
  it("finds it, ignoring case and spaces", () => {
    expect(catalogEntry(catalog, "agi-7167-pmk")?.id).toBe(1);
    expect(catalogEntry(catalog, " AGI-7167-PMK ")?.id).toBe(1);
  });

  it("keeps hyphens, because they are load-bearing in part numbers", () => {
    // 5181-3323 and 51813-323 are genuinely different parts. Folding the
    // punctuation would quietly merge two of them.
    expect(catalogEntry(catalog, "5181-3323")?.id).toBe(2);
    expect(catalogEntry(catalog, "51813-323")?.id).toBe(3);
  });

  it("still resolves a retired part, because history has to keep reading", () => {
    expect(catalogEntry(catalog, "OLD-001")?.name).toBe("Superseded seal");
  });

  it("shrugs at a number nobody has catalogued", () => {
    // Never an error: a part fitted at 2am must land in the record whether or
    // not the shop has described it.
    expect(catalogEntry(catalog, "NEVER-SEEN")).toBe(null);
    expect(catalogEntry(catalog, "  ")).toBe(null);
    expect(isCatalogued(catalog, "NEVER-SEEN")).toBe(false);
  });

  it("hands back the caller's own name when it knows none", () => {
    expect(catalogName(catalog, "AGI-7167-PMK")).toBe("Agilent 7176 PM Kit");
    expect(catalogName(catalog, "NEVER-SEEN", "whatever was typed")).toBe("whatever was typed");
  });

  it("prefers the live spelling when a number was re-catalogued", () => {
    const both = [entry({ id: 9, partNumber: "X-1", archived: true }), entry({ id: 10, partNumber: "X-1" })];
    expect(catalogEntry(both, "X-1")?.id).toBe(10);
  });
});

describe("how a part reads in a picker", () => {
  it("leads with the number, then the name, then whose part it is", () => {
    expect(catalogLabel(entry())).toBe("AGI-7167-PMK - Agilent 7176 PM Kit (Agilent)");
  });

  it("copes with a number nobody has named yet", () => {
    expect(catalogLabel({ partNumber: "X-9", name: "", manufacturer: "" })).toBe("X-9");
  });
});

describe("searching the catalog", () => {
  it("finds by our number, their number, name, or maker", () => {
    expect(searchCatalog(catalog, "7167").map((c) => c.id)).toEqual([1]);
    // The number in somebody's hand is as often the manufacturer's as ours -
    // that is the whole reason a house number exists.
    expect(searchCatalog(catalog, "G4521").map((c) => c.id)).toEqual([1]);
    expect(searchCatalog(catalog, "septa").map((c) => c.id)).toEqual([2]);
    expect(searchCatalog(catalog, "agilent").map((c) => c.id)).toEqual([1]);
  });

  it("puts retired parts last rather than hiding them", () => {
    const hits = searchCatalog([...catalog, entry({ id: 5, partNumber: "SEAL-2", name: "Superseded seal", archived: false, manufacturer: "", mfrPartNumber: "" })], "superseded");
    expect(hits.map((c) => c.id)).toEqual([5, 4]);
  });

  it("shows the live catalog when nothing is typed", () => {
    expect(searchCatalog(catalog, "").map((c) => c.id)).toEqual([1, 2, 3]);
  });
});

describe("what is in a kit", () => {
  it("reads as a list, with counts only where they matter", () => {
    expect(kitContents([
      { partNumber: "5181-3323", name: "Inlet septa", qty: 10 },
      { partNumber: "G1544-80530", name: "Gold seal", qty: 1 },
    ])).toBe("10x Inlet septa, Gold seal");
  });

  it("falls back to the number for a line nobody named", () => {
    expect(kitContents([{ partNumber: "X-9", name: "", qty: 2 }])).toBe("2x X-9");
  });

  it("drops empty lines rather than printing commas", () => {
    expect(kitContents([{ partNumber: "", name: "", qty: 1 }])).toBe("");
  });
});

describe("seeding the catalog from what the shop actually uses", () => {
  const pns = (used: Parameters<typeof uncatalogued>[1]) =>
    uncatalogued(catalog, used).map((u) => u.partNumber);

  it("lists the numbers in use that nothing describes", () => {
    // Asking somebody to type out their whole parts book is how a catalog stays
    // empty. Asking them to name the twelve numbers they already used is not.
    expect(pns(["AGI-7167-PMK", "NEW-1", "5181-3323", "NEW-2"])).toEqual(["NEW-1", "NEW-2"]);
  });

  it("dedupes the way part numbers dedupe, keeping the first spelling", () => {
    expect(pns(["new-1", "NEW-1 ", " New-1"])).toEqual(["new-1"]);
  });

  it("ignores blanks", () => {
    expect(pns(["", "   ", "NEW-1"])).toEqual(["NEW-1"]);
  });

  it("keeps what maintenance already said about a number", () => {
    // The PM checklist's consumables arrive with a name and a fit; a bare
    // mention of the same number from stock must not blank them out.
    const [u] = uncatalogued(catalog, [
      { partNumber: "638-59300-00", source: "stock" },
      { partNumber: "638-59300-00", name: "2500 ml Syringe", assetType: "TOC", models: ["TOC-VW"], source: "maintenance" },
    ]);
    expect(u).toEqual({
      partNumber: "638-59300-00", name: "2500 ml Syringe",
      assetTypes: ["TOC"], models: ["TOC-VW"], sources: ["stock", "maintenance"],
    });
  });

  it("gathers a kit's contents under every module type the kit fits", () => {
    // Listing six parts inside a kit is the fastest way to put six undescribed
    // numbers into the shop. The page emits one mention per module type the kit
    // suits, and they have to merge into one row rather than six.
    const [u] = uncatalogued(catalog, [
      { partNumber: "5063-6589", name: "Plunger seal", assetType: "Pump", models: ["LC-20AD"], source: "kit" },
      { partNumber: "5063-6589", name: "Plunger seal", assetType: "LC System", models: ["LC-20AD"], source: "kit" },
    ]);
    expect(u).toEqual({
      partNumber: "5063-6589", name: "Plunger seal",
      assetTypes: ["Pump", "LC System"], models: ["LC-20AD"], sources: ["kit"],
    });
  });

  it("never lists a number the catalog already describes, whatever the source", () => {
    // Including a kit line that names a part somebody has since described.
    expect(uncatalogued(catalog, [{ partNumber: "5181-3323", name: "x", source: "kit" }])).toEqual([]);
    expect(uncatalogued(catalog, [{ partNumber: "agi-7167-pmk", name: "x", source: "maintenance" }])).toEqual([]);
  });
});

describe("one part, several numbers", () => {
  // The seal is Shimadzu's 228-35145-91, a third party's 5063-6589, and our
  // own SS-SEAL-01. Whichever the box in somebody's hand carries, it is one
  // described part.
  const seal = entry({
    id: 9, partNumber: "SS-SEAL-01", name: "Plunger seal", kind: "part",
    manufacturer: "Shimadzu", mfrPartNumber: "228-35145-91",
    aliases: [
      { kind: "oem", partNumber: "5063-6589", manufacturer: "Restek" },
      { kind: "shop", partNumber: "SS-SEAL-01-OLD", note: "superseded 2024" },
    ],
  });
  const book = [...catalog, seal];

  it("resolves by any of them", () => {
    for (const pn of ["SS-SEAL-01", "228-35145-91", "5063-6589", " ss-seal-01-old "]) {
      expect(catalogEntry(book, pn)?.id).toBe(9);
    }
    expect(catalogEntry(book, "NOT-A-NUMBER")).toBeNull();
  });

  it("gathers them primaries-first, normalized and deduped", () => {
    expect(allNumbers(seal)).toEqual(["ss-seal-01", "228-35145-91", "5063-6589", "ss-seal-01-old"]);
    expect(allNumbers({ partNumber: "A-1", mfrPartNumber: "", aliases: [{ kind: "oem", partNumber: " a-1 " }] }))
      .toEqual(["a-1"]);
  });

  it("stops calling a number undescribed once some entry answers to it", () => {
    // The bug this closes: buy the seal under Agilent's number, describe it
    // under ours, and the parts book keeps asking to describe it.
    expect(uncatalogued(book, [{ partNumber: "5063-6589", source: "purchasing" }])).toEqual([]);
  });

  it("finds it in a picker by an alias or by the maker who sells it", () => {
    expect(searchCatalog(book, "5063").map((c) => c.id)).toEqual([9]);
    // By the third party who also sells it - nothing else in the book is Restek.
    expect(searchCatalog(book, "restek").map((c) => c.id)).toEqual([9]);
  });
});

describe("keeping the numbers honest", () => {
  const primaries = { partNumber: "SS-SEAL-01", mfrPartNumber: "228-35145-91" };

  it("drops a re-listed primary, blanks and duplicates", () => {
    // Pasting the whole row in and listing the primary again is the commonest
    // slip; it would print the same string twice on the chip line.
    expect(cleanAliases([
      { kind: "oem", partNumber: " 228-35145-91 " },
      { kind: "oem", partNumber: "ss-seal-01" },
      { kind: "oem", partNumber: "  " },
      { kind: "oem", partNumber: "5063-6589", manufacturer: " Restek " },
      { kind: "oem", partNumber: "5063-6589" },
    ], primaries)).toEqual([
      { kind: "oem", partNumber: "5063-6589", manufacturer: "Restek", note: "" },
    ]);
  });

  it("falls back to the maker's kind for anything unrecognised", () => {
    expect(cleanAliases([{ kind: "nonsense", partNumber: "X-1" }], primaries)[0].kind).toBe("oem");
    expect(cleanAliases([{ kind: "shop", partNumber: "X-1" }], primaries)[0].kind).toBe("shop");
  });

  it("names the entry that already claims a number", () => {
    // Two entries answering to one number would describe the same box
    // differently depending on the screen.
    const clash = numberClash(catalog, { partNumber: "NEW-9", mfrPartNumber: "", aliases: [{ kind: "oem", partNumber: "5181-3323" }] });
    expect(clash?.number).toBe("5181-3323");
    expect(clash?.entry.id).toBe(2);
    expect(numberClash(catalog, { partNumber: "NEW-9", mfrPartNumber: "", aliases: [] })).toBeNull();
  });
});
