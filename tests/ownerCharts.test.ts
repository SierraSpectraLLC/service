// The arithmetic behind the owner view's charts.
//
// Worth pinning because a chart is read faster than it is checked. A table of
// wrong numbers gets queried by the person reading it; a line that slopes the
// wrong way just becomes what somebody believes about their business.
//
// The one that matters most is the two-dates rule in cashByMonth: an invoice
// counts in the month it was issued and a payment in the month it arrived, so
// the gap between the lines is the collection lag. Count a payment against its
// invoice's month instead and the chart flattens that gap to nothing and says
// the business is paid the day it bills.
import { describe, expect, it } from "vitest";
import {
  bands, cashByMonth, labelFits, lastMonths, monthLabel, niceTicks, topDebtors,
  type CashInvoice,
} from "@/lib/ownerCharts";
import { ladder, inkOn, RAMP, SERIES } from "@/lib/chartPalette";

describe("the months on the axis", () => {
  it("ends at today's month and runs back, oldest first", () => {
    expect(lastMonths("2026-08-27", 3)).toEqual(["2026-06", "2026-07", "2026-08"]);
  });

  it("crosses a year boundary", () => {
    expect(lastMonths("2026-02-14", 4)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });

  it("names the year where it turns, and nowhere else", () => {
    // Twelve unlabelled month names on one axis is an axis that does not say
    // which December. One label carries it.
    expect(monthLabel("2026-08")).toBe("Aug");
    expect(monthLabel("2026-01")).toBe("Jan 26");
  });
});

describe("billed against collected", () => {
  const inv = (over: Partial<CashInvoice> = {}): CashInvoice => ({
    issuedOn: "2026-06-10", status: "sent", billedCents: 100000, payments: [], ...over,
  });
  const MONTHS = ["2026-06", "2026-07", "2026-08"];

  it("counts an invoice in the month it went out and its payment in the month it landed", () => {
    /*
     * The whole point of the chart. Billed in June, paid in August: two months
     * of lag, visible as the space between the lines. Counting the payment in
     * June - against its invoice - would draw two identical lines and say the
     * shop is paid the day it bills.
     */
    const got = cashByMonth([inv({ payments: [{ receivedOn: "2026-08-03", amountCents: 100000 }] })], MONTHS);
    expect(got.map((m) => m.billedCents)).toEqual([100000, 0, 0]);
    expect(got.map((m) => m.collectedCents)).toEqual([0, 0, 100000]);
  });

  it("splits a part payment across the months it actually arrived in", () => {
    const got = cashByMonth([inv({
      payments: [
        { receivedOn: "2026-07-02", amountCents: 40000 },
        { receivedOn: "2026-08-19", amountCents: 60000 },
      ],
    })], MONTHS);
    expect(got.map((m) => m.collectedCents)).toEqual([0, 40000, 60000]);
  });

  it("bills nothing for a draft or a void", () => {
    // A draft has not been sent to anybody and a void has been withdrawn.
    const got = cashByMonth([inv({ status: "draft" }), inv({ status: "void" })], MONTHS);
    expect(got.map((m) => m.billedCents)).toEqual([0, 0, 0]);
  });

  it("still counts money that arrived against a voided invoice", () => {
    // Rare, and real: a payment landed and the bill was withdrawn afterwards.
    // The money arrived. A cash line that hides it is not a cash line.
    const got = cashByMonth([inv({
      status: "void", payments: [{ receivedOn: "2026-07-11", amountCents: 25000 }],
    })], MONTHS);
    expect(got.map((m) => m.billedCents)).toEqual([0, 0, 0]);
    expect(got.map((m) => m.collectedCents)).toEqual([0, 25000, 0]);
  });

  it("drops what falls outside the window rather than piling it on the edge", () => {
    // An invoice from two years ago must not land on the first month of the
    // chart - that is a spike the business never had.
    const got = cashByMonth([inv({ issuedOn: "2024-01-05" })], MONTHS);
    expect(got.map((m) => m.billedCents)).toEqual([0, 0, 0]);
  });

  it("ignores an invoice with no issue date at all", () => {
    const got = cashByMonth([inv({ issuedOn: "" })], MONTHS);
    expect(got.map((m) => m.billedCents)).toEqual([0, 0, 0]);
  });
});

describe("who owes the most", () => {
  const name = (id: number) => ({ 1: "LabZen", 2: "UCSF", 3: "InterVenn", 4: "Emery" }[id] ?? "?");

  it("sums each client's open invoices and ranks them", () => {
    const got = topDebtors([
      { orgId: 1, balanceCents: 50000 },
      { orgId: 2, balanceCents: 90000 },
      { orgId: 1, balanceCents: 70000 },
    ], name);
    expect(got.top.map((d) => [d.name, d.cents, d.invoices]))
      .toEqual([["LabZen", 120000, 2], ["UCSF", 90000, 1]]);
  });

  it("sums the tail rather than dropping it", () => {
    /*
     * A top-six that silently omits eleven small accounts answers "who owes
     * us" wrongly, and wrongly in the direction that matters - it makes the
     * book look smaller and more concentrated than it is.
     */
    const rows = Array.from({ length: 9 }, (_, i) => ({ orgId: i + 1, balanceCents: (9 - i) * 1000 }));
    const got = topDebtors(rows, (id) => `Org ${id}`, 6);
    expect(got.top).toHaveLength(6);
    expect(got.restCount).toBe(3);
    expect(got.restCents).toBe(3000 + 2000 + 1000);
  });

  it("leaves out a credit balance", () => {
    // A client in credit is not a debtor, and a negative bar has nowhere to go
    // on a chart that starts at zero.
    const got = topDebtors([{ orgId: 1, balanceCents: -5000 }, { orgId: 2, balanceCents: 100 }], name);
    expect(got.top.map((d) => d.name)).toEqual(["UCSF"]);
  });

  it("breaks a tie by name so the order does not wobble between renders", () => {
    const got = topDebtors([{ orgId: 3, balanceCents: 100 }, { orgId: 4, balanceCents: 100 }], name);
    expect(got.top.map((d) => d.name)).toEqual(["Emery", "InterVenn"]);
  });
});

describe("the axis ticks", () => {
  it("rounds up to something a person can read", () => {
    expect(niceTicks(23817).ticks).toEqual([0, 10000, 20000, 30000]);
    expect(niceTicks(4).ticks).toEqual([0, 1, 2, 3, 4]);
  });

  it("always reaches at least the largest value", () => {
    for (const max of [1, 37, 999, 1001, 84321, 2_500_000]) {
      expect(niceTicks(max).top).toBeGreaterThanOrEqual(max);
    }
  });

  it("has one tick and no scale when there is nothing to plot", () => {
    expect(niceTicks(0)).toEqual({ top: 0, ticks: [0] });
    expect(niceTicks(-5)).toEqual({ top: 0, ticks: [0] });
  });
});

describe("the bands of a stacked bar", () => {
  it("drops the empty ones and shares out the rest", () => {
    /*
     * An empty band is a segment nobody can see wearing a label nobody can
     * read - and on this bar it is also a 2px gap with nothing between it and
     * the next gap, which reads as a rendering fault.
     */
    const got = bands([
      { key: "a", label: "A", cents: 7500 },
      { key: "b", label: "B", cents: 0 },
      { key: "c", label: "C", cents: 2500 },
    ]);
    expect(got.shown.map((b) => b.key)).toEqual(["a", "c"]);
    expect(got.totalCents).toBe(10000);
    expect(got.shown.map((b) => b.share)).toEqual([0.75, 0.25]);
  });

  it("does not divide by zero on an empty ladder", () => {
    expect(bands([{ key: "a", label: "A", cents: 0 }])).toEqual({ shown: [], totalCents: 0 });
  });
});

describe("labels are measured, never clipped", () => {
  it("refuses a label that will not fit its segment", () => {
    // The rule is: it goes outside, or it goes to the legend and the tooltip.
    // Never overflow:hidden, which crops the first characters and is worse
    // than no label at all.
    expect(labelFits("60+", 60)).toBe(true);
    expect(labelFits("Inside terms", 60)).toBe(false);
    expect(labelFits("Inside terms", 200)).toBe(true);
  });
});

describe("the palette rules", () => {
  it("spreads a ladder across the whole ramp, whatever its length", () => {
    // A three-band ladder taking the first three steps would crowd into the
    // light end and read as one colour.
    expect(ladder(3)).toEqual([RAMP[0], RAMP[2], RAMP[4]]);
    expect(ladder(5)).toEqual([...RAMP]);
    expect(ladder(1)).toEqual([RAMP[3]]);
  });

  it("picks ink for a label inside a fill by luminance, not by eye", () => {
    // The one place text may sit on a series colour is inside the mark, and
    // both ends of the ramp have to stay readable.
    expect(inkOn(RAMP[0])).toBe("#1E293B");
    expect(inkOn(RAMP[4])).toBe("#FFFFFF");
  });

  it("keeps a status colour out of the categorical set's first three slots", () => {
    /*
     * The all-pairs-safe three are what a scatter or a bubble may use. The
     * fourth is adjacent-only, which is why the comment on SERIES says a chart
     * using all four must direct-label. This test is here so that a future edit
     * that reorders the slots has to think about which three lead.
     */
    expect(SERIES.slice(0, 3)).toEqual(["#1D6396", "#E8613C", "#2E6B2E"]);
    expect(SERIES).toHaveLength(4);
  });
});
