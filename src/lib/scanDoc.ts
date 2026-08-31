// Turning a photo of a receipt into a scan of one.
//
// The gesture this exists for is somebody standing beside a van with a
// crumpled receipt: point, shoot, and get back a flat white rectangle instead
// of a photograph of paper on a car seat at an angle, half in shadow, with a
// steering wheel in the corner. That is what a phone's document scanner does,
// and it is four steps - find the four corners of the paper, stretch them back
// to a rectangle, flatten the lighting, and re-encode small.
//
// WHERE THE WORK HAPPENS. In the browser, before the upload. Receipt uploads
// go straight from the phone to Blob storage (see /api/upload, which only
// mints a token), so the bytes never pass a server of ours - which makes the
// browser not merely the convenient place to do this but the only one that
// does not add a round trip. It also means the engineer sees the result and
// can retake before anything is stored.
//
// WHAT IS PURE AND WHAT IS NOT. Everything about quadrilaterals - ordering
// corners, judging whether a detected shape is plausible, working out the
// output size - is pure and tested, because that is where the bugs that
// silently mangle a $340 hotel folio live. The OpenCV calls are the other
// half and are only as good as their arguments.
//
// THE COST. opencv.js is ~9 MB, vendored at public/scan (see the README
// there). It is loaded the first time somebody taps Scan and never otherwise,
// so nobody who does not use this pays for it.

/** A corner, in the source image's own pixel coordinates. */
export type Point = { x: number; y: number };
/** Four corners, always in the order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Four points in whatever order OpenCV found them, put into reading order.
 *
 * Sum and difference rather than angles, which is the standard trick and the
 * robust one: on any convex quad the top-left corner has the smallest x+y and
 * the bottom-right the largest, while x-y separates the other two. Sorting by
 * angle around the centroid gets the same answer more slowly and falls apart
 * on a near-degenerate shape.
 *
 * Order matters more than it looks. getPerspectiveTransform pairs source
 * corners with destination corners positionally, so a rotated ordering does
 * not produce a rotated scan - it produces a mirrored or bow-tied one.
 */
export function orderCorners(points: Point[]): Quad {
  if (points.length !== 4) throw new Error(`orderCorners needs 4 points, got ${points.length}`);
  const bySum = [...points].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...points].sort((a, b) => (a.x - a.y) - (b.x - b.y));
  return [bySum[0], byDiff[3], bySum[3], byDiff[0]];
}

/** The area of a quad, by the shoelace formula. */
export function quadArea(q: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * Is this shape worth trusting as "the piece of paper"?
 *
 * The failure this exists to prevent is the quiet one. Edge detection always
 * returns SOMETHING - the edge of a laptop, a floor tile, a shadow - and a
 * scanner that crops confidently to the wrong rectangle throws away half a
 * receipt while looking like it worked. When these tests fail the answer is to
 * show the whole photo with the corners on its edges and let a person drag
 * them, which is never wrong, only slower.
 *
 * Three questions, cheap ones:
 *   - is it most of the picture? A real receipt shot to be read fills the
 *     frame. A 12% blob is a floor tile.
 *   - is it not ALL of the picture? A quad on the image border means the
 *     detector locked onto the photo's own edge and found nothing.
 *   - is it convex, with no needle-thin side? A bow tie or a sliver is a
 *     misdetection, and warping through one produces a smear.
 */
export function quadIsPlausible(q: Quad, width: number, height: number): boolean {
  const frame = width * height;
  if (frame <= 0) return false;
  const area = quadArea(q);
  /* 12%, not the 18% this started at. A phone held far enough back to get a
     whole page in frame leaves real margin around it, and a page that filled
     only a sixth of the picture was being thrown away as a floor tile. The
     tile check still bites: a tile is a few percent, not a seventh. */
  if (area < frame * 0.12) return false;
  /* 90%, not the 99.5% this started at, and the gap between those two numbers
     was a real misdetection: inverting the threshold on a receipt lying on a
     dark floor made the FLOOR the blob, which is a flawless rectangle covering
     94% of the picture and outscored the actual page. Past this much of the
     frame there is nothing left to crop - the page's own edges would be at or
     beyond the picture's - so a confident answer here is always a wrong one. */
  if (area > frame * 0.9) return false;
  // The same mistake shifted inward: four corners all sitting on the picture's
  // border is the detector describing the photograph, not a page within it.
  const near = Math.max(2, Math.min(width, height) * 0.02);
  const onBorder = (p: Point) =>
    p.x <= near || p.y <= near || p.x >= width - near || p.y >= height - near;
  if (q.every(onBorder)) return false;

  // Convex: every cross product of consecutive edges must share a sign.
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }

  // No side shorter than 5% of the frame's smaller dimension - that is a
  // sliver, and stretching one across a page is how a scan becomes a smear.
  const min = Math.min(width, height) * 0.05;
  for (let i = 0; i < 4; i++) if (dist(q[i], q[(i + 1) % 4]) < min) return false;
  return true;
}

