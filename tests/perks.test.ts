// Perks: the compensation that is not wages.
//
// Small arithmetic, held down because three surfaces print it - the person
// file, the roster, the monthly line on /people - and a stipend that reads
// $85 in one place and $85.42 in another is a payroll question nobody should
// have to ask twice.
import { describe, expect, it } from "vitest";
import {
  perkActiveOn, perkMonthlyCents, perkProblems, perksMonthlyTotal, type PerkRow,
} from "@/lib/perks";

const perk = (over: Partial<PerkRow> = {}): PerkRow => ({
  id: 1, personEmail: "sam@shop.test", name: "Sam", title: "Phone stipend",
  amountCents: 8_500, cadence: "monthly", startsOn: "2026-01-01", endsOn: "", note: "",
  ...over,
});

describe("what a perk adds to a month", () => {
  it("a monthly perk is its own amount", () => {
    expect(perkMonthlyCents(perk())).toBe(8_500);
  });

  it("an annual perk is a twelfth", () => {
    expect(perkMonthlyCents(perk({ cadence: "annual", amountCents: 120_000 }))).toBe(10_000);
  });

  it("a one-off adds nothing to the run rate", () => {
    // Real money, not a rate: a March bonus in the "per month" figure would
    // overstate every month after it.
    expect(perkMonthlyCents(perk({ cadence: "one_off", amountCents: 500_000 }))).toBe(0);
  });
});

describe("when a perk is in force", () => {
  it("runs from its start until its end, inclusive", () => {
    const p = perk({ startsOn: "2026-03-01", endsOn: "2026-09-30" });
    expect(perkActiveOn(p, "2026-02-28")).toBe(false);
    expect(perkActiveOn(p, "2026-03-01")).toBe(true);
    expect(perkActiveOn(p, "2026-09-30")).toBe(true);
    expect(perkActiveOn(p, "2026-10-01")).toBe(false);
  });

  it("an open-ended perk simply runs", () => {
    expect(perkActiveOn(perk(), "2030-01-01")).toBe(true);
  });

  it("a one-off belongs to the month it landed in and no other", () => {
    const bonus = perk({ cadence: "one_off", startsOn: "2026-03-15" });
    expect(perkActiveOn(bonus, "2026-03-01")).toBe(true);
    expect(perkActiveOn(bonus, "2026-03-31")).toBe(true);
    expect(perkActiveOn(bonus, "2026-04-01")).toBe(false);
  });
});

describe("the roster total", () => {
  it("sums only what is in force, at its monthly worth", () => {
    const rows = [
      perk(),                                                        // 85/mo
      perk({ id: 2, cadence: "annual", amountCents: 60_000 }),       // 50/mo
      perk({ id: 3, endsOn: "2026-05-31" }),                         // ended
      perk({ id: 4, cadence: "one_off", startsOn: "2026-01-10" }),   // long paid
    ];
    expect(perksMonthlyTotal(rows, "2026-08-28")).toBe(8_500 + 5_000);
  });
});

describe("what a perk needs before it can be granted", () => {
  const ok = { title: "Phone stipend", amountCents: 8_500, cadence: "monthly", startsOn: "2026-08-28", endsOn: "" };

  it("accepts a whole one", () => {
    expect(perkProblems(ok)).toEqual([]);
  });

  it("insists on a name, an amount, a cadence and a day", () => {
    expect(perkProblems({ ...ok, title: " " })[0]).toContain("what the perk is");
    expect(perkProblems({ ...ok, amountCents: 0 })[0]).toContain("worth");
    expect(perkProblems({ ...ok, cadence: "weekly" })[0]).toContain("how often");
    expect(perkProblems({ ...ok, startsOn: "soon" })[0]).toContain("day it starts");
  });

  it("refuses an end before the start", () => {
    expect(perkProblems({ ...ok, endsOn: "2026-01-01" })[0]).toContain("before the start");
  });
});
