import { describe, expect, it } from "vitest";
import {
  STARTER_CATEGORIES, categoryKey, cleanCategoryName, missingStarters,
} from "@/lib/expenseCategories";

/**
 * The starter set is a product decision frozen in a list, so the decisions
 * are asserted: enough names to be useful on day one, few enough to fit a
 * picker, no near-duplicates to teach sloppy filing, and a catch-all so
 * nothing is ever unfileable.
 */
describe("the starter set", () => {
  it("is picker-sized: fifteen to twenty names", () => {
    expect(STARTER_CATEGORIES.length).toBeGreaterThanOrEqual(15);
    expect(STARTER_CATEGORIES.length).toBeLessThanOrEqual(20);
  });

  it("has no duplicates, even sloppy ones", () => {
    const keys = STARTER_CATEGORIES.map(categoryKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("ends with Other, because a catch-all that sorts mid-list gets everything", () => {
    expect(STARTER_CATEGORIES[STARTER_CATEGORIES.length - 1]).toBe("Other");
  });

  it("covers the rows the app itself writes", () => {
    // The travel-rules strip logs per diem and points at lodging by name; a
    // starter set without them would contradict the panel one card up.
    for (const needed of ["Per diem", "Lodging", "Mileage"]) {
      expect(STARTER_CATEGORIES).toContain(needed);
    }
  });
});

describe("what the seed adds to a workspace", () => {
  it("everything, to an empty one", () => {
    expect(missingStarters([])).toHaveLength(STARTER_CATEGORIES.length);
  });

  it("nothing a workspace already has, however it cased it", () => {
    const missing = missingStarters([{ name: "  FUEL " }, { name: "per diem" }]);
    expect(missing).not.toContain("Fuel");
    expect(missing).not.toContain("Per diem");
    expect(missing).toHaveLength(STARTER_CATEGORIES.length - 2);
  });

  it("is idempotent: seeding twice adds nothing the second time", () => {
    const after = STARTER_CATEGORIES.map((name) => ({ name }));
    expect(missingStarters(after)).toEqual([]);
  });
});

describe("names people type", () => {
  it("collapses whitespace and refuses emptiness", () => {
    expect(cleanCategoryName("  Fuel   &  oil ")).toBe("Fuel & oil");
    expect(cleanCategoryName("   ")).toBeNull();
  });

  it("caps length instead of erroring - a picker row, not an essay", () => {
    expect(cleanCategoryName("x".repeat(200))!.length).toBeLessThanOrEqual(40);
  });
});
