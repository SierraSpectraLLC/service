import { describe, it, expect } from "vitest";
import { alnum, matchesQuery, normalize, searchTerms } from "@/lib/search";

describe("searchTerms", () => {
  it("splits on whitespace and lowercases", () => {
    expect(searchTerms("Trace 1310")).toEqual(["trace", "1310"]);
  });
  it("keeps a quoted phrase together", () => {
    expect(searchTerms('"annual pm" seals')).toEqual(["annual pm", "seals"]);
  });
  it("is empty for an empty query", () => {
    expect(searchTerms("   ")).toEqual([]);
  });
});

describe("matchesQuery", () => {
  const system = ["G-010", "Shimadzu LCMS-8060 + HPLC", "GMI", "Mass Spec LCMS-8060 SN L20304512345"];

  it("matches nothing typed - an empty box hides nothing", () => {
    expect(matchesQuery("", system)).toBe(true);
    expect(matchesQuery("   ", system)).toBe(true);
  });

  it("is case-insensitive and partial", () => {
    expect(matchesQuery("lcms", system)).toBe(true);
    expect(matchesQuery("SHIMADZU", system)).toBe(true);
  });

  it("requires every term, but lets them land in different fields", () => {
    expect(matchesQuery("gmi lcms", system)).toBe(true);
    expect(matchesQuery("gmi nosuch", system)).toBe(false);
  });

  it("finds a system by part of its module's serial", () => {
    expect(matchesQuery("3045123", system)).toBe(true);
  });

  it("ignores punctuation, in both directions", () => {
    expect(matchesQuery("lcms8060", system)).toBe(true);
    expect(matchesQuery("g010", system)).toBe(true);
    expect(matchesQuery("LC-MS-8060", ["lcms8060"])).toBe(true);
  });

  it("never matches across the seam between two fields", () => {
    // "010shimadzu" would match a naively joined haystack. It must not.
    expect(matchesQuery("010shimadzu", system)).toBe(false);
  });

  it("does not squash a one-character term into a false hit", () => {
    // A bare "-" reduces to "" and must not match everything.
    expect(matchesQuery("-", ["G-010"])).toBe(true);   // plain substring hit
    expect(matchesQuery("§", ["G-010"])).toBe(false);  // nothing to match on
  });

  it("skips blank and null fields without throwing", () => {
    expect(matchesQuery("g-010", ["G-010", null, undefined, ""])).toBe(true);
  });
});

describe("normalize / alnum", () => {
  it("collapses whitespace and lowercases", () => {
    expect(normalize("  Thermo   Trace ")).toBe("thermo trace");
  });
  it("strips everything but letters and digits", () => {
    expect(alnum("228-52708-91")).toBe("2285270891");
  });
});
