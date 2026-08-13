"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  coverZoom, frameStyle, NO_FRAME, parseFrame, serializeFrame, turned, ZOOM_MAX, ZOOM_MIN, type Frame,
} from "@/lib/photoFrame";

/** The preview, and every tile a framed photo lands in, are this shape. */
const BOX_ASPECT = 4 / 3;

/**
 * Put a photo straight in its tile.
 *
 * Phone photos of instruments arrive sideways, taken a step too far back, with
 * the module off to one side. The three controls here are the three fixes:
 * turn it a quarter, zoom in, drag it into the middle. Everything else a photo
 * editor offers would be a photo editor.
 *
 * Nothing is re-encoded. What is saved is a handful of numbers describing how to
 * show the file, so the original stays exactly as uploaded - it is evidence, and
 * cropping evidence so a thumbnail looks tidy is not a trade worth making.
 * Re-framing tomorrow costs nothing and loses nothing.
 *
 * The whole photograph is on screen here, which is the point: the first version
 * showed the tile's crop of it, so the parts already cut off could not be
 * dragged back into view. Opening a photo that has never been framed starts at
 * the zoom that fills the tile - what it already looked like - so the editor
 * opens on what somebody expects and zooming OUT is how they find the rest.
 */
export default function PhotoFramer({ src, framing, alt, save, onDone }: {
  /** The photo to frame - a file or a catalog stock photo. See lib/photos. */
  src: string;
  framing: string;
  alt: string;
  /** Where the four numbers go. Differs for a file and a catalog row. */
  save: (framing: string) => Promise<{ error?: string } | void>;
  onDone: () => void;
}) {
  const [frame, setFrame] = useState<Frame>(() => parseFrame(framing));
  const [error, setError] = useState("");
  // The photo's own shape, known only once the browser has loaded it. Until
  // then the preview renders the stored frame as the tiles do.
  const [aspect, setAspect] = useState(() => parseFrame(framing).aspect);
  const [pending, startTransition] = useTransition();
  const box = useRef<HTMLDivElement>(null);
  // Where the pointer went down and what the frame was then, so a drag is
  // measured from its own start rather than accumulating rounding as it goes.
  const drag = useRef<{ x: number; y: number; from: Frame } | null>(null);

  // Esc closes, as it does everywhere else a panel covers the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDone(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  /**
   * The shape of the photograph, straight off the loaded image.
   *
   * A photo arriving without a recorded shape - never framed, or framed before
   * this was stored - is adopted at the zoom that fills the tile, so the editor
   * opens showing what the tile already showed. Anything already framed keeps
   * its numbers exactly.
   */
  const onImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (!img.naturalWidth || !img.naturalHeight) return;
    const a = img.naturalWidth / img.naturalHeight;
    setAspect(a);
    setFrame((f) => (f.aspect > 0 ? f : { ...f, aspect: a, zoom: coverZoom(a, BOX_ASPECT, f.rotate) }));
  };

  const fillTile = () =>
    setFrame((f) => ({ ...f, aspect: aspect || f.aspect, zoom: coverZoom(aspect, BOX_ASPECT, f.rotate) }));

  const move = (e: React.PointerEvent) => {
    if (!drag.current || !box.current) return;
    const w = box.current.clientWidth || 1;
    const h = box.current.clientHeight || 1;
    // Pan is stored as a percentage of the tile, so a drag reads the same on a
    // phone-sized preview as on a desktop one.
    setFrame((f) => ({
      ...f,
      x: drag.current!.from.x + ((e.clientX - drag.current!.x) / w) * 100,
      y: drag.current!.from.y + ((e.clientY - drag.current!.y) / h) * 100,
    }));
  };

  const commit = () => {
    setError("");
    startTransition(async () => {
      const res = await save(serializeFrame(frame));
      if (res?.error) { setError(res.error); return; }
      onDone();
    });
  };

  return (
    <div role="dialog" aria-label={`Frame ${alt}`}
      style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(15,23,42,.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
      onClick={(e) => { if (e.target === e.currentTarget) onDone(); }}>
      <div className="card" style={{ maxWidth: 420, width: "100%", margin: 0 }}>
        <div className="card-title" style={{ marginBottom: 6 }}>Frame this photo</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 8 }}>
          Drag to move it, turn it upright, zoom in or out. Zoom out past the edges to see the whole
          photo. The file itself is unchanged.
        </div>

        <div ref={box}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, from: frame };
          }}
          onPointerMove={move}
          onPointerUp={() => { drag.current = null; setFrame((f) => parseFrame(serializeFrame(f))); }}
          onPointerCancel={() => { drag.current = null; }}
          style={{
            width: "100%", aspectRatio: "4 / 3", overflow: "hidden", borderRadius: 10,
            border: "1px solid var(--line)", background: "#0F172A", touchAction: "none",
            cursor: drag.current ? "grabbing" : "grab",
          }}>
          {/* No objectFit of its own: the frame decides, and the preview has to
              be the same rendering the tile will use or this editor is lying. */}
          <img src={src} alt={alt} draggable={false} onLoad={onImageLoad}
            style={{ width: "100%", height: "100%", display: "block", ...frameStyle(frame, 4 / 3) }} />
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
          <button className="btn sm" onClick={() => setFrame((f) => turned(f))} disabled={pending}>Turn ¼</button>
          <button className="btn sm" onClick={fillTile} disabled={pending || !aspect}>Fill tile</button>
          <label className="mut" style={{ fontSize: 12 }} htmlFor="photo-zoom">Zoom</label>
          <input id="photo-zoom" type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={0.01}
            value={frame.zoom} disabled={pending}
            onChange={(e) => setFrame((f) => ({ ...f, zoom: Number(e.target.value) }))}
            style={{ flex: "1 1 120px", minWidth: 100 }} />
          <button className="btn sm" disabled={pending}
            onClick={() => setFrame({ ...NO_FRAME, aspect, zoom: coverZoom(aspect, BOX_ASPECT) })}>Reset</button>
        </div>

        {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}

        <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
          <button className="btn sm" onClick={onDone} disabled={pending}>Cancel</button>
          <button className="btn sm primary" onClick={commit} disabled={pending}>
            {pending ? "Saving..." : "Save framing"}
          </button>
        </div>
      </div>
    </div>
  );
}
