"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DETECT_EDGE, canvasJpegBytes, canvasToFile, clampPoint, detectQuad, drawToCanvas,
  loadOpenCv, rotateQuarter, scaleQuad, warpToDocument, wholeFrame,
  type Point, type Quad, type ScanMode,
} from "@/lib/scanDoc";
import { pagesToPdf, scanPdfName } from "@/lib/scanPdf";
import { steadyLock } from "@/lib/scanLive";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";

/** What the live detector chews per frame. Smaller than a still's DETECT_EDGE:
 *  this runs seven times a second on a phone, and edges this size are plenty. */
const LIVE_EDGE = 480;

/**
 * The scan step, between taking the photo and attaching it - for one receipt
 * or a whole document.
 *
 * The single-page half is the old ReceiptScanner, unchanged in both the ways
 * that matter. Automatic corner detection is right most of the time and wrong
 * in exactly the situations paper gets photographed in - a pale slip on a pale
 * car seat, a page overlapping a laptop's edge, half in shadow - so the
 * corners it found are drawn on the photo with four handles to drag, and
 * silently cropping a $340 folio to two thirds of itself stays impossible.
 * And "Use the photo as it is" stays one tap, because attaching the untouched
 * photo is what this app did before any scanner existed and can never be the
 * wrong answer.
 *
 * The multi-page half is what a phone scanner taught everybody to expect:
 * keep tapping "+ Page", get ONE PDF. Each kept page shows as a thumbnail
 * that can be turned or removed; a single kept page still leaves as the same
 * JPEG it always did, so the receipt gesture - shoot, one tap, done - costs
 * nothing new.
 */
