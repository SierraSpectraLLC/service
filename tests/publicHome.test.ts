import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The apex is the front door now, and two things about that fail silently.
 *
 * First the middleware. Its matcher is a negative lookahead over the path,
 * and for the ROOT the path after the leading slash is the empty string - so
 * `.*` matched it and every visitor without a cookie was redirected to
 * /login before a byte rendered. A home page that only signed-in people can
 * see is not a home page. One character (`*` -> `+`) is the whole fix, which
 * is exactly why it needs a test: nothing about the regex looks wrong.
 *
 * Then robots.txt. It said `Disallow: /` and allowed only /equipment, which
 * was right while the root was an application. With a landing page there,
 * that same line quietly forbids the one page the domain exists to rank.
 */
const middleware = readFileSync("src/middleware.ts", "utf8");
const robots = readFileSync("src/app/robots.ts", "utf8");
const sitemap = readFileSync("src/app/sitemap.ts", "utf8");

/** The matcher, run the way Next runs it. */
const matcher = (() => {
  const m = /matcher: \["([^"]+)"\]/.exec(middleware);
  if (!m) throw new Error("no matcher in middleware.ts");
  return new RegExp(`^${m[1]}$`);
})();

describe("the middleware gate lets a stranger reach the root", () => {
  it("does not guard /", () => {
    expect(matcher.test("/")).toBe(false);
  });

  it("still guards every application path", () => {
    for (const p of ["/work", "/money", "/settings/billing", "/instruments/12", "/store", "/orders", "/eod"]) {
      expect(matcher.test(p)).toBe(true);
    }
  });

  it("still lets the public and token routes through untouched", () => {
    for (const p of ["/login", "/equipment", "/equipment/agilent-7890b", "/share/abc", "/drop/abc", "/listing/abc"]) {
      expect(matcher.test(p)).toBe(false);
    }
  });
});

describe("robots does not forbid the page the domain exists for", () => {
  it("allows the root exactly, with the end-of-path anchor", () => {
    // "/" without the "$" would allow the whole site; the app lives there.
    expect(robots).toMatch(/allow:\s*\[\s*"\/\$"/);
  });

  it("keeps deny-by-default underneath it", () => {
    expect(robots).toMatch(/disallow:\s*\[\s*"\/"/);
  });

  it("still names the token routes, whose findability would defeat the token", () => {
    for (const p of ["/share/", "/drop/", "/listing/", "/api/", "/settings/"]) {
      expect(robots).toContain(`"${p}"`);
    }
  });

  /**
   * The sitemap used to bail out entirely when the library was switched off,
   * which would now mean a site whose home page is in no sitemap at all.
   */
  it("offers a sitemap whether or not the library is on", () => {
    expect(sitemap).toMatch(/if \(!url\) return \[\]/);
    expect(sitemap).toContain("if (!publicCatalog) return home");
  });
});
