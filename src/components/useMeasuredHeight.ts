"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Publishes an element's measured height as a CSS custom property.
 *
 * Anything that scrolls to an anchor underneath a sticky bar needs to know how
 * tall that bar is, and the record pages used to answer with a hard-coded
 * `scrollMarginTop: 52`. That is the section bar's height on a wide screen with
 * few sections, and nothing else true: the bar is `flex-wrap: wrap`, so on a
 * 380px phone with six contexts it stands three rows tall - and every jump
 * landed with the heading it jumped to hidden behind the bar that sent it
 * there. Measuring costs one ResizeObserver and is right at every width.
 *
 * Returns a ref callback: hand it to the sticky element. It publishes on mount,
 * re-publishes on every resize, and clears the property when the element goes
 * away, so the `:root` fallback of 0px takes over the moment nothing is stuck
 * to the top of the page.
 *
 * The two layouts publish under different names on purpose. The band layout's
 * bar spans the content and everything below must clear it (`--head-h`); the
 * rail only covers the pane at phone widths, where it stacks above it rather
 * than beside it (`--rail-h`). Feeding the rail's height back into `--head-h`
 * would be a loop - the rail's own `top` is calculated from it.
 */
export function useMeasuredHeight<T extends HTMLElement>(
  cssVar: string,
): (el: T | null) => void {
  const obs = useRef<ResizeObserver | null>(null);

  const clear = useCallback(() => {
    obs.current?.disconnect();
    obs.current = null;
    document.documentElement.style.removeProperty(cssVar);
  }, [cssVar]);

  // A layout that unmounts its head - arrange mode drops the section bar, and
  // flipping to the other shape drops it for good - must not leave the last
  // measured height behind for whatever reads the property next.
  useEffect(() => () => clear(), [clear]);

  return useCallback((el: T | null) => {
    if (!el) {
      clear();
      return;
    }
    obs.current?.disconnect();
    // offsetHeight over the observer's reported box: it is the number the
    // element actually occupies, rounded the way the browser rounds it, and it
    // needs no feature-sniffing across borderBoxSize's two shapes.
    const publish = () =>
      document.documentElement.style.setProperty(cssVar, `${el.offsetHeight}px`);
    publish();
    // jsdom has no ResizeObserver. The measurement above still ran, so a test
    // environment gets a static value rather than a crash.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    obs.current = ro;
  }, [cssVar, clear]);
}