export default function DocScanner({ file, title = "Scan the document", onDone, onCancel }: {
  /** A photo to start from. Absent = open the LIVE viewfinder instead, with
      the phone's camera app as the fallback when getUserMedia will not play. */
  file?: File;
  title?: string;
  /** One file however many pages: the JPEG of a single page, a PDF of several,
      or the untouched photo if that is what they chose. */
  onDone: (result: File) => void;
  onCancel: () => void;
}) {
  const [stage, setStage] = useState<"loading" | "ready" | "failed" | "between" | "camera" | "fallback">(file ? "loading" : "camera");
  const [error, setError] = useState("");
  const [mode, setMode] = useState<ScanMode>("document");
  const [quad, setQuad] = useState<Quad | null>(null);
  const [found, setFound] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Pages already kept, oldest first. The canvas is a private copy. */
  const [pages, setPages] = useState<{ key: number; name: string; canvas: HTMLCanvasElement; thumb: string }[]>([]);
  const nextKey = useRef(1);

  /* Three images per page being edited, and it is worth being clear which is
     which:
     - full:    the photo at its own resolution. The warp reads from this.
     - preview: a screen-sized copy - what the handles are drawn over and what
                detection ran on.
     - out:     the flattened result. */
  const full = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<HTMLCanvasElement | null>(null);
  const outRef = useRef<HTMLCanvasElement | null>(null);
  const cvRef = useRef<Record<string, unknown> | null>(null);
  const scaleRef = useRef(1);
  const dragging = useRef<number | null>(null);
  const moreRef = useRef<HTMLInputElement | null>(null);
  /** The photo the editor holds - the source of "Use the photo as it is". */
  const editingFile = useRef<File | null>(file ?? null);

  /* The live viewfinder. A session that STARTED live goes back to the
     viewfinder for each next page; one that started from a photo keeps using
     the camera app. The stream and the detection loop live in refs because
     they are machinery, not render state - only the lock is worth a render. */
  const liveMode = useRef(!file);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef(0);
  const lastDetect = useRef(0);
  const historyRef = useRef<(Quad | null)[]>([]);
  const [locked, setLocked] = useState(false);
  /** "" = the camera has no light to offer; otherwise the toggle's state. */
  const [torch, setTorch] = useState<"" | "off" | "on">("");

  // ── Load, decode, detect - for the first photo and every added one ──────
  const begin = useCallback((photo: File) => {
    let dead = false;
    setStage("loading");
    editingFile.current = photo;
    (async () => {
      try {
        const [box, big, small] = await Promise.all([
          loadOpenCv(),
          drawToCanvas(photo, 4000),
          drawToCanvas(photo, DETECT_EDGE),
        ]);
        if (dead) return;
        // Unwrapped only here, on the far side of every promise. See CvBox.
        const cv = box.cv;
        cvRef.current = cv;
        full.current = big.canvas;
        previewRef.current = small.canvas;
        // The preview and the full image are the same picture at two scales,
        // so a corner found on one maps onto the other by a single factor.
        scaleRef.current = big.canvas.width / small.canvas.width;

        const hit = detectQuad(cv, small.canvas);
        setFound(hit !== null);
        setQuad(hit ?? inset(small.canvas.width, small.canvas.height));
        setStage("ready");
      } catch (e) {
        if (dead) return;
        setError((e as Error).message);
        setStage("failed");
      }
    })();
    return () => { dead = true; };
  }, []);

  // ── The live viewfinder ─────────────────────────────────────────────────

  /**
   * Which camera start is the CURRENT one. Starting is several awaits long,
   * and a second start can begin before the first finishes - StrictMode's
   * double mount does it on every dev load, and a fast "+ Page" after a
   * fallback can do it in the field. Without this, the late continuation of a
   * superseded start plays into the same <video> and both die of AbortError -
   * which then reads as "no camera" and drops a working phone to the fallback.
   */
  const camSession = useRef(0);

  const stopCamera = useCallback(() => {
    camSession.current++;
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setTorch("");
    setLocked(false);
  }, []);

  /**
   * Detection over the video, a few times a second, drawn straight onto the
   * overlay. Every frame is judged alone; the LOCK (lib/scanLive) is the
   * calmer second signal - the same quad several frames running - that turns
   * the outline green and says the shot is worth taking. rAF-driven but gated
   * to ~7 Hz: edge detection does not get better at 60 fps, phones just get
   * hot, and the video underneath stays smooth either way.
   */
  const loop = useCallback(() => {
    rafRef.current = requestAnimationFrame(loop);
    const video = videoRef.current;
    const overlay = overlayRef.current;
    const cv = cvRef.current;
    if (!video || !overlay || !cv || video.readyState < 2 || !video.videoWidth) return;
    const now = performance.now();
    if (now - lastDetect.current < 140) return;
    lastDetect.current = now;

    const scale = LIVE_EDGE / Math.max(video.videoWidth, video.videoHeight);
    const w = Math.max(1, Math.round(video.videoWidth * scale));
    const h = Math.max(1, Math.round(video.videoHeight * scale));
    const det = (detRef.current ??= document.createElement("canvas"));
    det.width = w; det.height = h;
    det.getContext("2d")?.drawImage(video, 0, 0, w, h);

    let hit: Quad | null = null;
    try { hit = detectQuad(cv, det); } catch { hit = null; }
    historyRef.current = [...historyRef.current.slice(-7), hit];
    const lock = steadyLock(historyRef.current, w, h);
    setLocked(lock !== null);

    // The overlay shares the detection frame's coordinates and is stretched
    // over the video by CSS, so the quad draws with no mapping at all.
    overlay.width = w; overlay.height = h;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    if (hit) {
      // Token-true color without a stylesheet: the canvas reads the same
      // custom property every good-tone pill uses. Blue is the editor's own.
      const good = getComputedStyle(document.documentElement).getPropertyValue("--t-good-fg").trim();
      ctx.strokeStyle = lock ? (good || "#3B82F6") : "#3B82F6";
      ctx.lineWidth = lock ? 4 : 2.5;
      ctx.beginPath();
      ctx.moveTo(hit[0].x, hit[0].y);
      for (const p of hit.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.stroke();
    }
  }, []);

  const startCamera = useCallback(async () => {
    const my = ++camSession.current;
    setStage("camera");
    setError("");
    historyRef.current = [];
    setLocked(false);
    try {
      const boxP = loadOpenCv();
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("no camera API here");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 2560 }, height: { ideal: 1440 } },
        audio: false,
      });
      const video = videoRef.current;
      if (my !== camSession.current || !video) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;
      // Imperatively, not (only) as JSX props: React does not reliably render
      // the muted attribute, and an unmuted video will not autoplay - play()
      // rejects and the whole viewfinder "fails" into the fallback for no
      // reason a person can see.
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      if (my !== camSession.current) return;
      // A light, where the hardware has one - a receipt in a dim van again.
      const caps = stream.getVideoTracks()[0]?.getCapabilities?.() as { torch?: boolean } | undefined;
      setTorch(caps?.torch ? "off" : "");
      cvRef.current = (await boxP).cv;
      if (my !== camSession.current) return;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(loop);
    } catch (e) {
      // A superseded start is not a failure - its replacement is running.
      if (my !== camSession.current) return;
      /* Denied, absent, or insecure context - all the same answer: the
         phone's own camera app, which needs no permission from us. The
         console keeps the real reason for whoever has to ask why. */
      console.warn("Live viewfinder unavailable, falling back to the camera app:", e);
      stopCamera();
      // And stay fallen: a camera that refused once will refuse the next page
      // too, and re-failing through it on every "+ Page" is a second's stall
      // apiece for nothing.
      liveMode.current = false;
      setStage("fallback");
    }
  }, [loop, stopCamera]);

  /** The shutter: the frame as the camera sees it, into the editor. */
  const shutter = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const frame = document.createElement("canvas");
    frame.width = video.videoWidth;
    frame.height = video.videoHeight;
    frame.getContext("2d")?.drawImage(video, 0, 0);
    stopCamera();
    const blob = await new Promise<Blob>((resolve, reject) =>
      frame.toBlob((b) => b ? resolve(b) : reject(new Error("The frame could not be captured")), "image/jpeg", 0.92));
    begin(new File([blob], `doc-${new Date().toISOString().slice(0, 10)}.jpg`, { type: "image/jpeg" }));
  };

  const flipTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const on = torch !== "on";
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      setTorch(on ? "on" : "off");
    } catch { /* the toggle just does nothing - not worth an error */ }
  };

  useEffect(() => {
    if (file) return begin(file);
    void startCamera();
  }, [file, begin, startCamera]);

  // However the dialog closes, the camera light goes off.
  useEffect(() => stopCamera, [stopCamera]);

  /* Not the whole frame: corners sitting exactly on the edge of the picture
     are impossible to grab on a phone, and a scan of the entire photograph is
     not a scan. An inset rectangle is a visible, draggable starting point that
     says "I could not find it - show me". */
  const inset = (w: number, h: number): Quad => {
    const q = wholeFrame(w, h);
    const dx = w * 0.08, dy = h * 0.08;
    return [
      { x: q[0].x + dx, y: q[0].y + dy }, { x: q[1].x - dx, y: q[1].y + dy },
      { x: q[2].x - dx, y: q[2].y - dy }, { x: q[3].x + dx, y: q[3].y - dy },
    ];
  };

  // ── Redraw: the photo, the outline, the handles ─────────────────────────
  const paint = useCallback(() => {
    const view = viewRef.current;
    const preview = previewRef.current;
    if (!view || !preview || !quad) return;
    view.width = preview.width;
    view.height = preview.height;
    const ctx = view.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(preview, 0, 0);

    // Everything outside the quad dimmed, so the crop reads at a glance.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, view.width, view.height);
    ctx.moveTo(quad[0].x, quad[0].y);
    for (const p of quad.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.closePath();
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fill("evenodd");
    ctx.restore();

    ctx.strokeStyle = "#3B82F6";
    ctx.lineWidth = Math.max(2, view.width / 300);
    ctx.beginPath();
    ctx.moveTo(quad[0].x, quad[0].y);
    for (const p of quad.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.closePath();
    ctx.stroke();

    const r = Math.max(9, view.width / 45);
    for (const p of quad) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.stroke();
    }
  }, [quad]);

  // ── Re-warp whenever the corners or the mode change ─────────────────────
  useEffect(() => {
    paint();
    const cv = cvRef.current;
    const big = full.current;
    const out = outRef.current;
    if (!cv || !big || !out || !quad || stage !== "ready") return;
    try {
      warpToDocument(cv, big, scaleQuad(quad, scaleRef.current), mode, out);
      setError("");
    } catch (e) {
      setError(`That outline could not be flattened: ${(e as Error).message}`);
    }
  }, [quad, mode, paint, stage]);

  // ── Dragging a corner ───────────────────────────────────────────────────
  /** Pointer events, so one code path covers finger, stylus and mouse. */
  const at = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const box = e.currentTarget.getBoundingClientRect();
    return {
      x: (e.clientX - box.left) * (e.currentTarget.width / box.width),
      y: (e.clientY - box.top) * (e.currentTarget.height / box.height),
    };
  };

  const grab = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!quad) return;
    const p = at(e);
    let near = 0;
    let best = Infinity;
    quad.forEach((c, i) => {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < best) { best = d; near = i; }
    });
    // A generous radius: this is a fingertip on a phone, not a mouse.
    if (best > e.currentTarget.width / 8) return;
    dragging.current = near;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const i = dragging.current;
    if (i === null || !quad) return;
    const p = clampPoint(at(e), e.currentTarget.width, e.currentTarget.height);
    const next = [...quad] as Quad;
    next[i] = p;
    setQuad(next);
  };

  const drop = () => { dragging.current = null; };

  // ── Keeping pages ───────────────────────────────────────────────────────

  /** A page's own copy of a canvas - outRef is reused by the next page. */
  const keepCanvas = (src: HTMLCanvasElement, cap = Infinity): HTMLCanvasElement => {
    const scale = Math.min(1, cap / Math.max(src.width, src.height));
    const copy = document.createElement("canvas");
    copy.width = Math.max(1, Math.round(src.width * scale));
    copy.height = Math.max(1, Math.round(src.height * scale));
    copy.getContext("2d")?.drawImage(src, 0, 0, copy.width, copy.height);
    return copy;
  };

  const thumbOf = (c: HTMLCanvasElement) => keepCanvas(c, 160).toDataURL("image/jpeg", 0.7);

  /** Keep the scan the editor holds as a page, and clear the bench. */
  const keepPage = (): boolean => {
    const src = outRef.current;
    if (!src) return false;
    const canvas = keepCanvas(src);
    setPages((p) => [...p, {
      key: nextKey.current++, name: editingFile.current?.name ?? "doc", canvas, thumb: thumbOf(canvas),
    }]);
    setStage("between");
    setQuad(null);
    full.current = null;
    previewRef.current = null;
    return true;
  };

  const turnPage = (key: number) =>
    setPages((p) => p.map((pg) => {
      if (pg.key !== key) return pg;
      const canvas = rotateQuarter(pg.canvas);
      return { ...pg, canvas, thumb: thumbOf(canvas) };
    }));

  const dropPage = (key: number) => setPages((p) => p.filter((pg) => pg.key !== key));

  // ── Leaving ─────────────────────────────────────────────────────────────
  // One file out, however it went. A single scanned page leaves as the JPEG it
  // always did; several leave bound as one PDF (lib/scanPdf), because five
  // loose page files are not a document anybody forwards.

  /** Bind and deliver a list of pages (the strip's, plus maybe the editor's). */
  const deliver = async (list: { name: string; canvas: HTMLCanvasElement }[]) => {
    setBusy(true);
    try {
      if (list.length === 1) {
        onDone(await canvasToFile(list[0].canvas, list[0].name));
        return;
      }
      const jpegs = [];
      for (const p of list) jpegs.push({ bytes: await canvasJpegBytes(p.canvas) });
      const name = scanPdfName(list[0].name);
      const pdf = await pagesToPdf(jpegs, name.replace(/\.pdf$/, ""));
      const bytes = new Uint8Array(pdf);
      onDone(new File([bytes], name, { type: "application/pdf" }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  /** Keep the page on screen and immediately deliver everything. */
  const keepAndDeliver = () => {
    const src = outRef.current;
    if (!src) return;
    void deliver([...pages, { name: editingFile.current?.name ?? "doc", canvas: keepCanvas(src) }]);
  };

  /** However this session takes its pictures, the next page comes the same way. */
  const nextPage = () => {
    if (liveMode.current) void startCamera();
    else moreRef.current?.click();
  };

  const addAnother = () => {
    if (keepPage()) nextPage();
  };

  const n = pages.length;

  return (
    <Dialog open onClose={onCancel} size="md" title={title}
      context={stage === "loading" ? "Starting the scanner..."
        : stage === "failed" ? "The scanner did not start"
        : stage === "camera" ? (locked ? "Steady - take the shot" : "Point the camera at the paper")
        : stage === "fallback" ? "Using the phone's own camera"
        : stage === "between" ? `${n} page${n === 1 ? "" : "s"} so far - add the next, or finish`
        : found ? "Drag a corner if it got the edges wrong"
        : "Could not find the edges - drag the corners onto them"}
      footer={
        <>
          <DialogStatus error={error} />
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          {stage === "camera" && (
            <>
              {torch !== "" && (
                <button className="btn" onClick={() => void flipTorch()} disabled={busy}>
                  {torch === "on" ? "Light off" : "Light"}
                </button>
              )}
              <button className="btn" onClick={() => { stopCamera(); setStage("fallback"); }} disabled={busy}>
                Use a photo
              </button>
              <button className="btn accent" onClick={() => void shutter()} disabled={busy}>
                Capture
              </button>
            </>
          )}
          {stage === "fallback" && (
            <button className="btn accent" onClick={() => moreRef.current?.click()} disabled={busy}>
              Take or pick a photo
            </button>
          )}
          {stage === "failed" && editingFile.current && (
            // The escape hatch when the scanner itself is what failed:
            // attaching the untouched photo can never be the wrong answer.
            <button className="btn" onClick={() => onDone(editingFile.current!)} disabled={busy}>
              Use the photo as it is
            </button>
          )}
          {stage === "ready" && (
            <>
              {n === 0 && editingFile.current && (
                <button className="btn" onClick={() => onDone(editingFile.current!)} disabled={busy}>
                  Use the photo as it is
                </button>
              )}
              <button className="btn" onClick={addAnother} disabled={busy || !quad}
                title="Keep this page and photograph the next one">
                + Page
              </button>
              <button className="btn accent" onClick={keepAndDeliver} disabled={busy || !quad}>
                {busy ? "Saving..." : n === 0 ? "Use the scan" : `Finish - ${n + 1} pages as one PDF`}
              </button>
            </>
          )}
          {stage === "between" && (
            <>
              <button className="btn" onClick={nextPage} disabled={busy}>
                + Page
              </button>
              <button className="btn accent" disabled={busy || n === 0}
                onClick={() => void deliver(pages)}>
                {busy ? "Saving..."
                  : n === 1 ? "Use the scan"
                  : `Finish - ${n} pages as one PDF`}
              </button>
            </>
          )}
        </>
      }>

      {/* The camera-app path: the next page for photo-started sessions, and
          the fallback whenever the live viewfinder cannot run - denied
          permission, no camera, an insecure context. capture="environment"
          opens the phone's own camera app, which needs no permission from us
          and has the focus and steadying built in. */}
      <input ref={moreRef} type="file" accept="image/*" capture="environment"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          e.target.value = "";
          if (f) begin(f);
        }} />

      {/* The pages already in hand - the strip is the document being built. */}
      {n > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          {pages.map((p, i) => (
            <div key={p.key} style={{ width: 72 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.thumb} alt={`Page ${i + 1}`}
                style={{ width: 72, height: 96, objectFit: "contain", border: "1px solid var(--line)", borderRadius: 6, background: "#fff", display: "block" }} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                <span className="mut t-meta">{i + 1}</span>
                <span style={{ display: "flex", gap: 6 }}>
                  <button type="button" className="btn link t-meta" style={{ padding: 0 }} disabled={busy}
                    aria-label={`Turn page ${i + 1}`} title="Turn a quarter clockwise"
                    onClick={() => turnPage(p.key)}>⟳</button>
                  <button type="button" className="btn link t-meta" style={{ padding: 0, color: "var(--t-bad-fg)" }} disabled={busy}
                    aria-label={`Remove page ${i + 1}`}
                    onClick={() => dropPage(p.key)}>×</button>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* The viewfinder. The video element stays mounted whatever the stage,
          because startCamera needs somewhere to put the stream before React
          has re-rendered; CSS decides whether anybody sees it. The overlay
          shares the detection frame's coordinate space and is stretched over
          the video by CSS, so the quad draws with no mapping at all. */}
      <div style={{ display: stage === "camera" ? "block" : "none" }}>
        <div style={{ position: "relative" }}>
          <video ref={videoRef} muted playsInline autoPlay
            aria-label="The camera, looking for the paper"
            style={{ width: "100%", display: "block", borderRadius: 8, background: "#000" }} />
          <canvas ref={overlayRef} aria-hidden
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />
        </div>
        <div className="mut t-meta" style={{ marginTop: 6 }}>
          {locked
            ? "Got it - hold steady and tap Capture. The corners can still be adjusted after."
            : "Fill the frame with the page. The outline settles when the camera has it."}
        </div>
      </div>

      {stage === "fallback" && (
        <div className="t-small" style={{ padding: "12px 0" }}>
          The live viewfinder could not start here, which is usually a camera
          permission. The phone&apos;s own camera app does the job just as well -
          take the photo there and it comes straight back to this screen for
          cropping and cleanup.
        </div>
      )}

      {stage === "loading" && (
        <div className="mut t-small" style={{ padding: "24px 0", textAlign: "center" }}>
          Downloading the scanner - a few seconds the first time, then it is cached.
        </div>
      )}

      {stage === "failed" && (
        <div className="t-small" style={{ padding: "12px 0" }}>
          {error} You can still attach the photo as it is - it is perfectly
          readable either way, it just will not be cropped and flattened.
        </div>
      )}

      {stage === "between" && n === 0 && (
        <div className="mut t-small" style={{ padding: "12px 0" }}>
          No pages kept yet - add one, or cancel.
        </div>
      )}

      <div style={{ display: stage === "ready" ? "block" : "none" }}>
        <div className="eyebrow">The photo</div>
        <canvas ref={viewRef} aria-label="The photo, with the paper's corners marked"
          onPointerDown={grab} onPointerMove={move} onPointerUp={drop} onPointerCancel={drop}
          style={{
            width: "100%", height: "auto", borderRadius: 8, border: "1px solid var(--line)",
            // Or the browser pans the dialog instead of moving the corner.
            touchAction: "none", cursor: "grab", display: "block",
          }} />

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "10px 0 6px" }}>
          <span className="eyebrow" style={{ margin: 0 }}>The scan</span>
          <span className="sp" style={{ flex: 1 }} />
          {/* Document by default - that is what "scan it" means, and thermal
              paper in a dim van is exactly what adaptive thresholding is for.
              Color is one tap away for a card slip with a signature on it. */}
          <div style={{ display: "flex", gap: 4 }}>
            <button className={`btn sm${mode === "document" ? " accent" : ""}`}
              onClick={() => setMode("document")} disabled={busy}>Document</button>
            <button className={`btn sm${mode === "photo" ? " accent" : ""}`}
              onClick={() => setMode("photo")} disabled={busy}>Color</button>
          </div>
        </div>
        <canvas ref={outRef} aria-label="The flattened scan"
          style={{
            width: "100%", height: "auto", borderRadius: 8,
            border: "1px solid var(--line)", background: "#fff", display: "block",
          }} />
        {n === 0 && (
          <div className="mut t-meta" style={{ marginTop: 6 }}>
            A multi-page document? &quot;+ Page&quot; keeps this one and opens the camera
            for the next; the pages leave here as one PDF.
          </div>
        )}
      </div>
    </Dialog>
  );
}
