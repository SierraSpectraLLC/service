"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DETECT_EDGE, canvasToFile, clampPoint, detectQuad, drawToCanvas, loadOpenCv, scaleQuad,
  warpToDocument, wholeFrame, type Point, type Quad, type ScanMode,
} from "@/lib/scanDoc";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";

/**
 * The scan step, between taking the photo and attaching it.
 *
 * The whole reason this is a step and not an invisible transform: automatic
 * corner detection is right most of the time and wrong in exactly the
 * situations a receipt gets photographed in - a pale slip on a pale car seat,
 * a receipt overlapping the edge of a laptop, a night shot with the paper half
 * in shadow. Silently cropping a $340 hotel folio to two thirds of itself is
 * worse than not scanning at all, because nobody looks again until somebody
 * asks about the difference six weeks later.
 *
 * So: the photo, the corners it found drawn on it, four handles to drag when
 * it got them wrong, the result underneath, and a way out. The way out matters
 * as much as the scan - "Use the photo as it is" is one tap, and it is the
 * behaviour this app had before any of this existed.
 */
export default function ReceiptScanner({ file, onDone, onCancel }: {
  /** The photo as the camera returned it. */
  file: File;
  /** The scan to attach - or the original, if that is what they chose. */
  onDone: (result: File) => void;
  onCancel: () => void;
}) {
  const [stage, setStage] = useState<"loading" | "ready" | "failed">("loading");
  const [error, setError] = useState("");
  const [mode, setMode] = useState<ScanMode>("document");
  const [quad, setQuad] = useState<Quad | null>(null);
  const [found, setFound] = useState(false);
  const [busy, setBusy] = useState(false);

  /* Three images, and it is worth being clear which is which:
     - full:    the photo at its own resolution. The warp reads from this, so
                no detail is lost to the preview's convenience.
     - preview: a screen-sized copy. What the corner handles are drawn over,
                and what detection ran on.
     - out:     the result canvas. */
  const full = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<HTMLCanvasElement | null>(null);
  const outRef = useRef<HTMLCanvasElement | null>(null);
  const cvRef = useRef<Record<string, unknown> | null>(null);
  const scaleRef = useRef(1);
  const dragging = useRef<number | null>(null);

  // ── Load, decode, detect ────────────────────────────────────────────────
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const [box, big, small] = await Promise.all([
          loadOpenCv(),
          drawToCanvas(file, 4000),
          drawToCanvas(file, DETECT_EDGE),
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
  }, [file]);

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
    if (!cv || !big || !out || !quad) return;
    try {
      warpToDocument(cv, big, scaleQuad(quad, scaleRef.current), mode, out);
      setError("");
    } catch (e) {
      setError(`That outline could not be flattened: ${(e as Error).message}`);
    }
  }, [quad, mode, paint]);

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

  const useScan = async () => {
    const out = outRef.current;
    if (!out) return;
    setBusy(true);
    try {
      onDone(await canvasToFile(out, file.name));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onCancel} size="md" title="Scan the receipt"
      context={stage === "loading" ? "Starting the scanner..."
        : stage === "failed" ? "The scanner did not start"
        : found ? "Drag a corner if it got the edges wrong"
        : "Could not find the edges - drag the corners onto them"}
      footer={
        <>
          <DialogStatus error={error} />
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          {/* The escape hatch, always available and never buried. Attaching
              the photo untouched is exactly what this app did before the
              scanner existed, so it can never be the wrong answer. */}
          <button className="btn" onClick={() => onDone(file)} disabled={busy}>
            Use the photo as it is
          </button>
          {stage === "ready" && (
            <button className="btn accent" onClick={useScan} disabled={busy || !quad}>
              {busy ? "Saving..." : "Use the scan"}
            </button>
          )}
        </>
      }>
      {stage === "loading" && (
        <div className="mut t-small" style={{ padding: "24px 0", textAlign: "center" }}>
          Downloading the scanner - a few seconds the first time, then it is cached.
        </div>
      )}

      {stage === "failed" && (
        <div className="t-small" style={{ padding: "12px 0" }}>
          {error} You can still attach the photo as it is - the receipt is perfectly
          readable either way, it just will not be cropped and flattened.
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
      </div>
    </Dialog>
  );
}
