import { describe, expect, it } from "vitest";
import { coverIsChosen, coverPhoto, isPhotoFile, orderPhotos, photoCount } from "@/lib/photos";
import {
  frameStyle, NO_FRAME, normalizeFrame, parseFrame, serializeFrame, turned, ZOOM_MAX,
} from "@/lib/photoFrame";

const p = (id: number, fileName: string, createdAt: string, kind = "Photo") =>
  ({ id, fileName, kind, createdAt });

describe("what counts as a photo", () => {
  it("is what a browser can show, whatever it was filed as", () => {
    expect(isPhotoFile({ fileName: "inlet.jpg", kind: "Test data" })).toBe(true);
    expect(isPhotoFile({ fileName: "IMG_4021.HEIC", kind: "Other" })).toBe(true);
    expect(isPhotoFile({ fileName: "bench.png", kind: "Photo" })).toBe(true);
  });

  it("is not a document somebody filed under Photo", () => {
    expect(isPhotoFile({ fileName: "tune-report.pdf", kind: "Photo" })).toBe(false);
    expect(isPhotoFile({ fileName: "notes", kind: "Photo" })).toBe(false);
  });
});

describe("which photo goes on top", () => {
  const photos = [
    p(1, "old.jpg", "2026-01-04T10:00:00Z"),
    p(2, "newer.jpg", "2026-06-01T10:00:00Z"),
    p(3, "newest.jpg", "2026-08-01T10:00:00Z"),
  ];

  it("is the chosen cover, then the rest newest first", () => {
    expect(orderPhotos(photos, 1).map((r) => r.id)).toEqual([1, 3, 2]);
    expect(coverPhoto(photos, 1)?.id).toBe(1);
  });

  it("falls back to the newest when nothing was chosen", () => {
    expect(coverPhoto(photos, null)?.id).toBe(3);
    expect(coverIsChosen(photos, null)).toBe(false);
  });

  it("falls back to the newest when the chosen one was deleted", () => {
    // The pointer is a preference. Losing it should cost the preference, not
    // leave the record with no picture at all.
    expect(coverPhoto(photos, 99)?.id).toBe(3);
    expect(coverIsChosen(photos, 99)).toBe(false);
  });

  it("has nothing to show when there are no photos", () => {
    expect(coverPhoto([], 4)).toBeNull();
    expect(orderPhotos([], null)).toEqual([]);
  });

  it("counts in words a heading can use", () => {
    expect(photoCount(1)).toBe("1 photo");
    expect(photoCount(4)).toBe("4 photos");
  });
});

describe("framing", () => {
  it("round-trips through the column it is stored in", () => {
    const f = { rotate: 90, zoom: 1.5, x: -12, y: 8 };
    expect(parseFrame(serializeFrame(f))).toEqual(f);
  });

  it("stores an unframed photo as nothing at all", () => {
    // So the column stays empty for the thousands of photos nobody ever framed.
    expect(serializeFrame(NO_FRAME)).toBe("");
    expect(parseFrame("")).toEqual(NO_FRAME);
  });

  it("reads junk, a short string and a legacy blank as unframed", () => {
    for (const junk of ["nonsense", "90,1", "90,1,0,0,7", "a,b,c,d", null, undefined]) {
      expect(parseFrame(junk as string)).toEqual(NO_FRAME);
    }
  });

  it("clamps anything hand-edited into a range that still renders", () => {
    const f = normalizeFrame({ rotate: 47, zoom: 99, x: -900, y: 900 });
    expect(f.rotate).toBe(90);        // snapped to the nearest quarter turn
    expect(normalizeFrame({ rotate: 44 }).rotate).toBe(0);
    expect(f.zoom).toBe(ZOOM_MAX);
    expect(f.x).toBe(-50);
    expect(f.y).toBe(50);
  });

  it("wraps rotation rather than counting past a full turn", () => {
    expect(turned({ rotate: 270, zoom: 1, x: 0, y: 0 }).rotate).toBe(0);
    expect(normalizeFrame({ rotate: -90 }).rotate).toBe(270);
  });

  it("covers the box when a photo is turned on its side", () => {
    // The bug this prevents: a sideways photo turned upright leaves bars down
    // both sides, because its short edge now has to span the box's long one.
    const flat = frameStyle({ rotate: 0, zoom: 1, x: 0, y: 0 });
    const side = frameStyle({ rotate: 90, zoom: 1, x: 0, y: 0 });
    expect(flat.transform).toContain("scale(1)");
    expect(side.transform).toContain("scale(1.333)");
  });

  it("covers by the shape of the box it is actually in", () => {
    // Caught by looking at a phone: the gallery's tiles are as wide as the
    // column, so a tile framed for a 4:3 box showed grey down both sides once
    // the column got wide. The scale has to come from the box, never a default.
    const wide = frameStyle({ rotate: 90, zoom: 1, x: 0, y: 0 }, 2.75);
    expect(wide.transform).toContain("scale(2.75)");
    // A square box needs no extra scale at all - it is the same box turned.
    expect(frameStyle({ rotate: 90, zoom: 1, x: 0, y: 0 }, 1).transform).toContain("scale(1)");
    // Portrait boxes fall the same way round, so the ratio is taken either way.
    expect(frameStyle({ rotate: 270, zoom: 1, x: 0, y: 0 }, 0.5).transform).toContain("scale(2)");
  });

  it("pans before it rotates, so a drag goes where the finger went", () => {
    const { transform } = frameStyle({ rotate: 90, zoom: 2, x: 10, y: -5 });
    expect(transform.indexOf("translate")).toBeLessThan(transform.indexOf("rotate"));
    expect(transform.indexOf("rotate")).toBeLessThan(transform.indexOf("scale"));
  });
});
