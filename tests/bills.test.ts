// Standing bills, as arithmetic on dates. Pure, no DB.
//
// The schedule itself is lib/stipends', pinned in tests/stipends; what is
// pinned here is what a bill has and a stipend does not - the calendar
// window ("what comes due this month", posted or not), the shape of a bill
// fit to store, and what there is to do about one on the day.
import { describe, expect, it } from "vitest";
import {
  billAction, billCyclesBetween, billsDueBetween, billsDueSoon, checkBill, endOfMonth,
  type BillTerms,
} from "@/lib/bills";
import { periodEnd } from "@/lib/finance";

const bill = (over: Partial<BillTerms> = {}): BillTerms => ({
  amountCents: 41_200, cadence: "months", everyMonths: 1, dayOfMonth: 15,
  everyWeeks: 1, weekday: 1, startsOn: "2026-01-01", endsOn: "", active: true, lastOn: "",
  ...over,
});

describe("billCyclesBetween", () => {
  it("answers the calendar, not the cursor - a posted cycle still falls due this month", () => {
    // Already posted for September; the owner asking on the 3rd what is due
    // this month still means the 15th.
    expect(billCyclesBetween(bill({ lastOn: "2026-09-15" }), "2026-09-01", "2026-09-30"))
      .toEqual(["2026-09-15"]);
  });

  it("walks a quarterly bill across a year and stops at the end date", () => {
    expect(billCyclesBetween(
      bill({ everyMonths: 3, dayOfMonth: 1, startsOn: "2026-01-01", endsOn: "2026-08-01" }),
      "2026-01-01", "2026-12-31",
    )).toEqual(["2026-01-01", "2026-04-01", "2026-07-01"]);
  });

  it("returns nothing for a paused bill, a backwards window, or a corrupt start", () => {
    expect(billCyclesBetween(bill({ active: false }), "2026-09-01", "2026-09-30")).toEqual([]);
    expect(billCyclesBetween(bill(), "2026-09-30", "2026-09-01")).toEqual([]);
    expect(billCyclesBetween(bill({ startsOn: "not a day" }), "2026-09-01", "2026-09-30")).toEqual([]);
  });
});

describe("billsDueBetween and billsDueSoon", () => {
  it("sums a set of bills across a window, in date order", () => {
    const a = bill({ amountCents: 100 });
    const b = bill({ amountCents: 250, dayOfMonth: 1 });
    const due = billsDueBetween([a, b], "2026-09-01", "2026-09-30");
    expect(due.cents).toBe(350);
    expect(due.cycles.map((c) => c.on)).toEqual(["2026-09-01", "2026-09-15"]);
  });

  it("looks fourteen days ahead, today included", () => {
    const soon = billsDueSoon([bill({ dayOfMonth: 14 }), bill({ dayOfMonth: 15 }), bill({ dayOfMonth: 29 })], "2026-09-14");
    expect(soon.cycles.map((c) => c.on)).toEqual(["2026-09-14", "2026-09-15"]);
  });
});

describe("the window's far end", () => {
  it("ends a month on its last day, February included", () => {
    expect(endOfMonth("2026-02-03")).toBe("2026-02-28");
    expect(endOfMonth("2028-02-03")).toBe("2028-02-29");
    expect(endOfMonth("2026-09-14")).toBe("2026-09-30");
  });

  it("reaches forward to the end of the period, where every other figure stops today", () => {
    expect(periodEnd("2026-09-14", "month")).toBe("2026-09-30");
    expect(periodEnd("2026-08-02", "quarter")).toBe("2026-09-30");
    expect(periodEnd("2026-11-20", "quarter")).toBe("2026-12-31");
    expect(periodEnd("2026-03-01", "ytd")).toBe("2026-12-31");
  });
});

describe("checkBill", () => {
  const ok = {
    name: "Liability policy", amountCents: 41_200, cadence: "months", everyMonths: 1, dayOfMonth: 15,
    startsOn: "2026-09-01", endsOn: "", portalUrl: "https://carrier.example/pay",
  };
  it("accepts a bill with no person - most are the company's", () => {
    expect(checkBill(ok)).toBeNull();
  });
  it("refuses a nameless, free, or mis-dated one, in the words the form shows", () => {
    expect(checkBill({ ...ok, name: " " })).toMatch(/Name it/);
    expect(checkBill({ ...ok, amountCents: 0 })).toMatch(/amount/);
    expect(checkBill({ ...ok, startsOn: "" })).toMatch(/starts/);
    expect(checkBill({ ...ok, endsOn: "2026-08-01" })).toMatch(/end before/);
  });
  it("wants a portal link to be a link, and lets it be blank", () => {
    expect(checkBill({ ...ok, portalUrl: "carrier.example" })).toMatch(/https/);
    expect(checkBill({ ...ok, portalUrl: "" })).toBeNull();
  });
});

describe("billAction", () => {
  it("is autopay first, then the pay link, then nothing to press", () => {
    expect(billAction({ autopay: true, portalUrl: "https://x" })).toBe("autopay");
    expect(billAction({ autopay: false, portalUrl: "https://x" })).toBe("pay");
    expect(billAction({ autopay: false, portalUrl: "" })).toBe("note");
  });
});
