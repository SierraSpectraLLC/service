import { describe, expect, it } from "vitest";
import { buildZip, crc32, zipNames } from "@/lib/zip";

describe("crc32", () => {
  it("matches the published vectors", () => {
    // The classic check value, and empty input.
    expect(crc32(new TextEncoder().encode("123456789")).toString(16)).toBe("cbf43926");
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("names inside one archive", () => {
  it("renames a duplicate the way every desktop does", () => {
    // The second report.pdf must not silently shadow the first on extract.
    expect(zipNames(["report.pdf", "Report.pdf", "report.pdf"]))
      .toEqual(["report.pdf", "Report (2).pdf", "report (3).pdf"]);
  });

  it("flattens a path rather than letting an extractor create it", () => {
    // "../../etc/passwd" as an entry name is the classic zip-slip payload.
    expect(zipNames(["a/b/c.pdf", "..\\evil.exe", ""])).toEqual(["c.pdf", "evil.exe", "file"]);
  });
});

describe("the archive itself", () => {
  it("carries the right magic numbers in the right places", () => {
    const zip = buildZip([{ name: "hi.txt", data: new TextEncoder().encode("hello") }]);
    const u32at = (i: number) => zip[i] | (zip[i + 1] << 8) | (zip[i + 2] << 16) | ((zip[i + 3] << 24) >>> 0);
    expect(u32at(0)).toBe(0x04034b50);                 // local header first
    expect(u32at(zip.length - 22)).toBe(0x06054b50);   // end record last
    // The stored bytes are in there verbatim - method 0 means findable.
    expect(new TextDecoder().decode(zip).includes("hello")).toBe(true);
  });

  it("an empty selection is still a valid, empty archive", () => {
    const zip = buildZip([]);
    expect(zip.length).toBe(22); // just the end record
  });
});
