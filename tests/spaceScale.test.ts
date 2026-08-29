import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The spacing scale, on the exact pattern of tests/typeScale.test.ts.
 *
 * The measurement that started this: eighteen distinct inline spacing values,
 * including 3, 5, 7 and 9 - with 8px used 557 times, 6px 322, 10px 213 and 4px
 * 185. Four near-identical gaps coexisting is why nothing on a page quite
 * lines up, and "slightly different everywhere" is what people mean when they
 * say an app feels disconnected. Nobody chose that; it accumulated, one
 * reasonable-looking judgement at a time, because nothing ever said no.
 *
 * THE RATCHET, and why it is a ratchet. A previous sweep normalized 223
 * commits' worth of values and they drifted straight back, because a sweep
 * fixes the past and nothing was stopping the future. The honest state today
 * is that thousands of inline blocks are still off the grid; converting them
 * is a mechanical diff that has to land on its own. So this test fails the
 * build on a value that is off the grid ONLY by counting: the count may fall,
 * and the day it rises the build says so. New code stops adding entropy
 * immediately, old code converts opportunistically, and the number below is
 * the running record of how far that has got.
 */
const CSS = readFileSync("src/app/globals.css", "utf8");

/** The whole scale. A 4px grid, and nothing between the steps. */
const STEPS = [4, 8, 12, 16, 24, 32, 48];

/**
 * Values that are not spacing decisions and never were.
 *
 * 0 is "none". 1, 2 and 3 are hairlines, dot offsets and optical nudges on
 * borders - a 2px inset on a focus ring is not a gap somebody could have
 * written as 4. 1.5 likewise. Anything above them is a real spacing choice and
 * has to be on the grid or counted here.
 */
const NOT_SPACING = new Set([0, 1, 1.5, 2, 3]);

/**
 * How many off-grid inline spacing values remain in src/**\/*.tsx.
 *
 * LOWER THIS when you convert a file; never raise it. If this fails with a
 * number larger than the one here, the fix is to use a scale step (or a
 * primitive from ui/Layout) rather than to bump the constant - that is the
 * lesson the last sweep paid for.
 */
const OFF_GRID_BUDGET = 740;

const tsxFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsxFiles(p) : p.endsWith(".tsx") ? [p] : [];
  });

/** gap / padding / margin, in the inline forms the codebase actually writes. */
const SPACING_PROP = /\b(gap|rowGap|columnGap|padding|paddingTop|paddingRight|paddingBottom|paddingLeft|margin|marginTop|marginRight|marginBottom|marginLeft): *([0-9.]+)(?![0-9.a-z])/g;

describe("globals.css", () => {
  it("declares every step exactly once, as a token", () => {
    for (const px of STEPS) {
      const decl = new RegExp(`--sp-[0-9]+: *${px}px;`);
      expect(CSS, `no token declares ${px}px`).toMatch(decl);
    }
  });

  it("keeps the steps on a 4px grid with nothing between them", () => {
    const declared = [...CSS.matchAll(/--sp-([0-9]+): *([0-9]+)px;/g)]
      .map((m) => [Number(m[1]), Number(m[2])] as const)
      .sort((a, b) => a[0] - b[0]);
    expect(declared.map(([, px]) => px)).toEqual(STEPS);
    for (const [, px] of declared) {
      expect(px % 4, `--sp is off the 4px grid at ${px}px`).toBe(0);
    }
  });

  it("gives the layout primitives one class per step, and no others", () => {
    // ui/Layout writes `sp-{n}`; a class the components can emit with no rule
    // behind it is a gap that silently becomes zero.
    const classes = [...CSS.matchAll(/^\.sp-([0-9]+) \{ gap: var\(--sp-([0-9]+)\); \}/gm)]
      .map((m) => [m[1], m[2]]);
    expect(classes).toEqual(STEPS.map((_, i) => [`${i + 1}`, `${i + 1}`]));
  });

  it("carries the motion vocabulary as two tokens, not as durations", () => {
    // The other half of the audit's cure for "clunky": one duration, one
    // easing, on a closed list of things allowed to move.
    expect(CSS).toMatch(/--dur: 140ms;/);
    expect(CSS).toMatch(/--ease: cubic-bezier\(/);
    // And nothing left hand-timing itself past the tokens.
    const live = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const raw = [...live.matchAll(/transition: *[^;]*?([0-9.]+)s/g)].map((m) => m[1]);
    expect(raw, `hand-written transition durations: ${raw.join(", ")}`).toEqual([]);
  });

  it("settles on one radius, and lets pills be pills", () => {
    expect(CSS).toMatch(/--radius: 8px;/);
    const live = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const stray = [...live.matchAll(/border-radius: *([0-9]+)px/g)]
      .map((m) => Number(m[1]))
      // 999 is a pill, which is the one shape that is deliberately not the
      // token. 4px and under are marks rather than boxes: progress bars, chart
      // swatches, the dots in a legend key.
      .filter((px) => px > 4 && px !== 999);
    expect(stray, `off-token radii: ${stray.join(", ")}`).toEqual([]);
  });
});

describe("components", () => {
  const files = tsxFiles("src");

  it("does not add spacing off the grid", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(SPACING_PROP)) {
        const v = parseFloat(m[2]);
        if (NOT_SPACING.has(v) || STEPS.includes(v)) continue;
        offenders.push(`${f}: ${m[1]}: ${v}`);
      }
    }
    expect(
      offenders.length,
      `off-grid inline spacing went UP to ${offenders.length} (budget ${OFF_GRID_BUDGET}).\n`
      + `Use a --sp step or a ui/Layout primitive. First few:\n`
      + offenders.slice(0, 12).join("\n"),
    ).toBeLessThanOrEqual(OFF_GRID_BUDGET);
  });

  it("keeps the budget honest", () => {
    // A budget far above the real count stops being a ratchet and becomes a
    // number nobody reads. If this fails, the sweep got ahead of the constant:
    // lower OFF_GRID_BUDGET to the reported count.
    let n = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(SPACING_PROP)) {
        const v = parseFloat(m[2]);
        if (!NOT_SPACING.has(v) && !STEPS.includes(v)) n += 1;
      }
    }
    expect(OFF_GRID_BUDGET - n, `budget is ${OFF_GRID_BUDGET}, actual ${n} - lower it`).toBeLessThan(60);
  });
});
