import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The part page and the row that opens it.
 *
 * Two things here fail silently rather than loudly, so they are read from the
 * source instead of trusted:
 *
 * 1. The row must open the part with a real anchor. A div with an onClick that
 *    calls router.push looks identical on screen and works on a click - and
 *    quietly drops cmd-click, middle-click and "open in new tab", which is the
 *    whole reason the page exists. Only an <a href> gives a browser something
 *    to open in a tab.
 *
 * 2. The page must take its item from the client's own shelf and 404 when it
 *    is not there. Loading the catalog row by id would render, price and sell
 *    a part this client was never offered, and it would look right while doing
 *    it. shelfFor(org) already applies the tenancy and the pricing; finding the
 *    item inside its result is what makes the id in the URL worth nothing.
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("the shelf row opens the part page", () => {
  const front = read("src/components/StoreFront.tsx");

  it("links each row with an href a browser can open in a tab", () => {
    expect(front).toMatch(/<Link\s+href=\{`\/store\/\$\{i\.id\}`\}/);
  });

  it("does not navigate to a part by pushing a route from a handler", () => {
    expect(front).not.toMatch(/(push|replace)\(\s*[`"']\/store\//);
  });
});

describe("the part page sells only from this client's shelf", () => {
  const page = read("src/app/store/[id]/page.tsx");

  it("takes its item from shelfFor, not from the catalog row", () => {
    expect(page).toContain("await shelfFor(org)");
    expect(page).toMatch(/items\.find\(\(i\) => i\.id === id\)/);
  });

  it("404s when the id is not on that shelf", () => {
    const found = page.indexOf("items.find((i) => i.id === id)");
    const guard = page.indexOf("notFound()", found);
    expect(found).toBeGreaterThan(-1);
    // The 404 comes before any other read of the part.
    expect(guard).toBeGreaterThan(-1);
    expect(page.slice(found, guard)).not.toContain("db.select");
  });

  it("refuses staff and strangers before it reads anything", () => {
    expect(page).toContain('redirect("/login")');
    expect(page).toMatch(/org\.kind !== "client"/);
  });
});
