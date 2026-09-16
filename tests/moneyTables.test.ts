// The money tables are plain <table class="list"> markup, in a stylesheet
// that already owns three class names a table would naturally reach for:
// .row is a flex utility (on a <tr> it breaks the table into wrapping
// blocks - the Receivables page shipped that way), .doc is the print
// document, .empty is the dashed empty-state box. The tables have their own
// names for those three - hov, docno, nothing - and this keeps it so.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".tsx") ? [p] : [];
  });

describe("money tables", () => {
  const files = walk("src/app/money");

  it("never put the .row flex utility on a table row", () => {
    const hits = files.flatMap((f) => {
      const src = readFileSync(f, "utf8");
      return [...src.matchAll(/<tr\b[^>]*className=["`][^"`]*\brow\b/g)].map(() => f);
    });
    expect(hits).toEqual([]);
  });

  it("uses the table's own names for the document number and the empty row", () => {
    const hits = files.flatMap((f) => {
      const src = readFileSync(f, "utf8");
      return [
        ...[...src.matchAll(/<td\b[^>]*className="(?:[^"]* )?(?:doc|empty)(?: [^"]*)?"/g)].map(() => `${f}: td`),
        ...[...src.matchAll(/className="plain doc"/g)].map(() => `${f}: link`),
      ];
    });
    expect(hits).toEqual([]);
  });

  it("has the rules those names point at", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    expect(css).toMatch(/table\.list tr\.hov:hover td/);
    expect(css).toMatch(/table\.list \.docno/);
    expect(css).toMatch(/table\.list \.nothing/);
    expect(css).not.toMatch(/table\.list tr\.row/);
  });
});
