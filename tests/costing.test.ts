// Margin, and what it cost to be owed the money. Pure, no DB.
import { describe, expect, it } from "vitest";
import {
  clientMargin, daysToPay, inWindow, jobMargin, short, SLOW_PAY_DAYS,
  type JobRow,
} from "@/lib/costing";

const job = (over: Partial<JobRow> = {}): JobRow => ({
  woId: 1, number: "WO-0398", title: "ISQ source rebuild",
  orgId: 1, orgName: "Lab Zen", closedOn: "2026-08-17", coveredBy: "",
  billedCents: 290400, partsCostCents: 98000, billedMinutes: 540, expensesCents: 4300,
  ...over,
});

describe("jobMargin", () => {
  it("costs an hour at the loaded rate, not the wage", () => {
    // 9 h at $95 loaded = $855, plus $980 parts and $43 expenses = $1,878.
    const m = jobMargin(job(), 9500);
    expect(m.costCents).toBe(187800);
    expect(m.marginCents).toBe(102600);
    expect(m.marginPct).toBe(35);
    expect(m.tone).toBe("good");
  });

  it("reports a covered job against its agreement rather than as a total loss", () => {
    // A $0 invoice is not a 100% loss - the value belongs to the contract, and
    // counting it that way would make the retainer look like the worst work in
    // the shop.
    const m = jobMargin(job({ billedCents: 0, coveredBy: "AGR-2026-01" }), 9500);
    expect(m.marginPct).toBeNull();
    expect(m.note).toBe("vs AGR-2026-01");
    expect(m.tone).toBe("info");
  });

  it("refuses to report a percentage when nobody has priced an hour", () => {
    const m = jobMargin(job(), 0);
    expect(m.marginPct).toBeNull();
    expect(m.note).toBe("no loaded labor rate set");
  });

  it("says so rather than dividing by zero on a job that billed nothing", () => {
    const m = jobMargin(job({ billedCents: 0 }), 9500);
    expect(m.marginPct).toBeNull();
    expect(m.note).toBe("nothing billed");
  });

  it("flags a thin or negative job", () => {
    expect(jobMargin(job({ billedCents: 200000 }), 9500).tone).toBe("warn");
    expect(jobMargin(job({ billedCents: 100000 }), 9500).tone).toBe("bad");
    expect(jobMargin(job({ billedCents: 100000 }), 9500).marginPct).toBeLessThan(0);
  });

  it("costs a job with no hours on it out of parts and expenses alone", () => {
    const m = jobMargin(job({ billedMinutes: 0 }), 0);
    expect(m.costCents).toBe(102300);
    expect(m.marginPct).toBe(65);
  });
});

describe("daysToPay", () => {
  it("weights by amount, because dollars are what the shop finances", () => {
    // Five small same-day invoices and one big ninety-day one is a ninety-day
    // client; a plain mean would call them a fifteen-day one.
    const rows = [
      ...Array.from({ length: 5 }, () => ({ issuedOn: "2026-06-01", paidOn: "2026-06-01", amountCents: 20000 })),
      { issuedOn: "2026-06-01", paidOn: "2026-08-30", amountCents: 4000000 },
    ];
    // 90 days on $40,000 and nothing on $1,000 of small ones: 88, not the 15
    // a plain mean would give.
    expect(daysToPay(rows)).toBe(88);
  });

  it("is null when nothing has been paid yet", () => {
    expect(daysToPay([])).toBeNull();
    expect(daysToPay([{ issuedOn: "2026-06-01", paidOn: "", amountCents: 100 }])).toBeNull();
  });

  it("never reports a negative, however the dates land", () => {
    expect(daysToPay([{ issuedOn: "2026-08-10", paidOn: "2026-08-01", amountCents: 100 }])).toBe(0);
  });

  it("ignores rows it cannot read", () => {
    expect(daysToPay([
      { issuedOn: "nonsense", paidOn: "2026-08-01", amountCents: 100 },
      { issuedOn: "2026-07-01", paidOn: "2026-07-11", amountCents: 100 },
    ])).toBe(10);
  });
});

describe("clientMargin", () => {
  const base = {
    orgId: 2, orgName: "Coastal Analytical", terms: "T&M · net 30", openCents: 0,
    paid: [{ issuedOn: "2026-05-01", paidOn: "2026-07-07", amountCents: 930000 }],
  };

  it("leaves covered jobs out of the percentage", () => {
    const c = clientMargin({
      ...base,
      jobs: [
        jobMargin(job({ billedCents: 290400 }), 9500),
        jobMargin(job({ woId: 2, billedCents: 0, coveredBy: "AGR-2026-01" }), 9500),
      ],
    });
    // Only the billable job counts toward the margin; both count as jobs.
    expect(c.billedCents).toBe(290400);
    expect(c.marginPct).toBe(35);
    expect(c.jobs).toBe(2);
  });

  it("puts days-to-pay beside the margin and says something when they disagree", () => {
    const c = clientMargin({ ...base, jobs: [jobMargin(job({ billedCents: 290400 }), 9500)] });
    expect(c.daysToPay).toBe(67);
    expect(c.daysToPay).toBeGreaterThanOrEqual(SLOW_PAY_DAYS);
    expect(c.note).toContain("35% margin that costs 67 days of float");
    expect(c.note).toContain("propose a contract");
  });

  it("says nothing when a good margin is also paid promptly", () => {
    const c = clientMargin({
      ...base,
      paid: [{ issuedOn: "2026-07-01", paidOn: "2026-07-12", amountCents: 100000 }],
      jobs: [jobMargin(job({ billedCents: 290400 }), 9500)],
    });
    expect(c.daysToPay).toBe(11);
    expect(c.note).toBe("");
  });

  it("has no percentage for a client whose work was all covered", () => {
    const c = clientMargin({
      ...base, paid: [],
      jobs: [jobMargin(job({ billedCents: 0, coveredBy: "AGR-2026-01" }), 9500)],
    });
    expect(c.marginPct).toBeNull();
    expect(c.note).toBe("");
  });
});

describe("presentation helpers", () => {
  it("shortens a figure meant to be scanned, not reconciled", () => {
    expect(short(4120000)).toBe("$41.2k");
    expect(short(930000)).toBe("$9.3k");
    expect(short(45000)).toBe("$450");
    expect(short(-412000)).toBe("-$4.1k");
  });

  it("knows what closed inside the window", () => {
    expect(inWindow("2026-08-17", "2026-08-23", 30)).toBe(true);
    expect(inWindow("2026-06-17", "2026-08-23", 30)).toBe(false);
    expect(inWindow("2026-06-17", "2026-08-23", 90)).toBe(true);
    // 98 days out is past the 90-day window too.
    expect(inWindow("2026-05-17", "2026-08-23", 90)).toBe(false);
    // A close date in the future is not in any window.
    expect(inWindow("2026-09-01", "2026-08-23", 30)).toBe(false);
    expect(inWindow("", "2026-08-23", 30)).toBe(false);
  });
});
