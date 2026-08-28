// The directory service companies find each other in.
import { describe, expect, it } from "vitest";
import {
  listingLine, matches, parseTags, profileProblems, search, MAX_TAGS,
  type ProviderListing,
} from "@/lib/providerDirectory";

const one = (over: Partial<ProviderListing> & { name: string }): ProviderListing => ({
  orgId: 1, listed: true, blurb: "", services: [], regions: [],
  contactName: "", contactEmail: "", contactPhone: "", website: "", ...over,
});

const ALL: ProviderListing[] = [
  one({ orgId: 1, name: "Sierra Spectra", services: ["LC-MS", "GC-MS"], regions: ["Northern California"] }),
  one({ orgId: 2, name: "Northwest Instrument Services", services: ["LC-MS", "Dissolution"], regions: ["Seattle metro", "WA"] }),
  one({ orgId: 3, name: "Cascade Chromatography", services: ["HPLC"], regions: ["WA", "OR"],
    blurb: "Sciex and Waters specialists" }),
  one({ orgId: 4, name: "Quiet Shop", listed: false, services: ["LC-MS"], regions: ["WA"] }),
];

describe("searching", () => {
  it("needs every word to hit something, so two words narrow", () => {
    // "sciex seattle" should find a shop that does both, not every shop that
    // does either.
    expect(search(ALL, "LC-MS WA").map((l) => l.name)).toEqual(["Northwest Instrument Services"]);
  });

  it("matches on a substring, because a searcher is guessing at somebody else's words", () => {
    expect(matches(ALL[1], "wa")).toBe(true);       // WA
    expect(matches(ALL[2], "sciex")).toBe(true);    // in the blurb
  });

  it("never returns a company that has not asked to be listed", () => {
    // The whole directory is opt-in: visibleOrgs hides operators from each
    // other on purpose, and this is the narrow exception.
    expect(search(ALL, "LC-MS").map((l) => l.orgId)).not.toContain(4);
    expect(search(ALL, "").map((l) => l.orgId)).not.toContain(4);
  });

  it("puts a name hit above a tag hit", () => {
    expect(search(ALL, "cascade")[0].name).toBe("Cascade Chromatography");
  });

  it("returns everything listed for an empty query", () => {
    expect(search(ALL, "  ").length).toBe(3);
  });
});

describe("a listing", () => {
  it("splits tags on commas and newlines, keeping spaces inside one", () => {
    expect(parseTags("LC-MS, GC-MS\nDissolution")).toEqual(["LC-MS", "GC-MS", "Dissolution"]);
    expect(parseTags("Northern California, Reno")).toEqual(["Northern California", "Reno"]);
  });

  it("drops duplicates and caps the list", () => {
    expect(parseTags("LC-MS, lc-ms")).toEqual(["LC-MS"]);
    expect(parseTags(Array.from({ length: 30 }, (_, i) => `t${i}`).join(","))).toHaveLength(MAX_TAGS);
  });

  it("only complains about a listing somebody actually wants published", () => {
    // An unfinished draft nobody can see is a draft, not a problem.
    expect(profileProblems({ listed: false, services: [], regions: [], blurb: "", contactEmail: "" })).toEqual([]);
    const bad = profileProblems({ listed: true, services: [], regions: [], blurb: "", contactEmail: "" });
    expect(bad.some((p) => p.includes("what you service"))).toBe(true);
    expect(bad.some((p) => p.includes("where you work"))).toBe(true);
  });

  it("refuses a contact address that is not one", () => {
    expect(profileProblems({
      listed: true, services: ["LC-MS"], regions: ["WA"], blurb: "", contactEmail: "not an address",
    })[0]).toContain("not an address");
  });

  it("reads as one line under the name", () => {
    expect(listingLine(ALL[1])).toBe("LC-MS, Dissolution · Seattle metro, WA");
  });
});
