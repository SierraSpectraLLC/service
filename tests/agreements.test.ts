import { describe, expect, it } from "vitest";
import {
  allowance, countsAsVisit, daysLeft, drawdown, inTerm, needsAttention, renewalLine, standing,
} from "@/lib/agreements";

const TODAY = "2026-08-16";

const ag = (over: Partial<{
  kind: string; status: string; startsOn: string; endsOn: string; renewNoticeDays: number;
  visitsIncluded: number; partsAllowanceCents: number; laborIncludedMinutes: number;
}> = {}) => ({
  kind: "contract", status: "active", startsOn: "2026-01-01", endsOn: "2026-12-31",
  renewNoticeDays: 60, visitsIncluded: 0, partsAllowanceCents: 0, laborIncludedMinutes: 0, ...over,
});

describe("where an agreement stands today", () => {
  it("is active well inside its term", () => {
    expect(standing(ag(), TODAY)).toBe("active");
  });

  it("is up for renewal once inside the notice window", () => {
    expect(standing(ag({ endsOn: "2026-10-01" }), TODAY)).toBe("expiring");
    // Exactly on the boundary counts - 60 days out with 60 days' notice.
    expect(standing(ag({ endsOn: "2026-10-15" }), TODAY)).toBe("expiring");
    expect(standing(ag({ endsOn: "2026-10-16" }), TODAY)).toBe("active");
  });

  it("expires on the calendar whatever the status column says", () => {
    // Nobody remembers to flip a status field. A contract that ran out in March
    // still reading "Active" in August is the exact failure this is for.
    expect(standing(ag({ status: "active", endsOn: "2026-03-01" }), TODAY)).toBe("expired");
  });

  it("keeps the decisions somebody actually made", () => {
    expect(standing(ag({ status: "draft", endsOn: "2026-03-01" }), TODAY)).toBe("draft");
    expect(standing(ag({ status: "cancelled" }), TODAY)).toBe("cancelled");
  });

  it("treats an open-ended agreement as active and never as expiring", () => {
    expect(standing(ag({ endsOn: "" }), TODAY)).toBe("active");
  });

  it("never nags when notice is switched off", () => {
    expect(standing(ag({ endsOn: "2026-08-20", renewNoticeDays: 0 }), TODAY)).toBe("active");
  });

  it("counts the days left, negative once gone", () => {
    expect(daysLeft("2026-08-20", TODAY)).toBe(4);
    expect(daysLeft("2026-08-16", TODAY)).toBe(0);
    expect(daysLeft("2026-08-01", TODAY)).toBe(-15);
    expect(daysLeft("", TODAY)).toBe(null);
  });
});

describe("which work draws down", () => {
  it("counts a day inside the term", () => {
    expect(inTerm(ag(), "2026-06-01")).toBe(true);
    expect(inTerm(ag(), "2025-12-31")).toBe(false);
    expect(inTerm(ag(), "2027-01-01")).toBe(false);
  });

  it("reads blank dates as since-forever and until-further-notice", () => {
    // Treating a blank as excluding everything would report zero spend against
    // a live allowance, which reads as good news.
    expect(inTerm(ag({ startsOn: "", endsOn: "" }), "1999-01-01")).toBe(true);
    expect(inTerm(ag({ startsOn: "" }), "2020-01-01")).toBe(true);
    expect(inTerm(ag({ endsOn: "" }), "2030-01-01")).toBe(true);
  });

  it("includes the first and last day of the term", () => {
    expect(inTerm(ag(), "2026-01-01")).toBe(true);
    expect(inTerm(ag(), "2026-12-31")).toBe(true);
  });
});

describe("an entitlement drawn down", () => {
  it("reports what is left and how full the bar is", () => {
    const a = allowance(500_000, 314_000);
    expect(a.tracked).toBe(true);
    expect(a.remaining).toBe(186_000);
    expect(a.pct).toBe(63);
    expect(a.over).toBe(false);
  });

  it("goes negative rather than clamping, because overspend is the news", () => {
    const a = allowance(500_000, 620_000);
    expect(a.remaining).toBe(-120_000);
    expect(a.over).toBe(true);
    expect(a.pct).toBe(100);   // the bar is full; the number says how far past
  });

  it("treats zero included as 'not part of this agreement', not as zero allowed", () => {
    // An unlimited-visits contract and a no-visits contract are both real, and
    // the one nobody filled in must not be reported as the second.
    const a = allowance(0, 3);
    expect(a.tracked).toBe(false);
    expect(a.over).toBe(false);
    expect(a.pct).toBe(0);
  });

  it("does all three at once, in the order a person reads them", () => {
    const d = drawdown(
      ag({ partsAllowanceCents: 500_000, visitsIncluded: 4, laborIncludedMinutes: 0 }),
      { partsCents: 250_000, visits: 5, laborMinutes: 900 },
    );
    expect(d.parts.pct).toBe(50);
    expect(d.visits.over).toBe(true);
    expect(d.visits.remaining).toBe(-1);
    expect(d.labor.tracked).toBe(false);
  });
});

describe("what a phone call gets told", () => {
  it("says the count and the date, since somebody reads this on a Friday", () => {
    expect(renewalLine(ag({ endsOn: "2026-08-30" }), TODAY)).toBe("Expires in 14 days, on 2026-08-30.");
    expect(renewalLine(ag({ endsOn: "2026-08-16" }), TODAY)).toBe("Expires today, 2026-08-16.");
    expect(renewalLine(ag({ endsOn: "2026-08-15" }), TODAY)).toBe("Expired 1 day ago, on 2026-08-15.");
    expect(renewalLine(ag({ endsOn: "" }), TODAY)).toBe("Open-ended - no renewal date.");
    expect(renewalLine(ag({ status: "cancelled" }), TODAY)).toBe("Cancelled.");
  });
});

describe("what needs chasing", () => {
  it("puts expired first, then soonest", () => {
    const list = [
      ag({ endsOn: "2026-10-01" }),                 // expiring
      ag({ endsOn: "2026-03-01" }),                 // expired
      ag({ endsOn: "2026-09-01" }),                 // expiring, sooner
      ag({ endsOn: "2027-06-01" }),                 // active
    ];
    expect(needsAttention(list, TODAY).map((a) => a.endsOn))
      .toEqual(["2026-03-01", "2026-09-01", "2026-10-01"]);
  });

  it("never chases a draft or a cancelled one", () => {
    // Emailing a customer about a service they cancelled is worse than silence.
    const list = [
      ag({ status: "draft", endsOn: "2026-03-01" }),
      ag({ status: "cancelled", endsOn: "2026-03-01" }),
    ];
    expect(needsAttention(list, TODAY)).toEqual([]);
  });
});

describe("what counts as a visit", () => {
  it("counts closed work, whatever the severity was", () => {
    expect(countsAsVisit({ severity: "Down", state: "closed" })).toBe(true);
    expect(countsAsVisit({ severity: "Planned", state: "closed" })).toBe(true);
  });

  it("never counts a question", () => {
    // Burning a client's fourth call of the year on a phone answer is the
    // complaint this prevents.
    expect(countsAsVisit({ severity: "Question", state: "closed" })).toBe(false);
    expect(countsAsVisit({ severity: " question ", state: "closed" })).toBe(false);
  });

  it("never counts work that has not been filed", () => {
    expect(countsAsVisit({ severity: "Down", state: "resolved" })).toBe(false);
    expect(countsAsVisit({ severity: "Down", state: "active" })).toBe(false);
    expect(countsAsVisit({ severity: "Down", state: "cancelled" })).toBe(false);
  });
});
