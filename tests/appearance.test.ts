import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPECTRUM_HEIGHT, DEFAULT_STOPS, MAX_SPECTRUM_HEIGHT, MAX_STOPS,
  DEFAULT_HEADER,
  clampHeight, cleanStops, gradientCss, headerColor, parseStops, resolveLook,
  serializeStops, type Stop,
} from "@/lib/appearance";

// These values are written into a style attribute on every page, so the tests
// that matter most are the ones where the input is not a colour: a setting
// nobody validated is a way to write arbitrary CSS onto the whole app.

describe("colours that are not colours never reach the page", () => {
  it("keeps only real hex, upper-cased", () => {
    expect(cleanStops([{ c: "#e8613c", at: 10 }])).toEqual([{ c: "#E8613C", at: 10 }]);
  });

  it("drops anything that could break out of the property", () => {
    expect(cleanStops([
      { c: "red; } body { display:none } .x {", at: 0 },
      { c: "url(javascript:alert(1))", at: 50 },
      { c: "#GGGGGG", at: 60 },
      { c: "#fff", at: 70 },
    ])).toBeNull();
  });

  it("a gradient built from junk falls back to the stock look, never to empty CSS", () => {
    expect(gradientCss([{ c: "}; evil", at: 0 } as never])).toBe(gradientCss(DEFAULT_STOPS));
    expect(gradientCss([])).toContain("linear-gradient(90deg,");
  });

  it("a header colour that isn't one reads as the default", () => {
    expect(headerColor("  #1d9e75 ")).toBe("#1D9E75");
    expect(headerColor("navy; background:url(x)")).toBe("#172A4A");
    expect(headerColor("")).toBe("#172A4A");
  });
});

describe("stops", () => {
  it("clamps positions into the bar and orders them left to right", () => {
    expect(cleanStops([{ c: "#000000", at: 400 }, { c: "#FFFFFF", at: -20 }]))
      .toEqual([{ c: "#FFFFFF", at: 0 }, { c: "#000000", at: 100 }]);
  });

  it("caps how many there can be", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ c: "#112233", at: i }));
    expect(cleanStops(many)).toHaveLength(MAX_STOPS);
  });

  it("renders one stop as a solid bar rather than invalid CSS", () => {
    expect(gradientCss([{ c: "#1D9E75", at: 40 }]))
      .toBe("linear-gradient(90deg,#1D9E75 0%,#1D9E75 100%)");
  });

  it("round-trips through storage, and blank storage is the stock look", () => {
    const stops = [{ c: "#123456", at: 0 }, { c: "#ABCDEF", at: 100 }];
    expect(parseStops(serializeStops(stops))).toEqual(stops);
    expect(parseStops("")).toEqual(DEFAULT_STOPS);
    expect(parseStops("{not json")).toEqual(DEFAULT_STOPS);
    expect(parseStops('[{"c":"nope","at":0}]')).toEqual(DEFAULT_STOPS);
  });

  it("stores blank for nothing usable, so a future default can move", () => {
    expect(serializeStops([])).toBe("");
  });
});

describe("thickness", () => {
  it("takes whole pixels within the range", () => {
    expect(clampHeight(6)).toBe(6);
    expect(clampHeight("4")).toBe(4);
    expect(clampHeight(2.6)).toBe(3);
  });

  it("allows nothing at all - some people want no bar", () => {
    expect(clampHeight(0)).toBe(0);
    expect(clampHeight(-5)).toBe(0);
  });

  it("refuses a bar that would swallow the header, and junk reads as the default", () => {
    expect(clampHeight(9999)).toBe(MAX_SPECTRUM_HEIGHT);
    expect(clampHeight("thick")).toBe(DEFAULT_SPECTRUM_HEIGHT);
    expect(clampHeight(undefined)).toBe(DEFAULT_SPECTRUM_HEIGHT);
  });
});

