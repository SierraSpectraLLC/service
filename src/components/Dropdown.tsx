"use client";

import { useEffect, useRef } from "react";

/**
 * A menu built on native <details>, not on our own open/closed state.
 *
 * The previous version toggled a React boolean, painted a full-screen fixed
 * scrim to catch outside clicks, and relied on the scrim and the panel landing
 * on the right side of a z-index it didn't own. Every one of those is a way for
 * the menu to be dead on a browser we didn't test on: an unmounted handler, a
 * hydration hiccup, a stacking context introduced above it. <details> opens
 * with no JavaScript at all - the browser does it - so the menu cannot fail to
 * open, and it is keyboard- and screen-reader-native for free.
 *
 * JavaScript now only does the nicety: close when you click elsewhere or press
 * Escape. If that ever breaks, the menu is left open rather than unusable.
 */
export default function Dropdown({ label, align = "right", children }: {
  label: string;
  align?: "left" | "right";
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const close = (e: Event) => {
      if (!el.open) return;
      if (e.type === "pointerdown" && el.contains(e.target as Node)) return;
      el.open = false;
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(e); };
    // pointerdown, not click: a menu that closes on mouseup would swallow the
    // click that was meant for whatever is underneath it.
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <details className="menu" ref={ref}>
      <summary className="btn sm">{label} ▾</summary>
      <div className={`menu-panel${align === "left" ? " left" : ""}`}
        // Choosing something is the end of the interaction.
        onClick={() => { if (ref.current) ref.current.open = false; }}>
        {children}
      </div>
    </details>
  );
}
