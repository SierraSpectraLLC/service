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
  MAX_SCAN_EDGE, candidateScore, clampPoint, extremeQuad, medianByte, orderCorners,
  outputSize, quadArea, quadIsPlausible, rectangularity, scaleQuad, scanName,
  wholeFrame, type Point, type Quad,
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

/*
 * ── The receipt on the beige floor ────────────────────────────────────────
 *
 * The first photograph a real engineer pointed this at, and it failed twice
 * over: the live viewfinder never drew an outline, and the captured still fell
 * back to a default rectangle nobody wanted. Both had one cause - detectQuad
 * returned null - and none of the fixtures above could have caught it, because
 * every one of them was white paper on a near-black car seat and the real one
 * was white paper on a pale stone floor, in sun.
 *
 * What the pipeline was measured doing on that image, so the numbers here are
 * observations rather than invention:
 *
 *   - Canny found NOTHING page-sized at any threshold: zero contours over 15%
 *     of the frame. Not a wrong rectangle - no candidate at all. White on pale
 *     stone is too weak a gradient to close a loop around, and a boundary with
 *     gaps encloses no area to measure.
 *   - Paper read S=12 V=204; the sunlit floor S=60 V=177. Twenty-seven units
 *     darker and FIVE TIMES less saturated - so a grey threshold welded them
 *     into one blob, and a saturation-aware one did not.
 *   - Scored on size, the welded blob BEAT the true page, because it is bigger:
 *     0.379 of frame against 0.324. Ranking on coverage rewards precisely the
 *     over-inclusive mistake.
 *
 * The quads below are the two real candidates that came out of that image.
 */
describe("choosing between what the strategies saw on a real photograph", () => {
  const W = 656, H = 1000;
  /** What a saturation-aware mask found: the receipt, corners on the paper. */
  const PAPER: Quad = [
    { x: 139, y: 188 }, { x: 496, y: 164 }, { x: 516, y: 774 }, { x: 173, y: 789 },
  ];
  /** What a grey threshold found: the same receipt welded to a sunlit floor
      patch, dragging one corner out to the frame's left edge. */
  const WELDED: Quad = [
    { x: 141, y: 188 }, { x: 496, y: 165 }, { x: 515, y: 774 }, { x: 0, y: 716 },
  ];

  it("prefers the page over the bigger blob that swallowed the floor", () => {
    // Both are plausible shapes; the whole question is which one wins. The
    // welded quad covers MORE of the frame, so any score led by coverage picks
    // it - which is what shipped, and what put a corner at x=0 on a real scan.
    expect(quadArea(WELDED)).toBeGreaterThan(quadArea(PAPER));
    const paper = candidateScore(quadArea(PAPER) * 0.97, PAPER, W, H);
    const welded = candidateScore(quadArea(WELDED) * 0.97, WELDED, W, H);
    expect(paper).toBeGreaterThan(welded);
  });

  it("tells them apart by their sides, which is what a page has", () => {
    // A page is a rectangle seen at an angle: opposite sides stay in
    // proportion. Yanking one corner to the frame edge destroys that, and it
    // is the only cheap signal that survives the two being nearly the same size.
    expect(rectangularity(PAPER)).toBeGreaterThan(0.9);
    expect(rectangularity(WELDED)).toBeLessThan(0.7);
  });

  it("refuses a rectangle that is really just the photograph", () => {
    /*
     * Also observed on that image: inverting the threshold made the FLOOR the
     * blob - a flawless rectangle over 94% of the frame, which scores near
     * perfectly on shape and beat the real page until this bound moved from
     * 99.5% down. Past this much of the picture there is nothing left to crop.
     */
    const floor: Quad = [
      { x: 0, y: 0 }, { x: 655, y: 0 }, { x: 655, y: 941 }, { x: 0, y: 941 },
    ];
    expect(quadArea(floor) / (W * H)).toBeGreaterThan(0.9);
    expect(quadIsPlausible(floor, W, H)).toBe(false);
  });

  it("accepts a page that leaves a wide margin - a phone held back", () => {
    // The other end of the same bound. The real receipt filled under a third
    // of the frame, and the original 18% floor was close enough to that to be
    // luck rather than judgement.
    expect(quadArea(PAPER) / (W * H)).toBeLessThan(0.35);
    expect(quadIsPlausible(PAPER, W, H)).toBe(true);
  });
});

describe("reducing a crumpled outline to four corners", () => {
  it("finds the corners through a wavy edge", () => {
    /*
     * Why approxPolyDP alone was not enough. A receipt that has been in a
     * pocket has a folded edge: its outline simplifies to five, six or seven
     * points and to four at no sensible tolerance, so demanding exactly four
     * threw away every real receipt. Extremes ignore the wobble between the
     * corners.
     */
    const wavy: Point[] = [
      { x: 100, y: 100 }, { x: 300, y: 92 }, { x: 500, y: 104 },   // top, rippled
      { x: 508, y: 400 }, { x: 494, y: 700 },                       // right, folded
      { x: 300, y: 712 }, { x: 104, y: 706 },                       // bottom
      { x: 92, y: 400 },                                            // left
    ];
    const q = extremeQuad(wavy);
    expect(q).not.toBeNull();
    expect(q![0]).toEqual({ x: 100, y: 100 });
    expect(q![2]).toEqual({ x: 494, y: 700 });
    expect(rectangularity(q!)).toBeGreaterThan(0.85);
  });

  it("refuses a thin diagonal, where two corners are the same point", () => {
    // A degenerate "quad" warps to a smear. Better to report nothing.
    expect(extremeQuad([
      { x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 200 }, { x: 300, y: 300 },
    ])).toBeNull();
  });

  it("needs four points to work with", () => {
    expect(extremeQuad([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull();
  });
});

describe("the median byte", () => {
  it("agrees with a sort, which is what it replaced", () => {
    // Swapped in because it runs on every viewfinder frame; it has to be the
    // same answer, only cheaper.
    const data = Uint8Array.from({ length: 5000 }, (_, i) => (i * 37 + 11) % 256);
    const sorted = Uint8Array.from(data).sort();
    expect(medianByte(data)).toBe(sorted[sorted.length >> 1]);
  });

  it("survives an empty image", () => {
    expect(medianByte(new Uint8Array(0))).toBe(128);
  });
});
