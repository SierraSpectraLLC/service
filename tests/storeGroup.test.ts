import { describe, expect, it } from "vitest";
import { groupStoredFiles, totalBytes, type FileRow } from "@/lib/storeGroup";

// The reported problem: a page titled "storage" that listed one file while the
// meter beside it counted several. The list and the meter must answer the same
// question, and the invariant that makes that true is here - one row per STORED
// file, size counted once however many records point at it.

const row = (over: Partial<FileRow> & { id: number; url: string; size: number }): FileRow => ({
  fileName: "f.pdf", kind: "Report", description: "", uploadedBy: "Ann",
  instrumentId: null, externalId: null, assetId: null, assetLabel: null, orgId: null,
  ...over,
});

describe("groupStoredFiles", () => {
  it("counts one stored file once, however many records point at it", () => {
    // sop.pdf sits on the shelf and on two systems: three rows, one upload.
    const files = groupStoredFiles([
      row({ id: 3, url: "blob://sop", size: 1000, instrumentId: 11, externalId: "S-001" }),
      row({ id: 2, url: "blob://sop", size: 1000, instrumentId: 10, externalId: "G-010" }),
      row({ id: 1, url: "blob://sop", size: 1000 }),
    ]);
    expect(files).toHaveLength(1);
    expect(totalBytes(files)).toBe(1000);
    expect(files[0].places.map((p) => p.kind)).toEqual(["system", "system", "shelf"]);
  });

  it("lists every place a file appears, with the record it links to", () => {
    const files = groupStoredFiles([
      row({ id: 2, url: "blob://cert", size: 50, assetId: 20, assetLabel: "Detector FID SN A1" }),
      row({ id: 1, url: "blob://cert", size: 50 }),
    ]);
    expect(files[0].places).toEqual([
      { kind: "unit", attachmentId: 2, id: 20, label: "Detector FID SN A1" },
      { kind: "shelf", attachmentId: 1 },
    ]);
  });

  it("keeps distinct files distinct even at identical sizes", () => {
    // Guards the reason usage sums a DISTINCT (url, size) subquery rather than
    // SUM(DISTINCT size): two unrelated 1 KB files are 2 KB.
    const files = groupStoredFiles([
      row({ id: 1, url: "blob://a", size: 1024 }),
      row({ id: 2, url: "blob://b", size: 1024 }),
    ]);
    expect(files).toHaveLength(2);
    expect(totalBytes(files)).toBe(2048);
  });

  it("names the file after its newest row", () => {
    // Rows arrive newest-first; somebody renamed it on the record after filing.
    const files = groupStoredFiles([
      row({ id: 2, url: "blob://x", size: 10, fileName: "as-found.pdf", instrumentId: 5, externalId: "G-1" }),
      row({ id: 1, url: "blob://x", size: 10, fileName: "scan0001.pdf" }),
    ]);
    expect(files[0].fileName).toBe("as-found.pdf");
    expect(files[0].newest.id).toBe(2);
  });

  it("falls back to an id when a record has no readable label", () => {
    const files = groupStoredFiles([
      row({ id: 1, url: "blob://y", size: 1, instrumentId: 7, externalId: null }),
      row({ id: 2, url: "blob://z", size: 1, assetId: 8, assetLabel: "" }),
    ]);
    expect(files[0].places[0]).toMatchObject({ label: "system 7" });
    expect(files[1].places[0]).toMatchObject({ label: "unit 8" });
  });

  it("is empty for an empty store, and totals zero", () => {
    expect(groupStoredFiles([])).toEqual([]);
    expect(totalBytes([])).toBe(0);
  });
});
