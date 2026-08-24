import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The iOS zoom trap, guarded in CSS rather than in memory.
 *
 * Safari force-zooms whenever a focused field's text is under 16px, and the
 * relayout that follows scrolls the field out from under the caret - focus and
 * the keyboard go with it. It reads as "every text box on every page drops the
 * keyboard after each character", and it is invisible on a desktop browser,
 * which is exactly why it survived: nothing about the markup looks wrong.
 *
 * So the rule is asserted here, against the stylesheet itself.
 */
const css = readFileSync("src/app/globals.css", "utf8");

/** The block that applies once a coarse pointer (a finger) is in play. */
const coarseBlock = (() => {
  const at = css.indexOf("@media (pointer: coarse)");
  if (at < 0) return "";
  // Balance from the media query's opening brace to its close.
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(at, i + 1);
  }
  return "";
})();

describe("touch typing does not trigger the iOS zoom", () => {
  it("has a coarse-pointer block at all", () => {
    expect(coarseBlock).not.toBe("");
  });

  it("puts every field at 16px or more there", () => {
    const sizes = [...coarseBlock.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    for (const s of sizes) expect(s).toBeGreaterThanOrEqual(16);
  });

  it("covers the three field elements", () => {
    for (const el of ["input", "select", "textarea"]) {
      expect(coarseBlock).toMatch(new RegExp(`(^|[\\s,])${el}[\\s,.]`, "m"));
    }
  });

  it("outranks the type scale, which would otherwise put a field back under 16px", () => {
    // .t-small on an input is 12px; only element+class beats a bare class.
    for (const cls of ["t-meta", "t-small", "t-body"]) {
      expect(coarseBlock).toContain(`input.${cls}`);
    }
    // And those classes really are the small sizes this is defending against.
    expect(css).toMatch(/\.t-small\s*\{\s*font-size:\s*1[0-5]px/);
  });
});