/** The whole frame, as the quad to fall back to when detection is not trusted. */
export const wholeFrame = (width: number, height: number): Quad => [
  { x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height },
];

/**
 * The four extreme corners of a blob's outline.
 *
 * The reduction that makes a CRUMPLED page work. A receipt with a folded edge
 * has a wavy outline that simplifies to five, six or seven points at any
 * sensible tolerance and to four at none - so asking approxPolyDP for exactly
 * four corners throws away every real receipt that has been in a pocket.
 * Extremes do not care about the wobble between the corners: on any convex
 * outline the top-left corner still has the smallest x+y and the bottom-right
 * the largest, exactly as in orderCorners, and x-y still separates the other
 * two.
 *
 * Null when the blob is a thin diagonal, where two of the four extremes land
 * on the same point and the "quad" is a degenerate triangle.
 */
export function extremeQuad(points: Point[]): Quad | null {
  if (points.length < 4) return null;
  let tl = points[0], tr = points[0], br = points[0], bl = points[0];
  for (const p of points) {
    if (p.x + p.y < tl.x + tl.y) tl = p;
    if (p.x + p.y > br.x + br.y) br = p;
    if (p.x - p.y > tr.x - tr.y) tr = p;
    if (p.x - p.y < bl.x - bl.y) bl = p;
  }
  const q: Quad = [tl, tr, br, bl];
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      if (q[i].x === q[j].x && q[i].y === q[j].y) return null;
    }
  }
  return q;
}

/**
 * How nearly a quad is a rectangle seen at an angle: 1 for a true rectangle,
 * falling toward 0 as it turns into a wedge.
 *
 * Opposite sides, compared as ratios. A page is a planar rectangle, and
 * perspective shortens the far edge but keeps the pairs within a fair fraction
 * of each other; nothing else in a photograph of one is shaped like that.
 * Deliberately not angles - a genuine perspective shot has corners well off 90
 * degrees, and judging those would reject the very photographs this is for.
 */
export function rectangularity(q: Quad): number {
  const side = (i: number) => dist(q[i], q[(i + 1) % 4]);
  const pair = (a: number, b: number) => (Math.max(a, b) > 0 ? Math.min(a, b) / Math.max(a, b) : 0);
  return pair(side(0), side(2)) * pair(side(1), side(3));
}

/**
 * How page-like a candidate is, for choosing between the strategies below.
 *
 * RECTANGULARITY leads, and that ordering is the correction that made a real
 * photograph come out right. Scoring on coverage first picks the WRONG answer
 * by construction: an over-inclusive blob - the page welded to a sunlit patch
 * of the floor - is bigger than the page, so "biggest" rewards exactly the
 * mistake. On the receipt this was built against, the true quad and the welded
 * one differed by four points of coverage and by a THIRD of their side-ratio
 * symmetry.
 *
 * FILL - how much of the quad the blob occupies - keeps out an L of shadow
 * along two edges, or two bright patches whose bounding quad happens to be
 * large. A real page fills its own corners.
 *
 * COVERAGE stays, under a square root, because the page IS the subject of the
 * photograph and a tenth of the frame is something else - but weakly, so it
 * breaks ties rather than deciding.
 */
