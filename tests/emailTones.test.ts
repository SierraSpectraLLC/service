// The digest and EOD composers must draw every color from the shared palettes
// (EMAIL, TONE_HEX, STAGE_COLOR) rather than freehand hex - the same rule the
// app's components follow via CSS variables. A source scan, because a rendered
// fixture can only prove the colors it happens to exercise.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EMAIL } from "@/lib/emailTheme";
import { TONE_HEX } from "@/lib/tones";

const source = (p: string) => readFileSync(p, "utf8");

describe("email composers use the shared palettes", () => {
  it.each(["src/lib/digest.ts", "src/lib/eodEmail.ts"])("%s has no raw hex literals", (p) => {
    expect(source(p).match(/#[0-9A-Fa-f]{6}/g) ?? []).toEqual([]);
  });

  it("the EMAIL palette stays in step with the app's tones", () => {
    expect(EMAIL.faint).toBe(TONE_HEX.faint.fg);
    expect(EMAIL.ground).toBe(TONE_HEX.faint.bg);
    expect(EMAIL.link).toBe(TONE_HEX.info.fg);
  });
});
