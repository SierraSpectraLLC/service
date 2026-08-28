/**
 * Does the receipt scanner actually scan?
 *
 *   node scripts/check-scanner.mjs
 *
 * Not a vitest test, on purpose: this needs a real browser with real
 * WebAssembly, and making `npm test` depend on a Chromium download would be a
 * bad trade for one check. It is the check to run after touching
 * src/lib/scanDoc.ts, and it is not optional - everything interesting about
 * that file is invisible to a unit test and to a typechecker.
 *
 * WHAT IT ALREADY CAUGHT, both of which would have shipped:
 *
 *   1. Waiting on cv.onRuntimeInitialized. Emscripten calls that hook once and
 *      does not remember doing it, so assigning it a beat late means it never
 *      fires - and assigning it at all clobbers the hook OpenCV.js sets for
 *      itself. Symptom: "Downloading the scanner..." forever, no error.
 *
 *   2. Resolving a promise with the OpenCV module. The module is THENABLE, so
 *      the promise machinery calls cv.then() and re-enters the initialiser
 *      until the renderer dies. Symptom: tap Scan, the tab goes white.
 *
 * Neither is visible in TypeScript, in vitest, or by reading the code.
 *
 * The fixture is synthetic - a white quadrilateral with black bars, drawn at a
 * known perspective on a dark background - so the answer is checkable rather
 * than eyeballed: the corners it finds are compared against the ones we drew.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const ROOT = process.cwd();
const PORT = 8749;
/** The corners we draw the paper at, in the 1200x900 fixture. */
const TRUTH = [{ x: 210, y: 120 }, { x: 980, y: 205 }, { x: 900, y: 800 }, { x: 150, y: 700 }];
/** How far a found corner may sit from the drawn one before this is a failure. */
const TOLERANCE_PX = 12;

const PAGE = `<!doctype html><meta charset="utf-8"><title>scanner check</title><body>
<script src="/scan/opencv.js"></script>
<script src="/scandoc.js"></script>
<script>
window.makePhoto = function (corners) {
  const c = document.createElement("canvas");
  c.width = 1200; c.height = 900;
  const x = c.getContext("2d");
  x.fillStyle = "#3a3a3c"; x.fillRect(0, 0, c.width, c.height);   // the table
  x.save();
  x.beginPath();
  x.moveTo(corners[0].x, corners[0].y);
  for (const p of corners.slice(1)) x.lineTo(p.x, p.y);
  x.closePath();
  x.fillStyle = "#f7f5f0"; x.fill();                               // the paper
  x.clip();
  const xs = corners.map(p => p.x), ys = corners.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  x.fillStyle = "#101010";                                         // the print
  for (let i = 0; i < 14; i++) {
    x.fillRect(x0 + (x1 - x0) * 0.1, y0 + (y1 - y0) * (0.08 + i * 0.062),
      (x1 - x0) * (i % 3 ? 0.55 : 0.75), (y1 - y0) * 0.022);
  }
  x.restore();
  return c;
};
/* Exactly what ReceiptScanner does, in the same order: detect on a small copy,
   warp the full one, scaleQuad between. That join is the one most likely to be
   silently wrong, so the check has to exercise it rather than a shortcut. */
window.run = async function (corners) {
  const cv = (await ScanDoc.loadOpenCv()).cv;
  const blob = await new Promise((r) => window.makePhoto(corners).toBlob(r, "image/jpeg", 0.92));
  const big = await ScanDoc.drawToCanvas(blob, 4000);
  const small = await ScanDoc.drawToCanvas(blob, ScanDoc.DETECT_EDGE);
  const quad = ScanDoc.detectQuad(cv, small.canvas);
  if (!quad) return { found: false };
  const scaled = ScanDoc.scaleQuad(quad, big.canvas.width / small.canvas.width);
  const out = document.createElement("canvas");
  ScanDoc.warpToDocument(cv, big.canvas, scaled, "document", out);
  const px = out.getContext("2d").getImageData(0, 0, out.width, out.height).data;
  let white = 0, black = 0;
  for (let i = 0; i < px.length; i += 4) { if (px[i] > 200) white++; else if (px[i] < 60) black++; }
  const n = px.length / 4;
  const file = await ScanDoc.canvasToFile(out, "IMG_0421.HEIC");
  return { found: true, scaled, width: out.width, height: out.height,
    whiteFrac: white / n, blackFrac: black / n, fileName: file.name, fileKB: file.size / 1024 };
};
</script></body>`;

const fail = (why) => { console.error(`FAIL  ${why}`); process.exitCode = 1; };
const pass = (what) => console.log(`ok    ${what}`);

// The library itself, bundled for the browser - the real file, not a copy of it.
const bundled = await build({
  entryPoints: [join(ROOT, "src/lib/scanDoc.ts")],
  bundle: true, format: "iife", globalName: "ScanDoc", write: false,
});
const scandoc = bundled.outputFiles[0].text;

const server = createServer(async (req, res) => {
  try {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); return;
    }
    if (req.url === "/scandoc.js") {
      res.writeHead(200, { "content-type": "text/javascript" }); res.end(scandoc); return;
    }
    const path = join(ROOT, "public", req.url.split("?")[0]);
    const body = await readFile(path);
    res.writeHead(200, { "content-type": extname(path) === ".js" ? "text/javascript" : "text/plain" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] } : {},
);
const page = await browser.newPage();
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
page.on("crash", () => fail("the page crashed - see the thenable note in scanDoc.ts"));

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load", timeout: 120_000 });
  const r = await Promise.race([
    page.evaluate((c) => window.run(c), TRUTH),
    new Promise((_, rej) => setTimeout(() => rej(new Error(
      "the scanner never became ready - see the onRuntimeInitialized note in scanDoc.ts")), 90_000)),
  ]);

  if (!r.found) {
    fail("no paper found in a fixture that is 60% paper");
  } else {
    pass("found the paper");
    const errs = r.scaled.map((q, i) => Math.hypot(q.x - TRUTH[i].x, q.y - TRUTH[i].y));
    const worst = Math.max(...errs);
    if (worst > TOLERANCE_PX) fail(`corners are ${worst.toFixed(1)}px out (allowed ${TOLERANCE_PX})`);
    else pass(`corners within ${worst.toFixed(1)}px of where the paper was drawn`);

    // A document scan is white paper with ink on it. Grey everywhere means the
    // threshold pass did nothing; no black means it ate the print.
    if (r.whiteFrac < 0.6) fail(`only ${(r.whiteFrac * 100).toFixed(0)}% white - the page did not flatten`);
    else pass(`${(r.whiteFrac * 100).toFixed(0)}% white paper`);
    if (r.blackFrac < 0.02) fail("no ink survived the threshold");
    else pass(`${(r.blackFrac * 100).toFixed(0)}% ink`);

    if (r.fileName !== "IMG_0421-scan.jpg") fail(`named it ${r.fileName}`);
    else pass(`named ${r.fileName}`);
    // The storage claim: a scan should be a fraction of the phone photo it
    // replaces, because every one of these lands in a tenant's quota.
    if (r.fileKB > 900) fail(`${Math.round(r.fileKB)} KB is too big for a receipt`);
    else pass(`${Math.round(r.fileKB)} KB`);
  }
} catch (e) {
  fail(e.message);
} finally {
  await browser.close().catch(() => {});
  server.close();
}

console.log(process.exitCode ? "\nscanner check FAILED" : "\nscanner check passed");
