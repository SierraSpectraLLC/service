import { describe, expect, it } from "vitest";
import {
  checkReportTitle, deskReports, editableReport, reimbursementPool, reportPeople, reportSpan,
  reportTitle, reportTotalCents, unsubmittedReport, type PoolExpense,
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

/**
 * The desk, as the owner reads it.
 *
 * The bug these fence off is an ABSENCE, which is the hard kind to keep fixed:
 * the panel used to render the submitted queue and a tail of settled reports,
 * so a draft an engineer opened in March and never sent was visible to nobody
 * but its author. An owner asking "what has my shop got open" was answered
 * "what has been handed to you", and nothing failed - the drafts were fetched,
 * passed down, and quietly filtered out one layer later.
 */
const rep = (over: Partial<{ id: number; person: string; status: string }>) =>
  ({ id: 1, person: "Steve Jones", status: "draft", ...over });

describe("the shop's claims, split the way they get asked about", () => {
  const rows = [
    rep({ id: 1, person: "Steve Jones", status: "draft" }),
    rep({ id: 2, person: "Kate Reyes", status: "submitted" }),
    rep({ id: 3, person: "Steve Jones", status: "returned" }),
    rep({ id: 4, person: "Kate Reyes", status: "paid" }),
    rep({ id: 5, person: "Bill Alvarez", status: "draft" }),
  ];

  it("shows the owner the drafts nobody has sent", () => {
    // The whole point. Two of these five are money the shop owes that nobody
    // has asked for yet, and before this they appeared on no list at all.
    expect(deskReports(rows).filling.map((r) => r.id)).toEqual([1, 3, 5]);
  });

  it("keeps the payout queue to what has actually been handed over", () => {
    // Widening the queue would be the opposite mistake: a draft is not a claim
    // on the owner, and putting one under "Awaiting payout" asks for a check
    // against a report its author is still writing.
    expect(deskReports(rows).awaiting.map((r) => r.id)).toEqual([2]);
    expect(deskReports(rows).paid.map((r) => r.id)).toEqual([4]);
  });

  it("counts a returned claim as still being written, not as settled", () => {
    // Its rows stay ON it and its author fixes it in place, so it is back in
    // their hands - which is where somebody chasing it needs to see it. It
    // used to sit under "Recently settled", beside the paid ones.
    expect(deskReports([rep({ status: "returned" })]).paid).toEqual([]);
    expect(unsubmittedReport("returned")).toBe(true);
    expect(unsubmittedReport("submitted")).toBe(false);
    expect(unsubmittedReport("paid")).toBe(false);
  });

  it("loses nothing - every report lands in exactly one bucket", () => {
    const { awaiting, filling, paid } = deskReports(rows);
    expect([...awaiting, ...filling, ...paid].map((r) => r.id).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("names everybody with a claim, once each, for the filter", () => {
    expect(reportPeople(rows)).toEqual(["Bill Alvarez", "Kate Reyes", "Steve Jones"]);
    expect(reportPeople([rep({ person: "   " })])).toEqual([]);
  });

  it("still agrees with editableReport about which claims are open", () => {
    // Two names for the same pair on purpose - "may I edit this" and "is this
    // still in the engineer's hands" are different questions. If they ever
    // stop matching it should be because somebody meant it.
    for (const s of ["draft", "submitted", "paid", "returned"]) {
      expect(`${s}: ${unsubmittedReport(s)}`).toBe(`${s}: ${editableReport(s)}`);
    }
  });
});

describe("what a claim is called", () => {
  it("insists on a name when one is being set", () => {
    // A desk that shows every claim including the unsent ones is a long list,
    // and three "Steve Jones, Jul 12 - Aug 3" rows are not a list.
    expect(checkReportTitle("  Reno install ")).toEqual({ title: "Reno install" });
    expect(checkReportTitle("   ")).toHaveProperty("error");
    expect(checkReportTitle("")).toHaveProperty("error");
  });

  it("caps a name rather than refusing a long one", () => {
    const got = checkReportTitle("x".repeat(500));
    expect("title" in got && got.title.length).toBe(120);
  });

  it("still reads a report filed before names were required", () => {
    // Nothing that exists becomes wrong. The old identity - person plus the
    // span of its rows - is the fallback, in one place, so the list and the
    // record page cannot call the same claim two things.
    const rows = [{ incurredOn: "2026-07-12" }, { incurredOn: "2026-08-03" }];
    expect(reportTitle({ person: "Steve Jones", title: "" }, rows)).toBe("Steve Jones - Jul 12 - Aug 3");
    expect(reportTitle({ person: "Steve Jones", title: "" }, [])).toBe("Steve Jones - expense report");
    expect(reportTitle({ person: "Steve Jones", title: "Reno install" }, rows)).toBe("Reno install");
  });
});
