// Every scrim must sit UNDER the thing it dims.
//
// The bug this exists for: the mobile drawer set z-index 45 on its wrapper,
// which makes it a stacking context - so the numbers inside start again from
// zero and .scrim's global 40 stopped meaning "below the dialog" and started
// meaning "above everything in here". The pane, positioned with z-index auto,
// counted as 0. The menu came up dimmed and nothing in it could be tapped:
// every touch landed on the scrim, whose one job is to close the drawer, so
// links looked dead when they were really shutting the menu.
//
// Nothing in a typecheck or a jsdom render catches that - jsdom does no
// layout and no painting - so the guard reads the stylesheet.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/**
 * The z-index a selector ends up with, taking the LAST declaration to win -
 * which is what the cascade does for rules of equal specificity, and what a
 * later media block does to an earlier base rule.
 *
 * A positioned element with no z-index paints at 0 inside its stacking
 * context, so that is what absent means here.
 */
function zIndexOf(selector: string): number {
  const re = new RegExp(`(^|[,}])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[,{]`, "g");
  let z: number | null = null;
  for (const m of css.matchAll(re)) {
    const open = css.indexOf("{", m.index! + m[0].length - 1);
    const close = css.indexOf("}", open);
    const block = css.slice(open, close);
    const hit = /z-index:\s*(-?\d+)/.exec(block);
    if (hit) z = parseInt(hit[1], 10);
  }
  return z ?? 0;
}

/** Does this selector create a stacking context of its own? */
function makesStackingContext(selector: string): boolean {
  const re = new RegExp(`(^|[,}])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[,{]`, "g");
  for (const m of css.matchAll(re)) {
    const open = css.indexOf("{", m.index! + m[0].length - 1);
    const block = css.slice(open, css.indexOf("}", open));
    const positioned = /position:\s*(fixed|absolute|relative|sticky)/.test(block);
    if (positioned && /z-index:\s*-?\d+/.test(block)) return true;
    if (/position:\s*fixed/.test(block)) return true;
  }
  return false;
}

describe("an overlay's panel paints above its own scrim", () => {
  it("the mobile drawer's pane beats the drawer's scrim", () => {
    // Scoped, because the drawer is a stacking context and the global .scrim
    // number does not apply inside it.
    expect(zIndexOf(".mnav-drawer .scrim")).toBeLessThan(zIndexOf(".mnav-pane"));
  });

  it("the dialog sheet beats the plain scrim", () => {
    expect(zIndexOf(".scrim")).toBeLessThan(zIndexOf(".sheet"));
  });

  it("the drawer really is a stacking context, which is why the scoped rule is needed", () => {
    // If this ever stops being true the scoped override becomes harmless
    // rather than wrong - but the comment in globals.css would be a lie, and
    // somebody would delete it.
    expect(makesStackingContext(".mnav-drawer")).toBe(true);
  });

  it("the drawer sits above the tab bar it covers", () => {
    expect(zIndexOf(".mnav-tabbar")).toBeLessThan(zIndexOf(".mnav-drawer"));
  });
});

describe("a scrim never swallows the panel it belongs to", () => {
  // Read from the markup rather than a list somebody maintains: any component
  // that renders a .scrim has a panel beside it, and that panel has to win.
  const PAIRS: [string, string, string][] = [
    ["src/components/MobileNav.tsx", ".mnav-drawer .scrim", ".mnav-pane"],
    ["src/components/ui/Dialog.tsx", ".scrim", ".sheet"],
  ];

  for (const [file, scrim, panel] of PAIRS) {
    it(`${file.split("/").pop()} renders both halves and the panel wins`, () => {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      expect(src).toContain('className="scrim"');
      expect(zIndexOf(scrim)).toBeLessThan(zIndexOf(panel));
    });
  }

  it("finds every scrim in the codebase, so a new overlay has to be added here", () => {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : /\.tsx$/.test(p) ? [p] : [];
      });
    const users = walk(join(process.cwd(), "src"))
      .filter((f) => readFileSync(f, "utf8").includes('className="scrim"'))
      .map((f) => f.replace(process.cwd() + "/", ""))
      .sort();
    expect(users).toEqual(PAIRS.map(([f]) => f).sort());
  });
});
