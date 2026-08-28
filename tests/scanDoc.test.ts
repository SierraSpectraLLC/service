// The scanner's geometry - the half of a document scan that can be wrong
// quietly.
//
// The OpenCV half is visible when it fails: no corners are found, the dialog
// says so, and somebody drags them. The arithmetic here fails differently.
// Corners in the wrong order do not error - they produce a mirrored or
// bow-tied scan. A quad that passes a plausibility check it should not have
// produces a confident crop of the wrong rectangle, which is how two thirds of
// a $340 hotel folio goes missing without anybody noticing until the payout is
// queried six weeks later.
//
// So everything that decides WHICH pixels survive is pure, and tested here.
import { describe, expect, it } from "vitest";
import {
  MAX_SCAN_EDGE, clampPoint, orderCorners, outputSize, quadArea, quadIsPlausible,
  scaleQuad, scanName, wholeFrame, type Point, type Quad,
} from "@/lib/scanDoc";

/** A receipt filling most of a 1000x800 frame, photographed square on. */
const SQUARE: Quad = [
  { x: 100, y: 80 }, { x: 900, y: 80 }, { x: 900, y: 720 }, { x: 100, y: 720 },
];
/** The same receipt shot from the left: the far edge is shorter than the near. */
const SKEWED: Quad = [
  { x: 120, y: 60 }, { x: 880, y: 140 }, { x: 900, y: 700 }, { x: 100, y: 760 },
];

describe("putting four corners into reading order", () => {
  it("finds the same order however OpenCV happened to walk the contour", () => {
    /*
     * The one that matters. getPerspectiveTransform pairs corners
     * POSITIONALLY, so a rotated ordering does not make a rotated scan - it
     * makes a mirrored or bow-tied one. Every rotation of the same rectangle
     * must land on the same answer.
     */
    for (let shift = 0; shift < 4; shift++) {
      const rotated = [...SQUARE.slice(shift), ...SQUARE.slice(0, shift)];
      expect(orderCorners(rotated)).toEqual(SQUARE);
    }
  });

  it("finds it from a reversed walk too", () => {
    // Contours come back clockwise or anticlockwise depending on the hierarchy.
    expect(orderCorners([...SQUARE].reverse())).toEqual(SQUARE);
  });

  it("orders a skewed quad by corner, not by coordinate", () => {
    const shuffled = [SKEWED[2], SKEWED[0], SKEWED[3], SKEWED[1]];
    expect(orderCorners(shuffled)).toEqual(SKEWED);
  });

  it("refuses anything that is not four points", () => {
    // approxPolyDP returns whatever it simplifies to. Three points is a
    // triangle, not a receipt, and silently proceeding would index undefined.
    expect(() => orderCorners([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }])).toThrow();
    expect(() => orderCorners([])).toThrow();
  });
});

describe("the area of a quad", () => {
  it("measures a rectangle as its sides", () => {
    expect(quadArea(SQUARE)).toBe(800 * 640);
  });

  it("does not go negative on a reversed winding", () => {
    expect(quadArea([...SQUARE].reverse() as Quad)).toBe(800 * 640);
  });
});

describe("deciding whether a detected shape is the paper", () => {
  const W = 1000, H = 800;

  it("accepts a receipt filling most of the frame", () => {
    expect(quadIsPlausible(SQUARE, W, H)).toBe(true);
    expect(quadIsPlausible(SKEWED, W, H)).toBe(true);
  });

  it("rejects a small blob - that is a floor tile, not a receipt", () => {
    // Edge detection always returns SOMETHING. A confident crop to the wrong
    // rectangle is the failure this whole check exists to prevent.
    const tile: Quad = [
      { x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 },
    ];
    expect(quadIsPlausible(tile, W, H)).toBe(false);
  });

  it("rejects the frame itself - that means it found nothing", () => {
    // Locking onto the photo's own border is a detector saying "no edges
    // here", and cropping to it produces a scan of the whole photograph.
    expect(quadIsPlausible(wholeFrame(W, H), W, H)).toBe(false);
  });

  it("rejects a bow tie", () => {
    // Two corners crossed. Warping through one smears the page diagonally,
    // and the area check alone would have waved it past.
    const bowtie: Quad = [
      { x: 100, y: 80 }, { x: 900, y: 80 }, { x: 100, y: 720 }, { x: 900, y: 720 },
    ];
    expect(quadIsPlausible(bowtie, W, H)).toBe(false);
  });

  it("rejects a sliver", () => {
    // Tall and thin enough to pass on area, but one side is a needle -
    // stretching that across a page is how a scan becomes a smear.
    const sliver: Quad = [
      { x: 100, y: 10 }, { x: 130, y: 10 }, { x: 130, y: 790 }, { x: 100, y: 790 },
    ];
    expect(quadIsPlausible(sliver, W, H)).toBe(false);
  });

  it("says no rather than dividing by zero on an empty frame", () => {
    expect(quadIsPlausible(SQUARE, 0, 0)).toBe(false);
  });
});

