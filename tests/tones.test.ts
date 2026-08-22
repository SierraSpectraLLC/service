import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TONE_HEX, type Tone } from "@/lib/tones";

/**
 * TONE_HEX exists so email templates can resolve a tone to literal hex, and
 * it duplicates the pairs globals.css declares as --t-{tone}-bg/-fg. This
 * test is the thing that makes the duplication safe: change a tone in one
 * place and not the other, and CI says so.
 */
describe("TONE_HEX mirrors globals.css", () => {
  const css = readFileSync("src/app/globals.css", "utf8");

  const fromCss: Partial<Record<Tone, { bg?: string; fg?: string }>> = {};
  for (const m of css.matchAll(/--t-([a-z]+)-(bg|fg):\s*(#[0-9A-Fa-f]{6})/g)) {
    const tone = m[1] as Tone;
    (fromCss[tone] ??= {})[m[2] as "bg" | "fg"] = m[3].toUpperCase();
  }

  it("declares every tone exactly once in CSS", () => {
    expect(Object.keys(fromCss).sort()).toEqual(Object.keys(TONE_HEX).sort());
  });

  for (const [tone, pair] of Object.entries(TONE_HEX)) {
    it(`${tone} matches`, () => {
      expect(fromCss[tone as Tone]).toEqual({
        bg: pair.bg.toUpperCase(),
        fg: pair.fg.toUpperCase(),
      });
    });
  }
});
