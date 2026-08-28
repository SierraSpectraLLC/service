// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { useMeasuredHeight } from "@/components/useMeasuredHeight";

/**
 * The sticky head publishes its height instead of the page assuming it.
 *
 * The bug this replaces was silent: `scrollMarginTop: 52` looked right on a
 * laptop and put every jumped-to heading behind the bar on a phone, because
 * the bar wraps. A hard-coded number cannot be caught by a type checker, so
 * it is caught here - both that the measurement runs and that neither layout
 * has quietly grown another one.
 */

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("--head-h");
});

const Head = ({ show = true, cssVar = "--head-h" }: { show?: boolean; cssVar?: string }) => {
  const ref = useMeasuredHeight<HTMLDivElement>(cssVar);
  return show ? <div ref={ref} data-testid="head" /> : null;
};

/** jsdom reports 0 for every box, so the height under test has to be faked. */
const withHeight = (px: number) =>
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(px);

describe("useMeasuredHeight", () => {
  it("publishes the element's height on mount", () => {
    withHeight(74);
    render(<Head />);
    expect(document.documentElement.style.getPropertyValue("--head-h")).toBe("74px");
  });

  it("clears the property when the element goes away", () => {
    withHeight(74);
    const { rerender } = render(<Head />);
    expect(document.documentElement.style.getPropertyValue("--head-h")).toBe("74px");
    // Arrange mode drops the section bar; flipping to the rail drops it for
    // good. Either way the next reader must get the :root fallback, not the
    // height of a bar that is no longer on the page.
    rerender(<Head show={false} />);
    expect(document.documentElement.style.getPropertyValue("--head-h")).toBe("");
  });

  it("clears the property on unmount", () => {
    withHeight(74);
    const { unmount } = render(<Head />);
    unmount();
    expect(document.documentElement.style.getPropertyValue("--head-h")).toBe("");
  });

  it("writes whichever property it was given", () => {
    withHeight(49);
    render(<Head cssVar="--rail-h" />);
    expect(document.documentElement.style.getPropertyValue("--rail-h")).toBe("49px");
    document.documentElement.style.removeProperty("--rail-h");
  });

  it("survives an environment with no ResizeObserver", () => {
    withHeight(74);
    const had = globalThis.ResizeObserver;
    // @ts-expect-error - deleting a global that older Safari genuinely lacks.
    delete globalThis.ResizeObserver;
    expect(() => render(<Head />)).not.toThrow();
    expect(document.documentElement.style.getPropertyValue("--head-h")).toBe("74px");
    globalThis.ResizeObserver = had;
  });
});

describe("no layout hard-codes the head's height", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("the band layout measures its section bar", () => {
    const src = read("src/components/BandLayout.tsx");
    expect(src).toMatch(/useMeasuredHeight<HTMLElement>\("--head-h"\)/);
    expect(src).toMatch(/className="section-bar"[^>]*ref=\{headRef\}/);
  });

  it("the rail measures itself", () => {
    const src = read("src/components/RailLayout.tsx");
    expect(src).toMatch(/useMeasuredHeight<HTMLElement>\("--rail-h"\)/);
    // The measured-height callback now rides a composed ref (the nav also
    // needs an element handle for scroll-into-view), so pin the composition:
    // the nav takes setRail, and setRail hands the element to railRef.
    expect(src).toMatch(/className="rail"[^>]*ref=\{setRail\}/);
    expect(src).toMatch(/railRef\(el\)/);
  });

  it("no layout carries a literal scroll offset", () => {
    for (const f of ["BandLayout", "RailLayout", "PanelLayout", "PanelSlot"]) {
      expect(read(`src/components/${f}.tsx`)).not.toMatch(/scrollMarginTop/);
    }
  });

  it("the anchors read the measured properties", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/\.band-anchor\s*\{[^}]*scroll-margin-top:\s*calc\(var\(--head-h\)/);
    expect(css).toMatch(/scroll-margin-top:\s*calc\(var\(--rail-h\)/);
    // Both need a declared fallback: the property is absent until a layout
    // that has a head actually mounts one.
    expect(css).toMatch(/:root\s*\{[^}]*--head-h:\s*0px/);
    expect(css).toMatch(/:root\s*\{[^}]*--rail-h:\s*0px/);
  });
});
