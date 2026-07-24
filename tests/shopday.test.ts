import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { shopToday, shopTodayMDY, shopTime, shopMonthDay } from "@/lib/shopday";

// 2026-07-22 02:30 UTC = Jul 21, 7:30 PM in America/Los_Angeles - the exact
// evening-rollover case the shop hit in production.
const INSTANT = new Date("2026-07-22T02:30:00Z");

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(INSTANT);
  process.env.SHOP_TZ = "America/Los_Angeles";
});
afterAll(() => vi.useRealTimers());

describe("shop-time helpers", () => {
  it("shopToday stays on the shop's calendar date across the UTC rollover", () => {
    expect(shopToday()).toBe("2026-07-21");
  });
  it("shopTodayMDY matches the client email header format", () => {
    expect(shopTodayMDY()).toBe("07/21/26");
  });
  it("shopTime renders wall-clock shop time", () => {
    expect(shopTime(INSTANT)).toBe("Jul 21, 7:30 PM");
  });
  it("shopMonthDay stamps the shop date, not the UTC date", () => {
    expect(shopMonthDay(INSTANT)).toBe("Jul 21");
  });
  it("honors a different SHOP_TZ", () => {
    process.env.SHOP_TZ = "America/Denver";
    expect(shopTime(INSTANT)).toBe("Jul 21, 8:30 PM");
    process.env.SHOP_TZ = "America/Los_Angeles";
  });
});
