import { describe, expect, it } from "vitest";
import {
  reimbursementPool, reportSpan, reportTotalCents, type PoolExpense,
} from "@/lib/expenseReports";

/**
 * Who may claim what. The failure this fences off is the quiet one: the same
 * receipt on two reports, or one engineer's lunch paid out to another.
 */

const row = (p: Partial<PoolExpense>): PoolExpense => ({
  id: 1, kind: "Fuel", description: "Gas", amountCents: 4500, incurredOn: "2026-08-10",
  billable: true, workOrderId: 7, person: "", loggedBy: "kate@shop.test", reportId: null, ...p,
});
const KATE = { name: "Kate Reyes", email: "kate@shop.test" };

describe("the reimbursement pool", () => {
  it("claims rows that name me, however the name is cased", () => {
    expect(reimbursementPool([row({ person: "Kate Reyes", loggedBy: "owner@shop.test" })], KATE)).toHaveLength(1);
    expect(reimbursementPool([row({ person: "kate reyes", loggedBy: "" })], KATE)).toHaveLength(1);
  });

  it("claims job rows I logged that name nobody else", () => {
    expect(reimbursementPool([row({})], KATE)).toHaveLength(1);
  });

  it("never claims another person's row, even one I logged", () => {
    // An admin logging Bill's hotel logs it FOR Bill - it is Bill's money.
    expect(reimbursementPool([row({ person: "Bill Alvarez", loggedBy: "kate@shop.test" })], KATE)).toHaveLength(0);
    expect(reimbursementPool([row({ loggedBy: "owner@shop.test" })], KATE)).toHaveLength(0);
  });

  it("never claims a row already on a report - that money is spoken for", () => {
    expect(reimbursementPool([row({ reportId: 4 })], KATE)).toHaveLength(0);
  });
});

describe("report arithmetic", () => {
  it("totals the rows and nothing else", () => {
    expect(reportTotalCents([row({ amountCents: 4500 }), row({ amountCents: 1200 })])).toBe(5700);
    expect(reportTotalCents([])).toBe(0);
  });

  it("reads a report as its period", () => {
    expect(reportSpan([
      { incurredOn: "2026-08-03" }, { incurredOn: "2026-07-12" }, { incurredOn: "2026-08-01" },
    ])).toBe("Jul 12 - Aug 3");
    expect(reportSpan([{ incurredOn: "2026-08-03" }])).toBe("Aug 3");
    expect(reportSpan([])).toBe("");
  });
});