describe("whose look a viewer actually gets", () => {
  /*
   * The rule is FIELD BY FIELD, and the reason is what happens when the
   * platform later changes its gradient: a workspace that once picked a header
   * colour must not be frozen wearing the palette that was current the day
   * they picked it.
   */
  const PLATFORM = {
    headerColor: "#172A4A",
    spectrumStops: [{ c: "#111111", at: 0 }, { c: "#222222", at: 100 }] as Stop[],
    spectrumHeight: 3,
  };
  const org = (over: Partial<{ themeColor: string; spectrumStops: string; spectrumHeight: number | null }> = {}) =>
    ({ themeColor: "", spectrumStops: "", spectrumHeight: null, ...over });

  it("gives a workspace that has chosen nothing the platform's look entirely", () => {
    const got = resolveLook(org(), PLATFORM);
    expect(got.headerColor).toBe("#172A4A");
    expect(got.spectrumHeight).toBe(3);
    expect(got.spectrumStops).toEqual(PLATFORM.spectrumStops);
  });

  it("gives a viewer with no workspace at all the platform's look", () => {
    // Platform staff. Not a fallback - the platform IS their workspace.
    expect(resolveLook(null, PLATFORM).headerColor).toBe("#172A4A");
  });

  it("keeps following the platform's gradient for a workspace that only picked a colour", () => {
    const got = resolveLook(org({ themeColor: "#8A1C1C" }), PLATFORM);
    expect(got.headerColor).toBe("#8A1C1C");
    // The half they did not choose still moves when the platform moves.
    expect(got.spectrumStops).toEqual(PLATFORM.spectrumStops);
    expect(got.spectrumHeight).toBe(3);
  });

  it("lets a workspace take the platform's colours at its own thickness", () => {
    // The reason stops and height are two columns rather than one blob.
    const got = resolveLook(org({ spectrumHeight: 10 }), PLATFORM);
    expect(got.spectrumHeight).toBe(10);
    expect(got.spectrumStops).toEqual(PLATFORM.spectrumStops);
  });

  it("treats a height of zero as a choice, not as absence", () => {
    /*
     * Zero means "no bar at all" and somebody meant it. This is why the column
     * is nullable: a not-null zero could not be told from unset, and the bar
     * would come back the next time the platform's height changed.
     */
    const got = resolveLook(org({ spectrumHeight: 0 }), PLATFORM);
    expect(got.spectrumHeight).toBe(0);
  });

  it("takes a workspace's own stops when it has them", () => {
    const own: Stop[] = [{ c: "#AA0000", at: 0 }, { c: "#00AA00", at: 100 }];
    const got = resolveLook(org({ spectrumStops: serializeStops(own) }), PLATFORM);
    expect(got.spectrumStops).toEqual(own);
    expect(got.spectrumCss).toBe(gradientCss(own));
  });

  it("falls back rather than painting rubbish stored by any path", () => {
    // The whole reason this file exists: these values go into a style
    // attribute, so a broken one must degrade rather than reach the page.
    expect(resolveLook(org({ themeColor: "red; } body { display:none } .x {" }), PLATFORM).headerColor)
      .toBe("#172A4A");
    expect(resolveLook(org({ spectrumStops: "not json" }), PLATFORM).spectrumStops)
      .toEqual(DEFAULT_STOPS);
    expect(resolveLook(org({ spectrumHeight: 9999 }), PLATFORM).spectrumHeight)
      .toBe(MAX_SPECTRUM_HEIGHT);
  });

  it("never emits a gradient with anything but validated hex in it", () => {
    const css = resolveLook(org({ spectrumStops: JSON.stringify([{ c: "url(javascript:alert(1))", at: 0 }]) }), PLATFORM).spectrumCss;
    expect(css).not.toContain("javascript");
    expect(css.startsWith("linear-gradient(90deg,")).toBe(true);
  });

  it("still resolves when the platform itself is the stock look", () => {
    const got = resolveLook(org(), {
      headerColor: DEFAULT_HEADER, spectrumStops: DEFAULT_STOPS, spectrumHeight: DEFAULT_SPECTRUM_HEIGHT,
    });
    expect(got.spectrumCss).toBe(gradientCss(DEFAULT_STOPS));
  });
});
