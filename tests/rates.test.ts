// What an hour costs: which card applies, and the arithmetic on top of it.
// Every figure is integer cents - the tests below are as much about never
// seeing a fraction of a cent as they are about the rules.
import { describe, expect, it } from "vitest";
import {
  FALLBACK_RATE, billableMinutes, hourlyFor, priceTime, resolveRate, type RateCard,
} from "@/lib/rates";

const card = (over: Partial<RateCard>): RateCard => ({
  id: 1, orgId: null, agreementId: null, hourlyCents: 15000,
  afterHoursPct: 150, travelPct: 50, minIncrementMin: 15, label: "", ...over,
});

describe("which card applies", () => {
  const platform = card({ id: 1, hourlyCents: 19500, label: "platform" });
  const org = card({ id: 2, orgId: 7, hourlyCents: 18000, label: "org" });
  const paper = card({ id: 3, orgId: 7, agreementId: 42, hourlyCents: 16000, label: "agreement" });
  const all = [platform, org, paper];

  it("the agreement beats the org, which beats the workspace default", () => {
    expect(resolveRate(all, { orgId: 7, agreementId: 42 }).label).toBe("agreement");
    expect(resolveRate(all, { orgId: 7, agreementId: null }).label).toBe("org");
    expect(resolveRate(all, { orgId: 9, agreementId: null }).label).toBe("platform");
  });

  it("an agreement with no card of its own falls back to the client's", () => {
    expect(resolveRate(all, { orgId: 7, agreementId: 99 }).label).toBe("org");
  });

  it("never prices labor at nothing when a workspace has no cards", () => {
    expect(resolveRate([], { orgId: 7, agreementId: null })).toEqual(FALLBACK_RATE);
    expect(resolveRate([], { orgId: null, agreementId: null }).hourlyCents).toBeGreaterThan(0);
  });
});

describe("rounding minutes", () => {
  it("rounds up to the increment, because the interruption was real", () => {
    expect(billableMinutes(7, 15)).toBe(15);
    expect(billableMinutes(16, 15)).toBe(30);
    expect(billableMinutes(30, 15)).toBe(30);
  });

  it("leaves nothing as nothing, and honors an increment of one", () => {
    expect(billableMinutes(0, 15)).toBe(0);
    expect(billableMinutes(37, 1)).toBe(37);
    expect(billableMinutes(37, 0)).toBe(37);
  });
});

describe("the rate for a category", () => {
  it("charges travel at the travel percent and after-hours at its own", () => {
    const c = card({ hourlyCents: 16000, travelPct: 50, afterHoursPct: 150 });
    expect(hourlyFor(c, "onsite")).toBe(16000);
    expect(hourlyFor(c, "remote")).toBe(16000);
    expect(hourlyFor(c, "travel")).toBe(8000);
    expect(hourlyFor(c, "onsite", true)).toBe(24000);
  });

  it("keeps travel at its own rate even after hours - it is still travel", () => {
    expect(hourlyFor(card({ hourlyCents: 16000 }), "travel", true)).toBe(8000);
  });
});

describe("pricing a block of time", () => {
  it("returns pieces whose printed qty times printed unit is the printed amount", () => {
    const p = priceTime(315, "onsite", card({ hourlyCents: 16000, minIncrementMin: 15 }));
    expect(p.minutes).toBe(315);
    expect(p.hours).toBe(5.25);
    expect(p.hourlyCents).toBe(16000);
    expect(p.amountCents).toBe(84000);
    expect(Math.round(p.hours * p.hourlyCents)).toBe(p.amountCents);
  });

  it("rounds the block once, not each entry, and lands on whole cents", () => {
    const p = priceTime(7, "onsite", card({ hourlyCents: 16000, minIncrementMin: 15 }));
    expect(p.minutes).toBe(15);
    expect(p.amountCents).toBe(4000);
    expect(Number.isInteger(p.amountCents)).toBe(true);
  });

  it("prices travel at half without a fraction of a cent in sight", () => {
    const p = priceTime(90, "travel", card({ hourlyCents: 16500, travelPct: 50 }));
    expect(p.hourlyCents).toBe(8250);
    expect(p.amountCents).toBe(12375);
    expect(Number.isInteger(p.amountCents)).toBe(true);
  });

  it("charges nothing for no time", () => {
    expect(priceTime(0, "onsite", card({})).amountCents).toBe(0);
  });
});
