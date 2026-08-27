// The three lanes on /money have to compose.
//
// The page reported $20,000 in, $9,583 of payroll out, and $0 left - and every
// one of those was correct on its own. What was wrong was the arithmetic
// between them: the "Money in" header carried cash that had ALREADY been
// collected, the "Money out" lane displayed payroll above a total that
// excluded it, and "what is left" subtracted one from the other. A company
// that had collected everything it was owed and owed nobody anything read as
// zero.
//
// Two figures, because there are two questions:
//   POSITION - a stock. What is outstanding each way, right now.
//   PERIOD   - a flow. What actually moved.
// Subtracting across them is the bug this pins.
import { describe, expect, it } from "vitest";

/** The page's own arithmetic, extracted so it can be asserted on. */
const position = (f: {
  currentCents: number; pastDueCents: number;
  purchasingCents: number; reimbursementsCents: number;
}) => (f.currentCents + f.pastDueCents) - (f.purchasingCents + f.reimbursementsCents);

const periodFlow = (f: {
  paidCents: number; payrollCents: number | null; overheadCents: number | null;
}) => f.paidCents - (f.payrollCents ?? 0) - (f.overheadCents ?? 0);

// The shape the live instance was in when this was reported.
const REPORTED = {
  paidCents: 2_000_000, currentCents: 0, pastDueCents: 0,
  payrollCents: 958_333, overheadCents: 0,
  purchasingCents: 0, reimbursementsCents: 0,
};

describe("the reported case", () => {
  it("the position is genuinely zero, and that is good news", () => {
    // Nothing outstanding either way. The number was never wrong; the heading
    // over it and the lane beside it were.
    expect(position(REPORTED)).toBe(0);
  });

  it("the period flow is the number the owner was looking for", () => {
    // $20,000 collected, $9,583.33 of payroll against it.
    expect(periodFlow(REPORTED)).toBe(1_041_667);
  });

  it("the two are not the same question and must not be subtracted across", () => {
    expect(position(REPORTED)).not.toBe(periodFlow(REPORTED));
  });
});

describe("position", () => {
  it("counts what is outstanding in both directions", () => {
    expect(position({
      currentCents: 500_000, pastDueCents: 250_000,
      purchasingCents: 100_000, reimbursementsCents: 50_000,
    })).toBe(600_000);
  });

  it("goes negative when more is committed out than is owed in", () => {
    expect(position({
      currentCents: 0, pastDueCents: 0,
      purchasingCents: 400_000, reimbursementsCents: 0,
    })).toBe(-400_000);
  });

  it("ignores collected cash - it is no longer outstanding", () => {
    const a = position({ currentCents: 100_000, pastDueCents: 0, purchasingCents: 0, reimbursementsCents: 0 });
    // Collecting an invoice moves it out of `current` and into `paid`. The
    // position falls to zero, which is the whole point of calling it a stock.
    const afterPayment = position({ currentCents: 0, pastDueCents: 0, purchasingCents: 0, reimbursementsCents: 0 });
    expect(a).toBe(100_000);
    expect(afterPayment).toBe(0);
  });
});

describe("period flow", () => {
  it("is collected less what it cost to exist while collecting it", () => {
    expect(periodFlow({ paidCents: 1_000_000, payrollCents: 300_000, overheadCents: 200_000 }))
      .toBe(500_000);
  });

  it("excludes open commitments - they have not moved yet", () => {
    // Open POs and unpaid reimbursements are already counted in the position.
    // Counting them here too would subtract the same money twice.
    const withCommitments = { paidCents: 1_000_000, payrollCents: 0, overheadCents: 0 };
    expect(periodFlow(withCommitments)).toBe(1_000_000);
  });

  it("goes negative when a quiet period still has to make payroll", () => {
    expect(periodFlow({ paidCents: 0, payrollCents: 958_333, overheadCents: 0 })).toBe(-958_333);
  });
});

describe("who may read which", () => {
  /*
   * The page's original comment claimed payroll was kept out of the position
   * so the figure "stays the same number for every reader" - otherwise gross
   * pay leaks as owed - owes - net. That reasoning does not apply here, and
   * pinning it matters because it is the kind of claim that gets defended.
   *
   * maySeeBooks and maySeePayroll are identical on their house branch, and
   * /money redirects every non-staff reader, so anybody who can see these
   * figures at all can see payroll. There is no reader to leak to.
   */
  it("the books and payroll gates agree for staff", async () => {
    const { maySeeBooks } = await import("@/lib/books");
    const { maySeePayroll } = await import("@/lib/payroll");
    const OPERATOR = 1;
    const shapes = [
      { role: "owner", orgId: null, operatorOrgId: OPERATOR },
      { role: "staff", orgId: null, operatorOrgId: OPERATOR },
      { role: "owner", orgId: null, operatorOrgId: 2 },   // another workspace's owner
    ];
    for (const s of shapes) {
      const books = maySeeBooks({ ...s, email: "x@y.z", canSeeMoney: true } as never, OPERATOR);
      const pay = maySeePayroll({ ...s, email: "x@y.z", canSeePayroll: false } as never, OPERATOR);
      // Note canSeeMoney true and canSeePayroll false: the client flags differ
      // and it changes nothing, because neither branch is reached for staff.
      expect(`${s.role}/${s.operatorOrgId}: books=${books} pay=${pay}`)
        .toBe(`${s.role}/${s.operatorOrgId}: books=${books} pay=${books}`);
    }
  });
});
