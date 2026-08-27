// Standing by date, the deposit arithmetic, the sentences under the buttons,
// and the two renewal figures. Pure, no DB.
import { describe, expect, it } from "vitest";
import {
  answerable, approvalConsequence, contractProposal, daysToExpiry, declineConsequence,
  depositCents, hasPace, paceShortfall, PACE_MIN_INVOICES, PACE_MIN_MONTHS,
  quoteStanding, renewalFromBurn, stale, trailingUsage,
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

const line = (over: Partial<{ kind: string; qty: number; unitCents: number; covered: boolean }> = {}) =>
  ({ kind: "labor", qty: 1000, unitCents: 18500, covered: false, ...over });

describe("trailingUsage", () => {
  it("reads the visits, the parts and the labor off their own invoices", () => {
    const u = trailingUsage({
      today: "2026-08-27",
      invoices: [
        { issuedOn: "2026-02-01", workOrderId: 7, lines: [
          line({ kind: "labor", qty: 4500 }),                       // 4.5 h at $185
          line({ kind: "part", qty: 1000, unitCents: 39000 }),      // $390
        ] },
        { issuedOn: "2026-05-01", workOrderId: 7, lines: [          // the SAME job again
          line({ kind: "labor", qty: 2000 }),
        ] },
        { issuedOn: "2026-08-01", workOrderId: 9, lines: [
          line({ kind: "travel", qty: 1000, unitCents: 12000 }),
        ] },
      ],
    });
    // Two distinct jobs, not three invoices: a job re-invoiced is one visit.
    expect(u.visits).toBe(2);
    expect(u.invoices).toBe(3);
    expect(u.partsCents).toBe(39000);
    expect(u.laborMinutes).toBe(390);          // 6.5 h
    expect(u.trailingCents).toBe(83250 + 37000 + 39000 + 12000);
    expect(u.months).toBe(7);                  // Feb 1 to Aug 27
  });

  it("counts nothing a contract already paid for", () => {
    // The one card whose job is comparing contract against T&M must not put
    // contract-covered work on the T&M side of it.
    const u = trailingUsage({
      today: "2026-08-27",
      invoices: [{ issuedOn: "2026-01-01", workOrderId: 1, lines: [
        line({ kind: "labor", qty: 4000, covered: true }),
        line({ kind: "part", qty: 1000, unitCents: 5000 }),
      ] }],
    });
    expect(u.trailingCents).toBe(5000);
    expect(u.partsCents).toBe(5000);
    expect(u.laborMinutes).toBe(0);
  });

  it("has no months and no visits for a client never invoiced", () => {
    const u = trailingUsage({ today: "2026-08-27", invoices: [] });
    expect(u).toEqual({ months: 0, invoices: 0, visits: 0, partsCents: 0, laborMinutes: 0, trailingCents: 0 });
  });
});

describe("contractProposal", () => {
  const usage = (over: Partial<ReturnType<typeof trailingUsage>> = {}) => ({
    months: 11, invoices: 6, visits: 3, partsCents: 108000, laborMinutes: 2400,
    trailingCents: 1376000, ...over,
  });

  it("offers the client's own pace back to them, not a house template", () => {
    // $13,760 over 11 months, 3 visits, $1,080 of parts.
    const p = contractProposal({ usage: usage() });
    // To the dollar: these are projections, not money that moved.
    expect(p?.trailingAnnualCents).toBe(1501100);
    expect(p?.annualCents).toBe(1275900);
    expect(p?.savingCents).toBe(225200);
    // Annualised from THEIR numbers: 3 visits over 11 months is 3/yr, and
    // $1,080 of parts is $1,178.
    expect(p?.visitsPerYear).toBe(3);
    expect(p?.partsAllowanceCents).toBe(117800);
    expect(p?.line).toBe(
      "Their own pace over 11 months: 3 visits plus $1,178 of parts a year, "
      + "against $15,011 of time and materials. A contract covering that at $12,759 - 15% off.",
    );
    // The one number that is a policy rather than an observation is named.
    expect(p?.line).toContain("15% off");
  });

  it("offers no parts allowance to a client who has bought no parts", () => {
    /*
     * The whole bug, in one assertion. The card used to promise every client
     * "$2,000 of parts" whether or not they had ever bought a part, because
     * the figure was a literal on the page rather than anything about them.
     */
    const p = contractProposal({ usage: usage({ partsCents: 0 }) });
    expect(p?.partsAllowanceCents).toBe(0);
    expect(p?.line).not.toContain("parts");
  });

  it("still quotes a visit for a client who has only ever bought parts", () => {
    // A contract with zero visits in it is a contract nobody signs. Parts get
    // no such floor - see the function.
    const p = contractProposal({ usage: usage({ visits: 0 }) });
    expect(p?.visitsPerYear).toBe(1);
  });

  it("will not read a pace off one invoice", () => {
    /*
     * The number that was on screen: a single $20,000 invoice, one month of
     * history, annualised to $240,000 a year and then priced against. Twelve
     * times one invoice is not a pace, and a proposal built on it is one
     * nobody can defend in the room.
     */
    const thin = usage({ months: 1, invoices: 1, trailingCents: 2000000 });
    expect(contractProposal({ usage: thin })).toBeNull();
    expect(paceShortfall(thin)).toBe("Too little to price a contract off - 1 invoice, 1 month of history.");
  });

  it("will not read a pace off a fortnight either", () => {
    const thin = usage({ months: 0, invoices: 4 });
    expect(contractProposal({ usage: thin })).toBeNull();
    expect(paceShortfall(thin)).toContain("under a month of history");
  });

  it("says nothing is short once there is enough of both", () => {
    expect(paceShortfall(usage())).toBeNull();
    expect(hasPace(usage())).toBe(true);
    // Exactly at the threshold, which is where an off-by-one would live.
    expect(hasPace(usage({ months: PACE_MIN_MONTHS, invoices: PACE_MIN_INVOICES }))).toBe(true);
    expect(hasPace(usage({ months: PACE_MIN_MONTHS - 1, invoices: PACE_MIN_INVOICES }))).toBe(false);
  });

  it("has nothing to propose without a history", () => {
    expect(contractProposal({ usage: usage({ trailingCents: 0 }) })).toBeNull();
  });

  it("refuses to discount the price away to nothing", () => {
    const p = contractProposal({
      usage: usage({ months: 12, trailingCents: 1200000 }), discountBps: 20000,
    });
    expect(p?.annualCents).toBe(120000);
  });
});