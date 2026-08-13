import { describe, expect, it } from "vitest";
import {
  coverIsChosen, coverPhoto, isPhotoFile, livingCover, orderPhotos, photoCount, photoRemovalNote,
  sharedCover, sharesPhotos, stockPhotoForSystem, stockPhotoForUnit, type CatalogPhoto,
} from "@/lib/photos";
import {
  coverZoom, frameStyle, NO_FRAME, normalizeFrame, parseFrame, serializeFrame, turned, ZOOM_MAX,
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
    const f = { rotate: 90, zoom: 1.5, x: -12, y: 8, aspect: 1.5 };
    expect(parseFrame(serializeFrame(f))).toEqual(f);
  });

  it("keeps a frame written before the photo's shape was recorded on the old rendering", () => {
    // Four numbers means "framed, shape unknown". Re-reading one must not invent
    // an aspect, or thousands of existing tiles would quietly shift.
    const legacy = parseFrame("90,1.5,-12,8");
    expect(legacy.aspect).toBe(0);
    expect(serializeFrame(legacy)).toBe("90,1.5,-12,8");
    expect(frameStyle(legacy).objectFit).toBe("cover");
  });

  it("stores an unframed photo as nothing at all", () => {
    // So the column stays empty for the thousands of photos nobody ever framed.
    expect(serializeFrame(NO_FRAME)).toBe("");
    expect(parseFrame("")).toEqual(NO_FRAME);
  });

  it("reads junk, a short string and a legacy blank as unframed", () => {
    // Four numbers or five; anything else is not a frame this app wrote.
    for (const junk of ["nonsense", "90,1", "90,1,0,0,1.5,3", "a,b,c,d", "0,1,0,0,x", null, undefined]) {
      expect(parseFrame(junk as string)).toEqual(NO_FRAME);
    }
  });

  it("clamps anything hand-edited into a range that still renders", () => {
    const f = normalizeFrame({ rotate: 47, zoom: 99, x: -900, y: 900 });
    expect(f.rotate).toBe(90);        // snapped to the nearest quarter turn
    expect(normalizeFrame({ rotate: 44 }).rotate).toBe(0);
    expect(f.zoom).toBe(ZOOM_MAX);
    expect(f.x).toBe(-100);
    expect(f.y).toBe(100);
  });

  it("refuses an aspect no photograph has, rather than rendering a sliver", () => {
    expect(normalizeFrame({ aspect: 200 }).aspect).toBe(0);
    expect(normalizeFrame({ aspect: 0.001 }).aspect).toBe(0);
    expect(normalizeFrame({ aspect: 1.7778 }).aspect).toBe(1.7778);
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

describe("stock photos from the catalog", () => {
  const term = (id: number, kind: string, name: string, assetType = ""): CatalogPhoto =>
    ({ id, kind, name, assetType, photoFraming: "" });
  const catalog = [
    term(1, "model", "SPD-20A", "Detector"),
    term(2, "asset_type", "Detector"),
    term(3, "asset_type", "Pump"),
    term(4, "category", "LC-MS"),
    term(5, "model", "Universal PC"),        // a model nobody pinned to a type
  ];

  it("prefers the model, because that is what somebody recognizes", () => {
    expect(stockPhotoForUnit(catalog, "Detector", "SPD-20A")?.id).toBe(1);
  });

  it("falls back to the module type when the model has no photo", () => {
    expect(stockPhotoForUnit(catalog, "Detector", "SPD-40")?.id).toBe(2);
    expect(stockPhotoForUnit(catalog, "Pump", "")?.id).toBe(3);
  });

  it("has nothing to offer for kit the catalog has never seen", () => {
    expect(stockPhotoForUnit(catalog, "Chiller", "XR-9")).toBeNull();
    expect(stockPhotoForUnit(catalog, "", "")).toBeNull();
  });

  it("matches the way the catalog matches everywhere else - case and space blind", () => {
    expect(stockPhotoForUnit(catalog, "detector", " spd-20a ")?.id).toBe(1);
    expect(stockPhotoForSystem(catalog, "lc-ms")?.id).toBe(4);
  });

  it("does not let one type's model stand in for another's", () => {
    // A "Pump" called SPD-20A is not the detector, whatever it was named.
    expect(stockPhotoForUnit(catalog, "Pump", "SPD-20A")?.id).toBe(3);
    // A model with no type pinned is offered to whoever asks for it by name.
    expect(stockPhotoForUnit(catalog, "Anything", "Universal PC")?.id).toBe(5);
  });

  it("gives a system nothing when its category is blank", () => {
    expect(stockPhotoForSystem(catalog, "")).toBeNull();
    expect(stockPhotoForSystem(catalog, "GC-MS")).toBeNull();
  });
});

describe("a unit tracked as a system", () => {
  it("shares its photos while it is the only thing on the system", () => {
    expect(sharesPhotos(1)).toBe(true);
    expect(sharesPhotos(0)).toBe(false);   // a system with nothing on it yet
    expect(sharesPhotos(2)).toBe(false);   // a bench, whose photo is the bench
  });

  it("takes whichever of the pair holds the cover", () => {
    expect(sharedCover(7, null)).toBe(7);
    expect(sharedCover(null, 9)).toBe(9);
    expect(sharedCover(null, null)).toBeNull();
    // Both set can only happen to rows written before the pair shared; the
    // record's own pointer is the one it keeps.
    expect(sharedCover(7, 9)).toBe(7);
  });
});

describe("reframing reaches the whole photograph", () => {
  // The bug: object-fit cover crops the photo to the tile BEFORE the transform,
  // so the top and bottom of a portrait photo were thrown away and no amount of
  // dragging brought them back. A framed photo is drawn contained instead.
  it("draws all of a framed photo, not the part that survived a crop", () => {
    expect(frameStyle({ rotate: 0, zoom: 1, x: 0, y: 0, aspect: 0.75 }).objectFit).toBe("contain");
  });

  it("leaves an unframed photo filling its tile as before", () => {
    expect(frameStyle(NO_FRAME).objectFit).toBe("cover");
  });

  it("applies the stored zoom as it stands once the shape is known", () => {
    // No hidden fill factor in this path: the framer already chose a zoom that
    // means what it says, so the tile must not multiply it by anything.
    const s = frameStyle({ rotate: 90, zoom: 2.5, x: 4, y: -6, aspect: 0.75 });
    expect(s.transform).toBe("translate(4%, -6%) rotate(90deg) scale(2.5)");
  });
});

describe("the zoom that exactly fills a tile", () => {
  it("is 1 when the photo is the same shape as the tile", () => {
    expect(coverZoom(4 / 3, 4 / 3)).toBe(1);
  });

  it("matches the old quarter-turn fill factor it replaces", () => {
    // The previous code multiplied by max(r, 1/r) for a quarter turn; for a
    // photo of the tile's own shape that is exactly this.
    expect(coverZoom(4 / 3, 4 / 3, 90)).toBe(1.333);
    expect(coverZoom(1, 1, 90)).toBe(1);
  });

  it("grows as the photo's shape departs from the tile's", () => {
    expect(coverZoom(0.75, 4 / 3)).toBeCloseTo(1.778, 2);   // portrait in a landscape tile
    expect(coverZoom(3, 4 / 3)).toBeCloseTo(2.25, 2);       // panorama in a landscape tile
  });

  it("falls back to filling exactly when the shape is unknown", () => {
    expect(coverZoom(0, 4 / 3)).toBe(1);
  });
});

describe("a cover pointer that outlived its photo", () => {
  const photos = [p(1, "bench.jpg", "2026-01-04T10:00:00Z"), p(2, "inlet.jpg", "2026-06-01T10:00:00Z")];

  it("keeps a cover whose file is still there", () => {
    expect(livingCover(photos, 2)).toBe(2);
  });

  it("lets go of one whose file is gone", () => {
    // The bug this closes: deleting the cover left an id on the record pointing
    // at nothing, so the thumbnail asked for a 404 and the catalog stand-in
    // never got its turn - the page thought it had a cover.
    expect(livingCover(photos, 99)).toBe(null);
    expect(livingCover([], 2)).toBe(null);
    expect(livingCover(photos, null)).toBe(null);
  });
});

describe("saying that photos were removed", () => {
  it("is one line for one photo", () => {
    expect(photoRemovalNote(["inlet.jpg"], "duplicate"))
      .toBe("removed photo: inlet.jpg (files deleted from storage) - reason: duplicate");
  });

  it("is still one line for fifteen", () => {
    // A row per file turned clearing a setup shoot into fifteen entries in a
    // history meant to record what happened to the machine.
    const names = Array.from({ length: 15 }, (_, i) => `setup-${i + 1}.jpg`);
    const line = photoRemovalNote(names, "setup shots, no longer needed");
    expect(line).toContain("removed 15 photos");
    expect(line).toContain("setup-1.jpg");
    expect(line).toContain("and 7 more");
    expect(line.split("removed").length - 1).toBe(1);
  });

  it("names them all when there are few enough to read", () => {
    expect(photoRemovalNote(["a.jpg", "b.jpg"], "why")).toContain("a.jpg, b.jpg");
    expect(photoRemovalNote(["a.jpg", "b.jpg"], "why")).not.toContain("more");
  });
});
