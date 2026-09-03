import { describe, expect, it } from "vitest";
import { HOUSE_SERVICE_CODES, missingServiceCodes } from "@/lib/serviceCodes";
import { isService, lineKindFor } from "@/lib/partCatalog";

const entry = (partNumber: string, over: Record<string, unknown> = {}) => ({
  id: 1, partNumber, name: "", manufacturer: "", mfrPartNumber: "",
  kind: "part", archived: false, ...over,
});

describe("the numbers a shop quotes hours and trips under", () => {
  it("is the four the shop named, spelled as they said them", () => {
    expect(HOUSE_SERVICE_CODES.map((c) => c.partNumber))
      .toEqual(["TZ1OP", "TZ3O", "LABOR-LCP", "LABOR-TCU"]);
    expect(HOUSE_SERVICE_CODES.find((c) => c.partNumber === "TZ3O")?.name)
      .toBe("Travel Zone-3 Overnight");
    expect(HOUSE_SERVICE_CODES.find((c) => c.partNumber === "LABOR-LCP")?.name)
      .toBe("Labor, LC/MS Preferred");
  });

  it("bills as labor and as travel, which is what the two kinds are for", () => {
    for (const c of HOUSE_SERVICE_CODES) {
      expect(isService(c.kind)).toBe(true);
      expect(lineKindFor(c.kind)).toBe(c.kind);
    }
    // A trip is not an hour. The unit is why a zone charge stops printing "1 h".
    expect(HOUSE_SERVICE_CODES.find((c) => c.partNumber === "TZ3O")?.unit).toBe("trip");
    expect(HOUSE_SERVICE_CODES.find((c) => c.partNumber === "LABOR-TCU")?.unit).toBe("h");
  });

  it("offers all four to an empty book", () => {
    expect(missingServiceCodes([])).toHaveLength(4);
  });

  it("offers nothing twice - the second run writes nothing", () => {
    const book = HOUSE_SERVICE_CODES.map((c) => entry(c.partNumber));
    expect(missingServiceCodes(book)).toEqual([]);
  });

  it("counts a code the shop spells differently in case or spacing", () => {
    // Matched the way every part number is matched: lowercased, spaces
    // stripped, hyphens kept.
    expect(missingServiceCodes([entry(" labor-lcp ")]).map((c) => c.partNumber))
      .toEqual(["TZ1OP", "TZ3O", "LABOR-TCU"]);
  });

  it("counts one catalogued under another of its numbers, and one retired", () => {
    /*
     * A shop that already has TZ3O as an alias of its own travel row must not
     * be offered it again - that would be a second entry answering to one
     * number, which is the failure the alias table exists to prevent. A
     * retired code counts as present too: re-creating it would silently split
     * its history in two.
     */
    const book = [
      entry("TRV-3", { aliases: [{ kind: "shop", partNumber: "TZ3O" }] }),
      entry("LABOR-TCU", { archived: true }),
    ];
    expect(missingServiceCodes(book).map((c) => c.partNumber)).toEqual(["TZ1OP", "LABOR-LCP"]);
  });
});
