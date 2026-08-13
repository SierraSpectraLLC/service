import { describe, expect, it } from "vitest";
import { CHUNK_BYTES, chunkRanges, safeFileName } from "@/lib/cloudUpload";

describe("chunking a packet for upload", () => {
  it("covers every byte exactly once, in order", () => {
    const total = CHUNK_BYTES * 2 + 17;
    const ranges = chunkRanges(total);
    expect(ranges[0].start).toBe(0);
    expect(ranges[ranges.length - 1].end).toBe(total - 1);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i].start).toBe(ranges[i - 1].end + 1);
  });

  it("keeps every chunk but the last a multiple of 320 KiB", () => {
    // Graph rejects the whole upload otherwise, after the bytes have been sent.
    const ranges = chunkRanges(CHUNK_BYTES * 3 + 5);
    for (const r of ranges.slice(0, -1)) expect((r.end - r.start + 1) % (320 * 1024)).toBe(0);
  });

  it("sends a small packet as one chunk, and nothing for an empty one", () => {
    expect(chunkRanges(1000)).toEqual([{ start: 0, end: 999 }]);
    expect(chunkRanges(0)).toEqual([]);
    expect(chunkRanges(-5)).toEqual([]);
  });
});

describe("naming a file the far end will accept", () => {
  it("strips what Windows and SharePoint refuse", () => {
    expect(safeFileName('X-004: tune "report" #3/4.pdf')).toBe("X-004- tune -report- -3-4.pdf");
  });

  it("always yields something", () => {
    expect(safeFileName("   ")).toBe("packet.pdf");
    expect(safeFileName("x".repeat(300))).toHaveLength(120);
  });
});