export function candidateScore(blobArea: number, q: Quad, width: number, height: number): number {
  const frame = width * height;
  const area = quadArea(q);
  if (frame <= 0 || area <= 0) return 0;
  const coverage = Math.min(1, area / frame);
  const fill = Math.min(1, blobArea / area);
  const rect = rectangularity(q);
  return Math.sqrt(coverage) * fill * rect * rect;
}

/**
 * How big the flattened result should be.
 *
 * Each dimension takes the LONGER of its two opposite sides: a receipt
 * photographed at an angle has a near edge and a far edge, and sizing to the
 * near one would squash the far half of the text to fit. Longer keeps every
 * pixel that was captured and lets interpolation invent the rest.
 *
 * Capped, because the result is going to a storage quota. 2200px on the long
 * side reads small print comfortably and lands a JPEG in the low hundreds of
 * kilobytes - against 3-8 MB for the raw phone photo this replaces.
 */
export const MAX_SCAN_EDGE = 2200;
export function outputSize(q: Quad, cap = MAX_SCAN_EDGE): { width: number; height: number } {
  const width = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  const height = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const scale = Math.min(1, cap / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Move a quad between two scales of the same image - detection runs small. */
export const scaleQuad = (q: Quad, factor: number): Quad =>
  q.map((p) => ({ x: p.x * factor, y: p.y * factor })) as Quad;

/** Keep a dragged corner inside the picture it belongs to. */
export const clampPoint = (p: Point, width: number, height: number): Point => ({
  x: Math.min(width, Math.max(0, p.x)),
  y: Math.min(height, Math.max(0, p.y)),
});

/** How the flattened page is finished. */
export type ScanMode = "document" | "photo";

// ── The parts that need OpenCV ────────────────────────────────────────────

/** The sliver of OpenCV.js this file uses. Typed loosely on purpose - the
 *  vendored build ships no types, and inventing a full set here would be a
 *  second thing to keep true. */
type Cv = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

declare global {
  interface Window { cv?: Cv }
}

export const OPENCV_URL = "/scan/opencv.js";

/**
 * The loaded runtime, in a BOX - and the box is not decoration.
 *
 * OpenCV.js's module object carries its own `then` method, which makes it
 * thenable, which makes it radioactive to promises: resolving any promise with
 * it does not hand the module to the caller, it makes the promise machinery
 * call cv.then(resolve, reject) and re-enter emscripten's initialiser. That
 * recurses until the renderer dies - not an exception, not a hang, the whole
 * tab. Verified headlessly against this exact build: `new Promise(r =>
 * r(window.cv))` takes the browser process down with it, and `{ cv }` does not.
 *
 * So the module never travels through a promise. It travels inside an object
 * that does not have a `then`, and callers unwrap it on the other side. For
 * the same reason this cannot be "simplified" to Promise<Cv> with a
 * `.then(box => box.cv)` - that hands the bare module to the next promise in
 * the chain and the tab dies one link later instead.
 */
export type CvBox = { cv: Cv };

let loading: Promise<CvBox> | null = null;

/** How long to wait for the WASM to compile before calling it a failure. */
export const OPENCV_TIMEOUT_MS = 60_000;

/**
 * Fetch and start OpenCV, once per session.
 *
 * Deliberately NOT an import. Bundling nine megabytes into a webpack chunk
 * makes every build slower for a file that never changes, and a <script> tag
 * against a static asset is what a CDN caches best. The promise is memoized so
 * a second scan in the same session is instant.
 *
 * READINESS IS POLLED, and the reason is worth writing down because the
 * obvious alternative is worse in two separate ways.
 *
 * `window.cv` exists the instant the script tag evaluates, but the embedded
 * WASM is still compiling, so cv.Mat is not there for another ~100 ms. The
 * documented-looking move is to hang a cv.onRuntimeInitialized handler and
 * wait. Do not: emscripten calls that hook exactly once and does not remember
 * having done it, so assigning it a beat late - whenever compilation beats the
 * next line, which on a warm cache is always - means it never fires at all.
 * And assigning it at all overwrites the hook OpenCV.js sets for ITSELF, which
 * is what wires up the bindings, so the early case breaks too. Both were
 * reproduced headlessly against this exact file: the dialog sat on
 * "Downloading the scanner..." with no error to explain it.
 *
 * A 50 ms poll for cv.Mat - which is the readiness signal OpenCV.js documents -
 * has neither problem. It cannot be too late, and it touches nothing. A load
 * that never becomes ready fails out loud rather than spinning.
 */
export function loadOpenCv(): Promise<CvBox> {
  if (loading) return loading;
  loading = new Promise<CvBox>((resolve, reject) => {
    if (typeof window === "undefined") { reject(new Error("No browser here")); return; }

    let settled = false;
    // Boxed. See CvBox above - resolving with the bare module kills the tab.
    const done = (cv: Cv) => { if (!settled) { settled = true; clearInterval(poll); resolve({ cv }); } };
    const fail = (message: string) => {
      if (!settled) { settled = true; clearInterval(poll); reject(new Error(message)); }
    };
    const started = Date.now();
    const poll = setInterval(() => {
      if (window.cv?.Mat) done(window.cv);
      else if (Date.now() - started > OPENCV_TIMEOUT_MS) {
        fail("The scanner did not start in time - attach the photo as it is, or try again");
      }
    }, 50);

    // Already on the page - from an earlier scan this session, or a second
    // dialog opened before the first finished. The poll above is watching it.
    if (window.cv || document.querySelector(`script[src="${OPENCV_URL}"]`)) return;

    const script = document.createElement("script");
    script.addEventListener("error", () =>
      fail("The scanner could not be downloaded - check the connection and try again"));
    script.src = OPENCV_URL;
    script.async = true;
    document.head.appendChild(script);
  });
  // A failed load must not poison the session - the usual cause is a dropped
  // connection in a car park, and the next tap should try again.
  loading.catch(() => { loading = null; });
  return loading;
}

/**
 * The median byte of a single-channel image, by histogram.
 *
 * Counting into 256 bins rather than sorting: this runs on every frame of the
 * live viewfinder, and sorting half a million bytes to find the middle one was
 * a measurable slice of the frame budget for an answer 256 counters give in
 * one pass.
 */
export function medianByte(data: ArrayLike<number>): number {
  if (!data.length) return 128;
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i] & 255]++;
  const half = data.length >> 1;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc > half) return v;
  }
  return 128;
}

