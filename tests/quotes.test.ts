// Standing by date, the deposit arithmetic, the sentences under the buttons,
// and the two renewal figures. Pure, no DB.
import { describe, expect, it } from "vitest";
import {
  answerable, approvalConsequence, contractProposal, daysToExpiry, declineConsequence,
  depositCents, quoteStanding, renewalFromBurn, stale,
} from "@/lib/quotes";

const q = (over: Partial<{ status: string; expiresOn: string }> = {}) =>
  ({ status: "sent", expiresOn: "2026-09-21", ...over });

describe("quoteStanding", () => {
  it("expires by date comparison, with no job rewriting rows overnight", () => {
    expect(quoteStanding(q(), "2026-08-22")).toBe("awaiting");
    expect(quoteStanding(q(), "2026-09-22")).toBe("expired");
    // The day it lapses it is still answerable - the client has that day.
    expect(quoteStanding(q(), "2026-09-21")).toBe("awaiting");
  });

  it("lets an answered quote keep its answer whatever the date", () => {
    expect(quoteStanding(q({ status: "approved" }), "2027-01-01")).toBe("approved");
    expect(quoteStanding(q({ status: "declined" }), "2027-01-01")).toBe("declined");
  });

  it("never expires one with no expiry set", () => {
    expect(quoteStanding(q({ expiresOn: "" }), "2030-01-01")).toBe("awaiting");
  });

  it("is answerable only while awaiting", () => {
    expect(answerable(q(), "2026-08-22")).toBe(true);
    expect(answerable(q(), "2026-09-22")).toBe(false);
    expect(answerable(q({ status: "draft" }), "2026-08-22")).toBe(false);
    expect(answerable(q({ status: "approved" }), "2026-08-22")).toBe(false);
  });

  it("counts the days left, and past", () => {
    expect(daysToExpiry("2026-09-21", "2026-08-22")).toBe(30);
    expect(daysToExpiry("2026-08-20", "2026-08-22")).toBe(-2);
    expect(daysToExpiry("", "2026-08-22")).toBeNull();
  });
});

describe("stale", () => {
  it("picks up quotes inside a week of lapsing, and nothing else", () => {
    const rows = [
      { id: 1, status: "sent", expiresOn: "2026-08-26" },   // 4 days out
      { id: 2, status: "sent", expiresOn: "2026-09-30" },   // plenty of time
      { id: 3, status: "sent", expiresOn: "2026-08-01" },   // already lapsed
      { id: 4, status: "approved", expiresOn: "2026-08-24" },
      { id: 5, status: "draft", expiresOn: "2026-08-24" },
    ];
    expect(stale(rows, "2026-08-22").map((r) => r.id)).toEqual([1]);
  });
});

describe("depositCents", () => {
  it("takes a percentage, to the cent", () => {
    expect(depositCents(432000, 50)).toBe(216000);
    expect(depositCents(100033, 33)).toBe(33011);
  });
  it("is nothing at zero, and never more than the whole quote", () => {
    expect(depositCents(432000, 0)).toBe(0);
    expect(depositCents(0, 50)).toBe(0);
    expect(depositCents(432000, 100)).toBe(432000);
    expect(depositCents(432000, 250)).toBe(432000);
  });
});

describe("the sentences under the buttons", () => {
  it("says the deposit will be invoiced, before they press it", () => {
    const s = approvalConsequence({ totalCents: 432000, depositPct: 50, onHold: false, clientName: "Lab Zen" });
    expect(s).toContain("schedules the work and reserves the parts");
    expect(s).toContain("a 50% deposit of $2,160 is invoiced on approval, due immediately");
  });

  it("says nothing about a deposit when there is none", () => {
    const s = approvalConsequence({ totalCents: 432000, depositPct: 0, onHold: false, clientName: "Lab Zen" });
    expect(s).not.toContain("deposit");
  });

  it("says the job will open on hold rather than letting them find out on the day", () => {
    const s = approvalConsequence({ totalCents: 432000, depositPct: 0, onHold: true, clientName: "Coastal" });
    expect(s).toContain("opens on credit hold while Coastal's account is past due");
  });

  it("tells them where a declined reason goes", () => {
    expect(declineConsequence()).toContain("reason is passed to the engineer");
  });
});

describe("renewalFromBurn", () => {
  it("prices from what the term actually cost to serve", () => {
    // 6 visits, 80 hours at $155, $4,900 of parts.
    const r = renewalFromBurn({
      visitsUsed: 6, partsCents: 490000, laborMinutes: 4800, hourlyCents: 15500,
    });
    expect(r.visits).toBe(6);
    expect(r.partsCents).toBe(490000);
    expect(r.valueCents).toBe(1730000);
    expect(r.basis).toBe("6 visits used, 80 h of labor at $155, $4,900 of parts");
  });

  it("applies uplift to the actuals, not to last year's number", () => {
    const r = renewalFromBurn({
      visitsUsed: 6, partsCents: 490000, laborMinutes: 4800, hourlyCents: 15500, upliftBps: 500,
    });
    expect(r.valueCents).toBe(1816500);
    expect(r.basis).toContain("plus 5.0%");
  });

  it("never quotes zero visits, however quiet the term was", () => {
    const r = renewalFromBurn({ visitsUsed: 0, partsCents: 0, laborMinutes: 0, hourlyCents: 15500 });
    expect(r.visits).toBe(1);
    expect(r.valueCents).toBe(0);
  });
});

describe("contractProposal", () => {
  it("annualises the trailing spend and shows both numbers", () => {
    // $13,760 over 11 months.
    const p = contractProposal({
      trailingCents: 1376000, months: 11, visitsPerYear: 4, partsAllowanceCents: 200000,
    });
    expect(p?.trailingAnnualCents).toBe(1501091);
    expect(p?.annualCents).toBe(1275927);
    expect(p?.savingCents).toBe(225164);
    expect(p?.line).toContain("4 visits plus $2,000 of parts");
  });

  it("has nothing to propose without a history", () => {
    expect(contractProposal({ trailingCents: 0, months: 11, visitsPerYear: 4, partsAllowanceCents: 0 })).toBeNull();
    expect(contractProposal({ trailingCents: 100, months: 0, visitsPerYear: 4, partsAllowanceCents: 0 })).toBeNull();
  });

  it("refuses to discount the price away to nothing", () => {
    const p = contractProposal({
      trailingCents: 1200000, months: 12, visitsPerYear: 4,
      partsAllowanceCents: 0, discountBps: 20000,
    });
    expect(p?.annualCents).toBe(120000);
  });
});
