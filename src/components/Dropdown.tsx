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
export default function Dropdown({ label, align = "right", ariaLabel, summaryClass, children }: {
  /** Text, or a node when the trigger is an icon or an avatar. */
  label: React.ReactNode;
  align?: "left" | "right";
  /** Required when `label` isn't words - a summary reading "JH" says nothing. */
  ariaLabel?: string;
  /** Override the trigger's look - the header nav uses `nav-link` here. */
  summaryClass?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * Keep the open panel on the screen.
   *
   * The panel is anchored to its trigger (right edge by default), which is
   * right on a desktop and wrong on a phone: a trigger near the left edge threw
   * a 190px panel 73px off the side of the screen, and the menu simply could
   * not be read. CSS cannot know where the trigger sits in the viewport, so
   * this measures on open and nudges the panel back inside.
   *
   * Positioning only - if it never runs, the menu still opens exactly as the
   * browser would place it, which is the same posture as the close-on-outside
   * handler below.
   */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clamp = () => {
      const panel = panelRef.current;
      if (!panel || !el.open) return;
      // Back to the CSS anchor first, so re-opening never compounds a nudge.
      panel.style.left = "";
      panel.style.right = "";
      const pad = 8;
      const vw = document.documentElement.clientWidth;
      const box = panel.getBoundingClientRect();
      const anchor = el.getBoundingClientRect();
      if (box.left < pad) {
        panel.style.right = "auto";
        panel.style.left = `${pad - anchor.left}px`;
      } else if (box.right > vw - pad) {
        panel.style.left = "auto";
        panel.style.right = `${anchor.right - (vw - pad)}px`;
      }
    };
    el.addEventListener("toggle", clamp);
    window.addEventListener("resize", clamp);
    return () => {
      el.removeEventListener("toggle", clamp);
      window.removeEventListener("resize", clamp);
    };
  }, []);

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
      <summary className={summaryClass ?? (typeof label === "string" ? "btn sm" : "nav-ico")} aria-label={ariaLabel}>
        {label}{typeof label === "string" ? " ▾" : null}
      </summary>
      <div ref={panelRef} className={`menu-panel${align === "left" ? " left" : ""}`}
        // Choosing something is the end of the interaction.
        onClick={() => { if (ref.current) ref.current.open = false; }}>
        {children}
      </div>
    </details>
  );
}