/** An odd kernel size proportional to the picture, for closing text and gaps. */
const oddKernel = (width: number, height: number, divisor: number): number => {
  const n = Math.round(Math.min(width, height) / divisor);
  return Math.min(31, Math.max(3, n % 2 === 1 ? n : n + 1));
};

/**
 * Reduce one blob's outline to four corners, trying hardest first.
 *
 * Three rungs, and the ladder is the point - a page photographed on a desk is
 * a clean quadrilateral, a page that has been folded in a pocket is not, and
 * refusing the second is refusing most real receipts.
 *
 *   1. A genuine quadrilateral, if the outline simplifies to one at any sane
 *      tolerance. Most accurate, because it uses the real edges, and it is
 *      what makes a perspective shot come out square rather than merely
 *      cropped.
 *   2. The hull's four extreme corners (extremeQuad) - indifferent to a wavy
 *      edge between the corners.
 *   3. The smallest rotated rectangle that holds the blob. Cannot represent
 *      perspective, but it is never degenerate, and for the overhead shot
 *      that most phone scanning actually is, it is very close to right.
 */
function cornersOf(cv: Cv, contour: Cv, width: number, height: number): Quad | null {
  const hull = new cv.Mat();
  try {
    cv.convexHull(contour, hull);
    if (hull.rows < 4) return null;
    const pts: Point[] = [];
    for (let p = 0; p < hull.rows; p++) {
      pts.push({ x: hull.data32S[p * 2], y: hull.data32S[p * 2 + 1] });
    }

    const peri = cv.arcLength(hull, true);
    for (const k of [0.02, 0.03, 0.04, 0.05, 0.07, 0.09]) {
      const approx = new cv.Mat();
      try {
        cv.approxPolyDP(hull, approx, k * peri, true);
        if (approx.rows === 4) {
          const four: Point[] = [];
          for (let p = 0; p < 4; p++) {
            four.push({ x: approx.data32S[p * 2], y: approx.data32S[p * 2 + 1] });
          }
          const q = orderCorners(four);
          if (quadIsPlausible(q, width, height)) return q;
        }
      } finally { approx.delete(); }
    }

    const ex = extremeQuad(pts);
    if (ex && quadIsPlausible(ex, width, height)) return ex;

    const box = cv.RotatedRect.points(cv.minAreaRect(hull)) as Point[] | undefined;
    if (box && box.length === 4) {
      const q = orderCorners(box.map((p) => ({ x: p.x, y: p.y })));
      if (quadIsPlausible(q, width, height)) return q;
    }
    return null;
  } finally { hull.delete(); }
}

