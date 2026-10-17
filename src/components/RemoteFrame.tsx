"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The engine's desktop page, in a box that fits a phone.
 *
 * That page is built for a desk, not a pocket: its full-screen layout has a
 * 700px floor (`.fulldesk #container`, meshcentral 1.2.4 style.css) and its
 * dialogs are a fixed 400px centred with `left: calc(50% - 200px)`. In a 400px
 * phone frame the toolbar ran off the right edge and Remote Keyboard Entry -
 * the only way to type from a phone - opened half off the left, where no
 * amount of scrolling reaches. We can't change their page, and `mobile=0` has
 * to stay (see connectUrl), so instead the page gets the width it was made
 * for and the whole frame is scaled down to the box.
 *
 * The desktop itself loses nothing by this: the viewer fits it to the frame's
 * width either way. What changes is that every control around it is now on
 * screen, smaller but whole. At 700px and up the scale is 1 and this is a
 * plain iframe filling the box.
 *
 * Touch still lands where it looks like it does - a transform on the iframe
 * element is the parent's business, and the page inside reads its own
 * coordinates.
 */
const ENGINE_MIN_WIDTH = 700;

export default function RemoteFrame({ src, title }: { src: string; title: string }) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const obs = useRef<ResizeObserver | null>(null);

  useEffect(() => () => obs.current?.disconnect(), []);

  const measure = useCallback((el: HTMLDivElement | null) => {
    obs.current?.disconnect();
    obs.current = null;
    if (!el) return;
    // clientWidth/Height: inside the border, which is the room the frame has.
    const publish = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    publish();
    if (typeof ResizeObserver === "undefined") return;
    obs.current = new ResizeObserver(publish);
    obs.current.observe(el);
  }, []);

  // Before the first measurement (server render, first paint) the frame simply
  // fills the box, which is right on every screen wide enough not to need this.
  const scale = box && box.w > 0 ? Math.min(1, box.w / ENGINE_MIN_WIDTH) : 1;
  const sized = box && scale < 1
    ? { width: box.w / scale, height: box.h / scale, transform: `scale(${scale})`, transformOrigin: "0 0" }
    : { width: "100%", height: "100%" };

  return (
    <div
      ref={measure}
      // The viewer letterboxes the desktop inside whatever box it is given, so
      // the box wants to be as close to the far machine's own shape as the
      // window allows: the full width, and all the height left over once the
      // header and footer have taken theirs. Taken from the layout rather than
      // subtracted from 100vh, because the header wraps and any constant would
      // be wrong at some window width.
      style={{
        position: "relative", flex: "1 1 auto", minHeight: 420, overflow: "hidden",
        border: "1px solid var(--line)", borderRadius: 6, background: "var(--navy)",
      }}
    >
      <iframe
        src={src}
        title={title}
        // Full screen and clipboard are the two the desktop viewer actually
        // asks the browser for; without them a copy-paste into an instrument
        // dialog silently does nothing.
        allow="fullscreen; clipboard-read; clipboard-write"
        style={{ position: "absolute", top: 0, left: 0, display: "block", border: 0, ...sized }}
      />
    </div>
  );
}
