import { describe, expect, it } from "vitest";
import { makerLookup } from "@/lib/makerLookup";

describe("the maker's search page for a part", () => {
  it("builds the Waters search on the number, exactly as their site takes it", () => {
    // The URL the request came with, keyword= being the part.
    const hit = makerLookup({ manufacturer: "Waters", partNumber: "700000341" });
    expect(hit?.maker).toBe("Waters");
    expect(hit?.url).toBe(
      "https://www.waters.com/nextgen/us/en/search.html?category=All&enableHL=true&isocode=en_US&keyword=700000341&multiselect=true&page=1&rows=12&sort=most-relevant",
    );
  });

  it("recognises the maker however it was typed", () => {
    expect(makerLookup({ manufacturer: "waters corporation", partNumber: "5711130" })?.maker).toBe("Waters");
    // The old name on the Quattro Ultima rows is still Waters' site.
    expect(makerLookup({ manufacturer: "Micromass", partNumber: "5711130" })?.maker).toBe("Waters");
    expect(makerLookup({ manufacturer: "Thermo Scientific", partNumber: "1R120" })?.maker).toBe("Thermo Fisher");
  });

  it("searches THEIR number over ours when the row has both", () => {
    // AGI-7167-PMK is a shop code; Agilent knows it as G4521-67001.
    const hit = makerLookup({ manufacturer: "Agilent", partNumber: "AGI-7167-PMK", mfrPartNumber: "G4521-67001" });
    expect(hit?.url).toContain("G4521-67001");
    expect(hit?.url).not.toContain("AGI-7167");
  });

  it("encodes a number that would otherwise break the query string", () => {
    expect(makerLookup({ manufacturer: "Waters", partNumber: "WAT 011/2&3" })?.url).toContain("keyword=WAT%20011%2F2%263&");
  });

  it("offers nothing without a maker we can search, or without a number", () => {
    expect(makerLookup({ manufacturer: "", partNumber: "700000341" })).toBeNull();
    expect(makerLookup({ manufacturer: "Sierra Spectra", partNumber: "FSC-LC10-UNL" })).toBeNull();
    expect(makerLookup({ manufacturer: "Waters", partNumber: "  " })).toBeNull();
  });
});
