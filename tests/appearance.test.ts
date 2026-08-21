import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPECTRUM_HEIGHT, DEFAULT_STOPS, MAX_SPECTRUM_HEIGHT, MAX_STOPS,
  clampHeight, cleanStops, gradientCss, headerColor, parseStops, serializeStops,
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