/** Every page-shaped candidate a binary mask offers, scored. */
function candidatesIn(
  cv: Cv, mask: Cv, width: number, height: number,
): { quad: Quad; score: number }[] {
  const out: { quad: Quad; score: number }[] = [];
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const frame = width * height;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      try {
        const area = cv.contourArea(c);
        if (area < frame * 0.1) continue;
        const quad = cornersOf(cv, c, width, height);
        if (quad) out.push({ quad, score: candidateScore(area, quad, width, height) });
      } finally { c.delete(); }
    }
    return out;
  } finally { contours.delete(); hierarchy.delete(); }
}

/**
 * Find the four corners of the paper, or null when nothing convincing is there.
 *
 * THREE WAYS OF SEEING A PAGE, scored against each other, because the one this
 * started with is the one that fails on the commonest photograph in the world.
 * Edge-following alone found NOTHING on a real receipt shot on a beige stone
 * floor - not a wrong rectangle, no page-sized contour at all - because white
 * paper on a light surface gives a gradient too weak for Canny to close a loop
 * around, and a boundary with gaps in it encloses no area to measure. Measured
 * on that photograph: zero contours over 15% of the frame at any threshold,
 * while a plain brightness split found the page at 41% of frame, which is what
 * it actually occupies.
 *
 *   BRIGHT  Otsu's split, page as the light side. Paper is usually the
 *           brightest thing in the picture, and this cares about the page's
 *           TONE rather than its edge, so a soft boundary is no obstacle.
 *   DARK    the same split inverted, for a page darker than what it lies on -
 *           a white desk, a lightbox, a service manual on a steel bench.
 *   EDGES   Canny, thresholds from the picture's own median rather than the
 *           fixed 50/150 that assumed a dark background, closed hard enough to
 *           bridge a shadow. Still the most accurate when it works, so it is
 *           kept and allowed to win on score.
 *
 * Runs on a DOWNSCALED copy. Detection does not get better on a 12 megapixel
 * image, it gets slower - several seconds on a mid-range phone against a
 * couple of hundred milliseconds here - and the corners it finds scale back up
 * exactly. The warp itself then runs on the full-resolution original, so
 * nothing is actually lost.
 */
export type PageCandidate = { quad: Quad; score: number; from: string };

/**
 * Every page-shaped candidate every strategy can see, best first.
 *
 * Split out from detectQuad so the choice between strategies is INSPECTABLE.
 * Which mask won, and by how much, is the whole question when a photograph
 * comes out cropped wrong, and it is not answerable from a function that
 * returns one quad.
 */
