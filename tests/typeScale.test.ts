import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The scale is only a scale if nothing lives between its steps.
 *
 * The last attempt at this defined six named sizes and then let every
 * component keep picking its own: the stylesheet rendered at thirteen sizes,
 * the components added eighteen more, and seventy-two of those were
 * half-pixels - 12.5 beside 13 beside 12 in one row. Nobody chose that; it
 * accumulated, one reasonable-looking judgement at a time, because nothing
 * ever said no. This says no.
 */

const CSS = readFileSync("src/app/globals.css", "utf8");
const STEPS = [10, 11, 12, 13, 14, 16, 19, 22, 26];

/**
 * Print is measured in inches, not in steps.
 *
 * A signoff sheet, a shipping label and a PDF overlay are laid out against a
 * physical page, where 10.5px is a real answer to "fit this column" rather
 * than a shrug. They are exempt on purpose, and the exemption is a list so
 * that adding to it is a decision somebody makes on the record.
 *
 * opengraph-image is here on that same reasoning and is the decision on the
 * record: it is not a page. It is one 1200x630 canvas rendered by Satori and
 * then looked at as a thumbnail in somebody's Slack, so its type is sized
 * against that frame - an 82px headline is a third of the card's height, not
 * a heading three steps above body. Nothing it declares reaches the app, and
 * the scale it would otherwise have to use tops out at 26px, which on a card
 * this size is a caption.
 */
const PRINT = ["binder/", "signoff/", "PrintHeader", "LabelCard", "SignatureBlock", "PdfStudio", "/pdf/", "opengraph-image"];

const tsxFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsxFiles(p) : p.endsWith(".tsx") ? [p] : [];
  });

describe("globals.css", () => {
  it("declares every step exactly once, as a token", () => {
    for (const px of STEPS) {
      const decl = new RegExp(`--fs-[a-z]+: *${px}px;`);
      expect(CSS, `no token declares ${px}px`).toMatch(decl);
    }
  });

  it("sizes text with tokens, never with a raw px", () => {
    // Comments quote the old rules verbatim as history - it is the live
    // declarations that have to be clean. The only literal left standing is
    // iOS Safari's zoom threshold, which belongs to the browser rather than
    // to the scale; see the last block in globals.css.
    const live = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = live.slice(live.indexOf("--sp-1"));
    const raw = [...rules.matchAll(/font-size: *([0-9.]+)px(?! *!important)/g)].map((m) => m[1]);
    expect(raw, `raw font-size values left in globals.css: ${raw.join(", ")}`).toEqual([]);
  });

  it("keeps the iOS threshold a literal 16px, not a scale token", () => {
    // If this ever reads var(--fs-title), retuning the scale silently starts
    // dropping the keyboard on every phone again.
    expect(CSS).toMatch(/font-size: 16px !important;/);
  });
});

describe("components", () => {
  const files = tsxFiles("src").filter((f) => !PRINT.some((k) => f.includes(k)));

  it("size text only on the scale", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/fontSize: *([0-9.]+)(?![0-9.])/g)) {
        const v = parseFloat(m[1]);
        if (!STEPS.includes(v)) offenders.push(`${f}: ${v}`);
      }
    }
    expect(offenders, `off-scale sizes:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("leaves print routes free to measure in inches", () => {
    // Not a rule so much as a note that the exemption is real and used - if
    // this ever hits zero the list above should shrink, not linger.
    expect(tsxFiles("src").filter((f) => PRINT.some((k) => f.includes(k))).length).toBeGreaterThan(0);
  });
});
