// One page of a long list. Pure, no database.
//
// Written for the equipment catalog, which drew all 1,118 models as cards and
// made a page the shop described as "astronomically long". The list is already
// in memory, so the fix is drawing less rather than fetching less - which
// makes this arithmetic, and makes the arithmetic the thing worth pinning.
//
// Both failures paging has are quiet. A page number outliving the list it was
// counting renders as an empty grid over results that exist, and an off-by-one
// in "showing 61-120 of 1,118" is invisible until somebody counts.
import { describe, expect, it } from "vitest";
import { pageLabel, pageOf } from "@/lib/paging";

const rows = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("pageOf", () => {
  it("hands back the asked-for slice", () => {
    const p = pageOf(rows(1118), 2, 48);
    expect(p.rows[0]).toBe(49);
    expect(p.rows).toHaveLength(48);
    expect([p.from, p.to, p.total]).toEqual([49, 96, 1118]);
    expect(p.pages).toBe(24);
  });

  it("gives the last page whatever is left, not a short slice starting late", () => {
    // 1118 = 23 x 48 + 14.
    const p = pageOf(rows(1118), 24, 48);
    expect(p.rows).toHaveLength(14);
    expect([p.from, p.to]).toEqual([1105, 1118]);
  });

  it("clamps a page that has fallen off the end of a shrinking filter", () => {
    /*
     * THE ONE THAT BITES. Type three letters into the search while on page 12
     * and the naive slice returns nothing - which draws "no models match" over
     * a filter that matched four. The last real page is the honest answer.
     */
    const p = pageOf(rows(4), 12, 48);
    expect(p.page).toBe(1);
    expect(p.rows).toEqual([1, 2, 3, 4]);
    expect(p.pages).toBe(1);
  });

  it("clamps below as well, so a zero or a negative cannot slice backwards", () => {
    expect(pageOf(rows(100), 0, 48).page).toBe(1);
    expect(pageOf(rows(100), -3, 48).rows[0]).toBe(1);
    expect(pageOf(rows(100), NaN, 48).page).toBe(1);
  });

  it("reads as one page when it all fits", () => {
    const p = pageOf(rows(12), 1, 48);
    expect(p.pages).toBe(1);
    expect([p.from, p.to]).toEqual([1, 12]);
  });

  it("says nothing rather than 1-0 of 0 on an empty list", () => {
    const p = pageOf([], 1, 48);
    expect([p.from, p.to, p.total]).toEqual([0, 0, 0]);
    // Still one page, so "page 1 of 1" reads rather than "page 1 of 0".
    expect(p.pages).toBe(1);
  });

  it("survives a nonsense page size instead of dividing by zero", () => {
    expect(pageOf(rows(3), 1, 0).rows).toHaveLength(1);
    expect(pageOf(rows(3), 1, -5).pages).toBe(3);
  });

  it("never drops or repeats a row across the pages", () => {
    // The property that matters more than any single boundary: walk every
    // page and you have seen the list once.
    const all = rows(1118);
    const seen: number[] = [];
    const pages = pageOf(all, 1, 48).pages;
    for (let i = 1; i <= pages; i++) seen.push(...pageOf(all, i, 48).rows);
    expect(seen).toEqual(all);
  });
});

describe("pageLabel", () => {
  it("names the span and the total, with thousands separated", () => {
    expect(pageLabel(pageOf(rows(1118), 2, 48), "models")).toBe("49-96 of 1,118 models");
  });

  it("just counts when it all fits - a span of the whole is not a span", () => {
    expect(pageLabel(pageOf(rows(12), 1, 48), "models")).toBe("12 models");
  });

  it("says one model rather than 1 models", () => {
    expect(pageLabel(pageOf(rows(1), 1, 48), "models")).toBe("1 model");
  });

  it("says none rather than zero of them", () => {
    expect(pageLabel(pageOf([], 1, 48), "models")).toBe("No models");
  });
});
