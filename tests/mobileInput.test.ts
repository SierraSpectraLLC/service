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
 * The first fix for this was correct and still did nothing, because it was
 * written near the top of the file and two later rules of equal specificity
 * beat it on source order alone:
 *
 *   .pdf-page input    { font-size: 11px }
 *   .inline-edit input { font-size: inherit }
 *
 * So the rule under test is not only "16px somewhere" - it is "16px, and
 * nothing in this stylesheet gets the last word on a field's size after it".
 * That second half is what these tests exist for.
 */
const css = readFileSync("src/app/globals.css", "utf8");

/** Balance from a media query's opening brace to its close. */
function blockAt(at: number): { text: string; end: number } {
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return { text: css.slice(at, i + 1), end: i + 1 };
  }
  return { text: "", end: css.length };
}

/** Every coarse-pointer block, in source order. */
const coarseBlocks = (() => {
  const out: { at: number; text: string }[] = [];
  for (let at = css.indexOf("@media (pointer: coarse)"); at >= 0;
       at = css.indexOf("@media (pointer: coarse)", at + 1)) {
    out.push({ at, text: blockAt(at).text });
  }
  return out;
})();

/** The one that sizes fields - the last coarse block that sets a font-size. */
const sizing = [...coarseBlocks].reverse().find((b) => /font-size/.test(b.text));

/** Does this selector list target a form control? */
const hitsAField = (sel: string) =>
  /(^|[\s,>+~(])(input|textarea|select)([\s,.:[#)]|$)/.test(sel)
  || /contenteditable/.test(sel);

describe("touch typing does not trigger the iOS zoom", () => {
  it("has a coarse-pointer block that sizes fields", () => {
    expect(sizing).toBeDefined();
  });

  it("puts every field at 16px or more there", () => {
    const sizes = [...sizing!.text.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    for (const s of sizes) expect(s).toBeGreaterThanOrEqual(16);
  });

  it("covers the three field elements", () => {
    for (const el of ["input", "select", "textarea"]) {
      expect(sizing!.text).toMatch(new RegExp(`(^|[\\s,])${el}[\\s,.]`, "m"));
    }
  });

  it("outranks the type scale, which would otherwise put a field back under 16px", () => {
    // .t-small on an input is 12px; only element+class beats a bare class.
    for (const cls of ["t-meta", "t-small", "t-body"]) {
      expect(sizing!.text).toContain(`input.${cls}`);
    }
    // And those classes really are the small sizes this is defending against.
    // They size through the scale now, so the check follows the token to the
    // number rather than expecting a literal in the class body.
    expect(css).toMatch(/\.t-small\s*\{\s*font-size:\s*var\(--fs-small\)/);
    const step = css.match(/--fs-small: *(\d+(?:\.\d+)?)px/);
    expect(step, "--fs-small is not declared").not.toBeNull();
    expect(Number(step![1])).toBeLessThan(16);
  });

  it("wins against an inline style attribute too", () => {
    // A style={{ fontSize: 12 }} on a field beats any stylesheet rule without
    // this. On a touch device no component has standing to opt out.
    expect(sizing!.text).toMatch(/font-size:\s*16px\s*!important/);
  });

  /**
   * The regression that made the first fix useless: a later rule of equal
   * specificity taking the last word. Nothing that sizes a field may appear
   * after this block.
   */
  it("is the last word in the file on how big a field is", () => {
    const after = css.slice(sizing!.at + sizing!.text.length);
    const offenders: string[] = [];
    for (const m of after.matchAll(/([^{}@]+)\{([^{}]*font-size[^{}]*)\}/g)) {
      const sel = m[1].trim();
      if (hitsAField(sel)) offenders.push(`${sel} { ${m[2].trim()} }`);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The two rules that actually did the beating, named so that deleting the
   * coverage is a deliberate act rather than an oversight.
   */
  it("names the descendant rules that beat the first attempt", () => {
    for (const sel of [".pdf-page input", ".inline-edit input"]) {
      // Either the offending rule is gone, or the coarse block covers it.
      const stillThere = new RegExp(`${sel.replace(".", "\\.")}\\s*\\{`).test(css.slice(0, sizing!.at));
      if (stillThere) expect(sizing!.text).toContain(sel);
    }
  });
});