describe("sizing the flattened page", () => {
  it("keeps a square-on receipt at its own size", () => {
    expect(outputSize(SQUARE)).toEqual({ width: 800, height: 640 });
  });

  it("takes the LONGER of each pair of opposite sides", () => {
    /*
     * A receipt shot at an angle has a near edge and a far edge. Sizing to the
     * short one squashes the far half of the text to fit; sizing to the long
     * one keeps every pixel that was actually captured and lets interpolation
     * invent the rest.
     */
    const near: Quad = [
      { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 800, y: 600 }, { x: 0, y: 600 },
    ];
    // Top edge 400, bottom edge 800 - the answer is 800.
    expect(outputSize(near).width).toBe(800);
  });

  it("caps the long side, because this lands in a storage quota", () => {
    const huge: Quad = [
      { x: 0, y: 0 }, { x: 9000, y: 0 }, { x: 9000, y: 4500 }, { x: 0, y: 4500 },
    ];
    const size = outputSize(huge);
    expect(Math.max(size.width, size.height)).toBe(MAX_SCAN_EDGE);
    // And keeps the shape: 2:1 in, 2:1 out.
    expect(size.width / size.height).toBeCloseTo(2, 5);
  });

  it("never returns a zero dimension", () => {
    // A degenerate quad must not produce a canvas the browser refuses.
    const flat: Quad = [
      { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 },
    ];
    const size = outputSize(flat);
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });
});

describe("moving between the two scales of the same photo", () => {
  it("scales a quad found on the preview onto the full-resolution image", () => {
    /*
     * Detection runs on a downscaled copy - a 12 megapixel Canny pass is
     * several seconds on a mid-range phone - and the warp runs on the
     * original, so nothing is lost. This factor is the join, and getting it
     * wrong crops the corner of the receipt at 4x magnification.
     */
    expect(scaleQuad(SQUARE, 4)[2]).toEqual({ x: 3600, y: 2880 });
    expect(scaleQuad(SQUARE, 1)).toEqual(SQUARE);
  });
});

describe("dragging a corner", () => {
  const at = (x: number, y: number): Point => clampPoint({ x, y }, 1000, 800);

  it("keeps it inside the picture", () => {
    // A finger dragged off the edge of a phone screen must not put a corner
    // outside the source image, which warps into a black wedge.
    expect(at(-40, -40)).toEqual({ x: 0, y: 0 });
    expect(at(9999, 9999)).toEqual({ x: 1000, y: 800 });
    expect(at(500, 400)).toEqual({ x: 500, y: 400 });
  });
});

describe("naming the result", () => {
  it("marks it as a scan and keeps the original stem", () => {
    // The file name is what a reviewer sees on the row six weeks later, so it
    // should say what the thing is.
    expect(scanName("IMG_0421.HEIC")).toBe("IMG_0421-scan.jpg");
    expect(scanName("receipt.jpeg")).toBe("receipt-scan.jpg");
  });

  it("copes with a nameless or extensionless file", () => {
    expect(scanName("")).toBe("receipt-scan.jpg");
    expect(scanName("image")).toBe("image-scan.jpg");
    expect(scanName(".jpg")).toBe("receipt-scan.jpg");
  });

  it("does not let a pathological name run away", () => {
    expect(scanName("x".repeat(400)).length).toBeLessThan(80);
  });
});
