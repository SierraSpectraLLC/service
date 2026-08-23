// Composing an invoice from the work. The rules under test are the ones that
// cost money when they are wrong: what the contract absorbs, what "beyond
// contract" bills, what gets taxed, and the fact that no total is ever stored.
import { describe, expect, it } from "vitest";
import {
  NO_COVERAGE, buildInvoiceLines, coveredValue, invoiceBalance, jobCost, lineAmount,
  linesTotal, payableNow, poCheck, type CoverageAnswer, type PartRow,
} from "@/lib/billing";
import { FALLBACK_RATE, type RateCard } from "@/lib/rates";

const rate: RateCard = { ...FALLBACK_RATE, hourlyCents: 16000, travelPct: 50, minIncrementMin: 15 };
const part = (over: Partial<PartRow> = {}): PartRow =>
  ({ id: 1, name: "Filament assembly", partNumber: "1R120427-0160", qty: 1, costCents: 41000, ...over });
const time = (over: Partial<{ id: number; minutes: number; category: string; billable: boolean }> = {}) =>
  ({ id: 1, minutes: 540, category: "onsite", billable: true, person: "Joe", date: "2026-08-19", note: "", ...over });
const covered = (over: Partial<CoverageAnswer> = {}): CoverageAnswer =>
  ({ agreementNumber: "LZ-2026", agreementId: 42, labor: true, parts: false, exhausted: false, ...over });

const build = (over: Partial<Parameters<typeof buildInvoiceLines>[0]> = {}) => buildInvoiceLines({
  parts: [part()], time: [time()], expenses: [], rate, coverage: NO_COVERAGE,
  sellCents: () => 54000, ...over,
});

describe("what lands on the invoice", () => {
  it("prices parts from the book and hours at the card", () => {
    const lines = build();
    expect(lines.map((l) => l.kind)).toEqual(["part", "labor"]);
    expect(lineAmount(lines[0])).toBe(54000);
    expect(lines[1].qty).toBe(9);
    expect(lineAmount(lines[1])).toBe(144000);
    expect(linesTotal(lines)).toBe(198000);
  });

  it("groups hours by category and gives travel its own line at its own rate", () => {
    const lines = build({
      time: [time({ minutes: 300 }), time({ id: 2, minutes: 240 }), time({ id: 3, minutes: 60, category: "travel" })],
    });
    const labor = lines.find((l) => l.kind === "labor")!;
    const travel = lines.find((l) => l.kind === "travel")!;
    expect(labor.qty).toBe(9);            // 300 + 240 minutes, rounded once
    expect(travel.unitCents).toBe(8000);  // half the 160 rate
    expect(lineAmount(travel)).toBe(8000);
  });

  it("leaves unbillable hours off the bill without losing them from the record", () => {
    const lines = build({ time: [time({ billable: false })] });
    expect(lines.some((l) => l.kind === "labor")).toBe(false);
  });

  it("bills expenses at what they cost, once each", () => {
    const lines = build({ expenses: [{ id: 5, kind: "mileage", description: "Mileage, 62 mi", amountCents: 4300 }] });
    const e = lines.find((l) => l.kind === "expense")!;
    expect(e.qty).toBe(1);
    expect(lineAmount(e)).toBe(4300);
  });
});

describe("the covered case - a $0 invoice is a feature", () => {
  it("zeroes covered labor, keeps its list price, and names the paper", () => {
    const lines = build({ coverage: covered() });
    const labor = lines.find((l) => l.kind === "labor")!;
    expect(labor.covered).toBe(true);
    expect(labor.coveredBy).toBe("LZ-2026");
    expect(labor.unitCents).toBe(16000);   // what it would have cost
    expect(lineAmount(labor)).toBe(0);     // what it costs them
    expect(linesTotal(lines)).toBe(54000); // the parts still bill
  });

  it("reports the list value the agreement absorbed, for the burn-down", () => {
    const lines = build({ coverage: covered({ parts: true }) });
    expect(linesTotal(lines)).toBe(0);
    expect(coveredValue(lines)).toBe(198000);
  });

  it("bills at the card and says beyond contract once the allowance is spent", () => {
    const lines = build({ coverage: covered({ parts: true, exhausted: true }) });
    expect(lines.every((l) => !l.covered)).toBe(true);
    expect(linesTotal(lines)).toBe(198000);
    expect(lines[0].description).toContain("beyond contract");
  });
});

describe("tax", () => {
  it("taxes the parts that were actually sold, and nothing else", () => {
    const lines = build({ taxRateBps: 775, expenses: [{ id: 5, kind: "other", description: "Freight", amountCents: 10000 }] });
    const tax = lines.find((l) => l.kind === "tax")!;
    expect(lineAmount(tax)).toBe(4185); // 7.75% of the 540.00 part, not the labor or freight
  });

  it("does not tax a part the contract absorbed, and draws no line at zero", () => {
    const carried = build({ taxRateBps: 775, coverage: covered({ parts: true }) });
    expect(carried.some((l) => l.kind === "tax")).toBe(false);
    expect(build({ taxRateBps: 0 }).some((l) => l.kind === "tax")).toBe(false);
  });
});

describe("what is owed", () => {
  it("sums lines plus fees less payments, storing nothing", () => {
    const b = invoiceBalance({
      lines: [{ qty: 1, unitCents: 118000, covered: false }],
      feeCents: [5800], paidCents: [50000],
    });
    expect(b).toEqual({ linesCents: 118000, feesCents: 5800, paidCents: 50000, balanceCents: 73800 });
  });

  it("asks only for the undisputed remainder", () => {
    expect(payableNow({ balanceCents: 118000, disputedCents: 34000 })).toBe(84000);
    expect(payableNow({ balanceCents: 34000, disputedCents: 90000 })).toBe(0);
  });
});

describe("the two silent AP rejections", () => {
  it("warns when there is no PO to quote", () => {
    expect(poCheck({ poNumber: "", poBalanceCents: 0 }, 290400)).toContain("No PO on file");
  });

  it("warns when the PO would not cover it, and stays quiet when it would", () => {
    expect(poCheck({ poNumber: "PO-2026-0411", poBalanceCents: 100000 }, 290400)).toContain("short of this invoice");
    expect(poCheck({ poNumber: "PO-2026-0411", poBalanceCents: 620000 }, 290400)).toBe("");
  });

  it("never blocks - it returns a sentence, not a refusal", () => {
    expect(typeof poCheck({ poNumber: "", poBalanceCents: 0 }, 1)).toBe("string");
  });
});

describe("job cost", () => {
  it("costs labor loaded, not at the wage", () => {
    const c = jobCost({
      lines: build(), partsCostCents: 98000, billedMinutes: 540,
      loadedLaborCents: 9500, expensesCents: 4300,
    });
    expect(c.billedCents).toBe(198000);
    expect(c.costCents).toBe(187800); // 98000 parts + 85500 loaded labor + 4300
    expect(c.marginPct).toBe(5);
  });

  it("reports no margin rather than dividing by zero on a covered job", () => {
    const c = jobCost({ lines: [], partsCostCents: 0, billedMinutes: 0, loadedLaborCents: 9500, expensesCents: 0 });
    expect(c.marginPct).toBe(0);
  });
});
