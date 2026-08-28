// Getting paid for handing a client over.
//
// Two instruments with different failure modes. A flat fee is arithmetic; the
// percent case rests on a number that lives in somebody else's database, so
// what is held down here is that the number's PROVENANCE travels with it and
// that a fee which has not started reads differently from one that is over.
import { describe, expect, it } from "vitest";
import {
  accruedCents, feeLine, feeStanding, inWindow, outstandingCents, termsLine,
  termsProblems, windowEnd, MAX_FEE_BPS, type FeeRow, type FeeTerms,
} from "@/lib/referral";
import { formatCents } from "@/lib/money";

const flat = (over: Partial<FeeRow> = {}): FeeRow => ({
  kind: "flat", feeCents: 200_000, feeBps: 0,
  startsOn: "2026-08-28", endsOn: "", billedCents: 0, billedFrom: "invoices",
  paidCents: 0, status: "open", ...over,
});
const pct = (over: Partial<FeeRow> = {}): FeeRow => ({
  kind: "percent", feeCents: 0, feeBps: 500,
  startsOn: "2026-08-28", endsOn: "2027-08-27", billedCents: 0, billedFrom: "invoices",
  paidCents: 0, status: "open", ...over,
});

describe("what is owed", () => {
  it("a flat fee is owed in full the moment it exists", () => {
    expect(accruedCents(flat())).toBe(200_000);
    expect(outstandingCents(flat())).toBe(200_000);
    expect(outstandingCents(flat({ paidCents: 200_000 }))).toBe(0);
  });

  it("a percent is worth nothing until they bill something, and that zero is an answer", () => {
    expect(accruedCents(pct())).toBe(0);
    expect(accruedCents(pct({ billedCents: 4_800_000 }))).toBe(240_000);   // 5% of $48,000
  });

  it("never reports a debt for an overpayment", () => {
    // An overpayment is a credit, not a negative bill - and a duplicate
    // webhook delivery is exactly how one happens.
    expect(outstandingCents(flat({ paidCents: 250_000 }))).toBe(0);
  });

  it("a waived fee is worth nothing, whatever was billed", () => {
    expect(accruedCents(pct({ billedCents: 9_000_000, status: "waived" }))).toBe(0);
  });
});

describe("where a fee stands", () => {
  it("tells a percent that has not started from one that is over", () => {
    /*
     * The distinction the flat case has no use for. A percent with nothing
     * outstanding is not settled - it is waiting for the other shop to do some
     * work - and saying "settled" would tell both sides the arrangement had
     * ended before it began.
     */
    expect(feeStanding(pct(), "2026-09-01")).toBe("accruing");
    expect(feeStanding(pct(), "2027-09-01")).toBe("closed");
    expect(feeStanding(pct({ billedCents: 4_800_000, paidCents: 240_000 }), "2027-09-01")).toBe("settled");
  });

  it("is due whenever money is outstanding, whatever the window says", () => {
    expect(feeStanding(pct({ billedCents: 4_800_000 }), "2026-09-01")).toBe("due");
    expect(feeStanding(flat(), "2026-09-01")).toBe("due");
    expect(feeStanding(flat({ paidCents: 200_000 }), "2026-09-01")).toBe("settled");
  });

  it("keeps a waiver whatever else is true", () => {
    expect(feeStanding(flat({ status: "waived" }), "2026-09-01")).toBe("waived");
  });
});

describe("the window", () => {
  it("ends the day before the anniversary", () => {
    expect(windowEnd("2026-08-28", 12)).toBe("2027-08-27");
    expect(windowEnd("2026-08-28", 6)).toBe("2027-02-27");
  });

  it("clamps rather than sliding into the next month", () => {
    expect(windowEnd("2026-08-31", 6)).toBe("2027-02-27");
  });

  it("has no window without a start", () => {
    expect(windowEnd("", 12)).toBe("");
    expect(windowEnd("2026-08-28", 0)).toBe("");
  });

  it("counts a day in or out", () => {
    expect(inWindow(pct(), "2026-12-01")).toBe(true);
    expect(inWindow(pct(), "2027-09-01")).toBe(false);
    expect(inWindow(pct(), "2026-08-01")).toBe(false);
  });
});

describe("saying where the number came from", () => {
  it("never prints a reported figure as a computed one", () => {
    /*
     * The integrity of the whole percent case. "$48,000 billed" was summed
     * from the payer's own ledger; "$48,000 reported" is a number somebody
     * typed. A line that read the same either way would invite the second to
     * be trusted like the first.
     */
    const computed = feeLine(pct({ billedCents: 4_800_000 }), formatCents);
    const reported = feeLine(pct({ billedCents: 4_800_000, billedFrom: "reported" }), formatCents);
    expect(computed).toContain("billed");
    expect(reported).toContain("reported");
    expect(computed).not.toEqual(reported);
  });

  it("shows the arithmetic, so both sides can check it", () => {
    expect(feeLine(pct({ billedCents: 4_800_000 }), formatCents))
      .toBe("5% of $48,000 billed = $2,400, $2,400 due");
  });

  it("reads a flat fee as the single thing it is", () => {
    expect(feeLine(flat(), formatCents)).toBe("$2,000 due");
    expect(feeLine(flat({ paidCents: 200_000 }), formatCents)).toBe("$2,000 settled");
  });
});

describe("the terms on an offer", () => {
  const terms = (over: Partial<FeeTerms> = {}): FeeTerms =>
    ({ kind: "percent", feeCents: 0, feeBps: 500, windowMonths: 12, note: "", ...over });

  it("says what accepting costs, in words", () => {
    expect(termsLine(terms(), formatCents)).toBe("5% of what you bill them in the first 12 months");
    expect(termsLine(terms({ kind: "flat", feeCents: 200_000 }), formatCents)).toBe("$2,000 to accept");
    expect(termsLine(terms({ kind: "none" }), formatCents)).toBe("No fee");
  });

  it("keeps a half percent readable", () => {
    expect(termsLine(terms({ feeBps: 250 }), formatCents)).toContain("2.5%");
  });

  it("lets an offer carry no fee at all", () => {
    expect(termsProblems(terms({ kind: "none" }))).toEqual([]);
  });

  it("refuses a fee with no number in it", () => {
    expect(termsProblems(terms({ kind: "flat", feeCents: 0 }))[0]).toContain("what it costs");
    expect(termsProblems(terms({ feeBps: 0 }))[0]).toContain("what share");
  });

  it("refuses a share that is really a partnership", () => {
    expect(termsProblems(terms({ feeBps: MAX_FEE_BPS + 1 }))[0]).toContain("under 50%");
  });

  it("refuses a window that is not one", () => {
    expect(termsProblems(terms({ windowMonths: 0 }))[0]).toContain("how long");
    expect(termsProblems(terms({ windowMonths: 120 }))[0]).toContain("under 60 months");
  });
});
