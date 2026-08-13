"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  frameStyle, NO_FRAME, parseFrame, serializeFrame, turned, ZOOM_MAX, ZOOM_MIN, type Frame,
} from "@/lib/photoFrame";

/**
 * Put a photo straight in its tile.
 *
 * Phone photos of instruments arrive sideways, taken a step too far back, with
 * the module off to one side. The three controls here are the three fixes:
 * turn it a quarter, zoom in, drag it into the middle. Everything else a photo
 * editor offers would be a photo editor.
 *
 * Nothing is re-encoded. What is saved is four numbers describing how to show
 * the file, so the original stays exactly as uploaded - it is evidence, and
 * cropping evidence so a thumbnail looks tidy is not a trade worth making.
 * Re-framing tomorrow costs nothing and loses nothing.
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
          Drag to move it, turn it upright, zoom to the part that matters. The file itself is unchanged.
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
          <img src={src} alt={alt} draggable={false}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", ...frameStyle(frame, 4 / 3) }} />
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
          <button className="btn sm" onClick={() => setFrame((f) => turned(f))} disabled={pending}>Turn ¼</button>
          <label className="mut" style={{ fontSize: 12 }} htmlFor="photo-zoom">Zoom</label>
          <input id="photo-zoom" type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={0.05}
            value={frame.zoom} disabled={pending}
            onChange={(e) => setFrame((f) => ({ ...f, zoom: Number(e.target.value) }))}
            style={{ flex: "1 1 120px", minWidth: 100 }} />
          <button className="btn sm" onClick={() => setFrame(NO_FRAME)} disabled={pending}>Reset</button>
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
