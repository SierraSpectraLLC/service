// Cash on hand, carried forward from a typed balance. Pure, no DB.
//
// The app is not a bank feed, so the figure is opening + what it saw arrive
// - what it saw leave. What is pinned here is the window (the opening day
// and today, both inclusive), the payroll-at-month-end rule, and that an
// unset balance is absent rather than zero.
import { describe, expect, it } from "vitest";
import { cashOnHand, type CashInputs } from "@/lib/cash";

const base = (over: Partial<CashInputs> = {}): CashInputs => ({
  openingCents: 2_431_000, openingOn: "2026-08-20", today: "2026-09-15",
  received: [
    { on: "2026-08-19", cents: 100_000 },   // before the opening: already in the typed balance
    { on: "2026-08-20", cents: 700_000 },   // the opening day counts
    { on: "2026-09-10", cents: 2_000_000 },
    { on: "2026-09-16", cents: 999_999 },   // tomorrow does not
  ],
  reimbursed: [{ on: "2026-09-01", cents: 7_080 }],
  overhead: [{ on: "2026-09-01", cents: 41_200 }, { on: "2026-08-01", cents: 41_200 }],
  payrollByMonth: { "2026-07": 958_333, "2026-08": 958_333, "2026-09": 958_333 },
  ...over,
});

describe("cashOnHand", () => {
  it("is absent, not zero, until a balance has been typed in", () => {
    expect(cashOnHand(base({ openingOn: "" }))).toBeNull();
  });

  it("counts flows from the opening day through today, and nothing outside", () => {
    const c = cashOnHand(base())!;
    expect(c.receivedCents).toBe(2_700_000);
    expect(c.reimbursedCents).toBe(7_080);
    expect(c.overheadCents).toBe(41_200);
  });

  it("takes payroll at each month's end, so a month still running has not been paid", () => {
    const c = cashOnHand(base())!;
    // July ended before the balance was taken; August ended inside the
    // window; September has not ended.
    expect(c.payrollMonths).toEqual(["2026-08"]);
    expect(c.payrollCents).toBe(958_333);
    expect(c.cents).toBe(2_431_000 + 2_700_000 - 7_080 - 41_200 - 958_333);
  });

  it("counts the current month once it has ended", () => {
    const c = cashOnHand(base({ today: "2026-09-30" }))!;
    expect(c.payrollMonths).toEqual(["2026-08", "2026-09"]);
  });

  it("does not count an opening month whose end had already passed when the balance was taken", () => {
    const c = cashOnHand(base({ openingOn: "2026-09-01", today: "2026-09-15" }))!;
    expect(c.payrollMonths).toEqual([]);
  });
});