export function detectCandidates(
  cv: Cv, canvas: HTMLCanvasElement, opts: { fast?: boolean } = {},
): PageCandidate[] {
  const width = canvas.width, height = canvas.height;
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const paper = new cv.Mat();
  const mask = new cv.Mat();
  // Big enough to swallow the printing INSIDE the page: without it the page's
  // own text punches holes in the mask and its outline follows the paragraphs.
  const fill = oddKernel(width, height, 50);
  const closer = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(fill, fill));
  /* Severs the thin bright bridges between the page and whatever else in the
     picture is pale - a sunlit patch of the floor it is lying on. Applied
     BEFORE the close, which is the whole trick: closing first dilates the page
     across a small gap and welds it to that patch, and no amount of opening
     afterwards can tell the weld from the page. Opening first cuts a bridge
     thinner than the kernel while leaving a page hundreds of pixels wide
     untouched. Getting this order wrong put a corner out at the frame's edge
     on the very first real photograph. */
  const cut = oddKernel(width, height, 45);
  const opener = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(cut, cut));
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

    const found: PageCandidate[] = [];
    const take = (from: string) => {
      for (const c of candidatesIn(cv, mask, width, height)) found.push({ ...c, from });
    };

    /* PAPERNESS, and it is the strategy that rescued the first real photograph
       this scanner ever saw: a receipt on a beige stone floor, in sun. Measured
       there, paper read S=12 V=204 and the brightest floor S=60 V=177 - only
       27 units darker, which is why a grey threshold welded them into one blob
       and put a corner out at the frame's edge, but FIVE TIMES less saturated.
       Grey throws away the one channel that separates them.

       V - 2S is bright AND neutral in one number, which is what paper is and
       what almost nothing it gets photographed on is: wood, stone, upholstery,
       a desk and a car seat all carry colour. addWeighted rather than a pixel
       loop, so it stays cheap enough for the live viewfinder. */
    const rgb = new cv.Mat();
    const hsv = new cv.Mat();
    const chans = new cv.MatVector();
    try {
      cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      cv.split(hsv, chans);
      cv.addWeighted(chans.get(2), 1, chans.get(1), -2, 0, paper);
      cv.GaussianBlur(paper, paper, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
      cv.threshold(paper, mask, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.morphologyEx(mask, mask, cv.MORPH_OPEN, opener);
      cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, closer);
      take("paperness");
    } finally { rgb.delete(); hsv.delete(); chans.delete(); }

    /* The live viewfinder runs several times a second on a phone that is also
       decoding video, so it takes the two cheap strategies that between them
       cover almost every real page and leaves the rest to the shutter. The
       overlay is a HINT - it says "the camera can see it" - while the still
       gets the full set, and the corners it finds are editable either way. */
    for (const invert of opts.fast ? [false] : [false, true]) {
      cv.threshold(blurred, mask, 0, 255,
        (invert ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY) + cv.THRESH_OTSU);
      cv.morphologyEx(mask, mask, cv.MORPH_OPEN, opener);
      cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, closer);
      take(invert ? "dark" : "bright");
    }

    if (!opts.fast) {
      // The median drives the thresholds: a dim photo and a bright one need
      // different numbers, and 50/150 was only ever right for one of them.
      const median = medianByte(blurred.data as Uint8Array);
      cv.Canny(blurred, mask, Math.max(10, 0.66 * median), Math.min(255, 1.33 * median));
      cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, closer);
      take("edges");
    }

    found.sort((a, b) => b.score - a.score);
    return found;
  } finally {
    // Emscripten has no garbage collector reaching into WASM memory: every Mat
    // is a manual allocation, and a scanner that leaks one per attempt walks a
    // phone into an out-of-memory crash after a dozen receipts.
    src.delete(); gray.delete(); blurred.delete(); paper.delete(); mask.delete();
    closer.delete(); opener.delete();
  }
}

/** The best page-shaped thing in the picture, or null when nothing convinces. */
export function detectQuad(
  cv: Cv, canvas: HTMLCanvasElement, opts: { fast?: boolean } = {},
): Quad | null {
  return detectCandidates(cv, canvas, opts)[0]?.quad ?? null;
}

/**
 * Stretch the quad back into a rectangle and make it look like a document.
 *
 * "Document" is the mode people mean by scanning: grayscale, the paper forced
 * to white and the ink to black, so a photograph taken half in the shade of a
 * van reads like something off a flatbed. It is done with an ADAPTIVE
 * threshold rather than a global one, which is the whole trick - a global
 * threshold on an unevenly lit photo turns the shadowed third of the page
 * solid black. Adaptive asks the question per neighbourhood, so the shadow
 * simply goes away.
 *
 * "Photo" keeps the color and only lifts the contrast, for the receipts where
 * that matters - a card slip with a signature, a hotel folio with a stamp, and
 * thermal paper faint enough that hard thresholding would eat the print.
 */
