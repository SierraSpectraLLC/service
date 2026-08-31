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
  if (area < frame * 0.18) return false;
  if (area > frame * 0.995) return false;

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
 * Find the four corners of the paper, or null when nothing convincing is there.
 *
 * The pipeline is the standard one and worth reading as a sentence: blur away
 * the paper's texture, find edges, thicken them so a gap in a shadow does not
 * break a contour, take every closed contour, keep the biggest one that
 * simplifies to four points, and check it is plausible.
 *
 * Runs on a DOWNSCALED copy. Edge detection does not get better on a 12
 * megapixel image, it gets slower - several seconds on a mid-range phone
 * against a couple of hundred milliseconds here - and the corners it finds
 * scale back up exactly. The warp itself then runs on the full-resolution
 * original, so nothing is actually lost.
 */
export function detectQuad(cv: Cv, canvas: HTMLCanvasElement): Quad | null {
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(blurred, edges, 50, 150);
    cv.dilate(edges, edges, kernel);
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    let best: Quad | null = null;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const approx = new cv.Mat();
      try {
        const peri = cv.arcLength(c, true);
        cv.approxPolyDP(c, approx, 0.02 * peri, true);
        if (approx.rows === 4) {
          const pts: Point[] = [];
          for (let p = 0; p < 4; p++) {
            pts.push({ x: approx.data32S[p * 2], y: approx.data32S[p * 2 + 1] });
          }
          const quad = orderCorners(pts);
          const area = quadArea(quad);
          if (area > bestArea && quadIsPlausible(quad, canvas.width, canvas.height)) {
            best = quad;
            bestArea = area;
          }
        }
      } finally {
        approx.delete();
        c.delete();
      }
    }
    return best;
  } finally {
    // Emscripten has no garbage collector reaching into WASM memory: every Mat
    // is a manual allocation, and a scanner that leaks one per attempt walks a
    // phone into an out-of-memory crash after a dozen receipts.
    src.delete(); gray.delete(); blurred.delete(); edges.delete();
    contours.delete(); hierarchy.delete(); kernel.delete();
  }
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