export function warpToDocument(
  cv: Cv, canvas: HTMLCanvasElement, quad: Quad, mode: ScanMode, out: HTMLCanvasElement,
): void {
  const size = outputSize(quad);
  const src = cv.imread(canvas);
  const dst = new cv.Mat();
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, [
    quad[0].x, quad[0].y, quad[1].x, quad[1].y, quad[2].x, quad[2].y, quad[3].x, quad[3].y,
  ]);
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, size.width, 0, size.width, size.height, 0, size.height,
  ]);
  const M = cv.getPerspectiveTransform(from, to);
  const work = new cv.Mat();
  try {
    cv.warpPerspective(src, dst, M, new cv.Size(size.width, size.height),
      cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));

    if (mode === "document") {
      cv.cvtColor(dst, work, cv.COLOR_RGBA2GRAY);
      // A gentle blur first: adaptive thresholding amplifies sensor noise into
      // black speckle across what should be clean white paper.
      cv.medianBlur(work, work, 3);
      cv.adaptiveThreshold(work, work, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY, 21, 12);
    } else {
      // Color, with the histogram stretched per channel-ish: CLAHE on the
      // luminance only, so lifting a dim photo does not also saturate the ink.
      cv.cvtColor(dst, work, cv.COLOR_RGBA2GRAY);
      const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
      try { clahe.apply(work, work); } finally { clahe.delete(); }
      cv.cvtColor(work, work, cv.COLOR_GRAY2RGBA);
      cv.addWeighted(dst, 0.5, work, 0.5, 0, work);
    }
    cv.imshow(out, work);
  } finally {
    src.delete(); dst.delete(); from.delete(); to.delete(); M.delete(); work.delete();
  }
}

/**
 * Draw an image file onto a canvas, no larger than `cap` on its long side.
 *
 * Also the place EXIF rotation stops being a problem: createImageBitmap with
 * imageOrientation "from-image" applies the camera's own orientation tag, so a
 * photo taken in portrait does not arrive sideways and get "corrected" into a
 * landscape scan of a rotated receipt.
 */
export async function drawToCanvas(
  file: Blob, cap: number,
): Promise<{ canvas: HTMLCanvasElement; scale: number }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, cap / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser will not give us a canvas to work on");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { canvas, scale };
  } finally {
    bitmap.close();
  }
}

/** A canvas as a JPEG file, named after the receipt it came from. */
export function canvasToFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob
        ? resolve(new File([blob], scanName(name), { type: "image/jpeg" }))
        : reject(new Error("The scan could not be encoded")),
      "image/jpeg",
      0.85,
    );
  });
}

/** `IMG_0421.HEIC` becomes `IMG_0421-scan.jpg`. */
export const scanName = (name: string): string =>
  `${(name.replace(/\.[^.]+$/, "") || "receipt").slice(0, 60)}-scan.jpg`;

/**
 * A quarter turn clockwise, as a new canvas.
 *
 * EXIF rotation is already handled at decode (drawToCanvas), so this is for the
 * other case: paper genuinely photographed sideways - a wide folio shot with
 * the phone upright because that is how the phone was in the hand. The warp
 * cannot know which way up the words go; a person can, with one tap per turn.
 */
export function rotateQuarter(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = canvas.height;
  out.height = canvas.width;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("This browser will not give us a canvas to work on");
  ctx.translate(out.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

/** A canvas as JPEG bytes, for binding into a PDF (lib/scanPdf). */
export function canvasJpegBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => blob
        ? resolve(new Uint8Array(await blob.arrayBuffer()))
        : reject(new Error("The scan could not be encoded")),
      "image/jpeg",
      0.85,
    );
  });
}

/** What the detection pass runs on. Big enough for edges, small enough to be quick. */
export const DETECT_EDGE = 1000;
