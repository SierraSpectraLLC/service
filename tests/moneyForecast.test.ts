// The eight-week cash line, from commitments only. Pure.
import { describe, expect, it } from "vitest";
import { beyondHorizon, commitments, forecast, type ForecastInput } from "@/lib/money/forecast";

const BASE: ForecastInput = {
  today: "2026-09-15", cashCents: 100000, invoices: [], installments: [], bills: [], payroll: [],
  posReceived: [], posOnOrder: [], reports: [], tax: null,
};

describe("commitments", () => {
  it("dates each kind of money the way the section promises", () => {
    const list = commitments({
      ...BASE,
      invoices: [
        { number: "INV-1", balanceCents: 100, dueOn: "2026-09-20" },
        { number: "INV-2", balanceCents: 200, dueOn: "2026-09-01" },   // past due: assumed two weeks out
        { number: "INV-3", balanceCents: 0, dueOn: "2026-09-20" },     // nothing owed: not a commitment
      ],
      installments: [{ label: "LabZen", cents: 300, dueOn: "2026-10-01", termsDays: 30 }],
      bills: [{ payee: "Rent", cents: 400, on: "2026-10-01" }, { payee: "Old", cents: 1, on: "2026-09-01" }],
      payroll: [{ ym: "2026-09", grossCents: 500, runOn: "2026-09-30" }],
      posReceived: [{ number: "PO-1", vendor: "Agilent", cents: 600, receivedOn: "2026-09-01" }],   // receipt + 30 = 10-01
      posOnOrder: [{ number: "PO-2", vendor: "Waters", cents: 700, expectedOn: "2026-09-20" }],     // expected + 30 = 10-20
      reports: [{ person: "Ana", cents: 800 }],
      tax: { cents: 900, dueOn: "2026-10-31" },
    });
    expect(list.map((c) => [c.on, c.direction, c.cents])).toEqual([
      ["2026-09-15", "out", 800],
      ["2026-09-20", "in", 100],
      ["2026-09-29", "in", 200],
      ["2026-09-30", "out", 500],
      ["2026-10-01", "out", 400],
      ["2026-10-01", "out", 600],
      ["2026-10-20", "out", 700],
      ["2026-10-31", "in", 300],
      ["2026-10-31", "out", 900],
    ]);
    expect(list[2].label).toContain("past due");
  });

  it("never dates a payable before today", () => {
    const [po] = commitments({ ...BASE, posReceived: [{ number: "PO-1", vendor: "A", cents: 1, receivedOn: "2026-01-01" }] });
    expect(po.on).toBe("2026-09-15");
  });
});

describe("forecast", () => {
  it("buckets by week from today, runs the balance, and names the low point", () => {
    const f = forecast({
      ...BASE,
      invoices: [{ number: "INV-1", balanceCents: 50000, dueOn: "2026-09-25" }],
      payroll: [{ ym: "2026-09", grossCents: 120000, runOn: "2026-09-30" }],
    });
    expect(f.weeks).toHaveLength(8);
    expect(f.weeks[0]).toMatchObject({ from: "2026-09-15", to: "2026-09-21", inCents: 0, outCents: 0, endingCents: 100000 });
    expect(f.weeks[1]).toMatchObject({ from: "2026-09-22", inCents: 50000, endingCents: 150000 });
    expect(f.weeks[2]).toMatchObject({ outCents: 120000, endingCents: 30000 });
    expect(f.lowWeek).toBe(2);
    expect(f.lowCents).toBe(30000);
  });

  it("with nothing committed is a flat line at today's cash", () => {
    const f = forecast(BASE);
    expect(f.weeks.every((w) => w.endingCents === 100000)).toBe(true);
    expect(f.lowWeek).toBe(0);
  });

  it("knows what falls off the end", () => {
    expect(beyondHorizon({ on: "2026-11-10", cents: 1, direction: "in", label: "" }, "2026-09-15")).toBe(true);
    expect(beyondHorizon({ on: "2026-11-09", cents: 1, direction: "in", label: "" }, "2026-09-15")).toBe(false);
  });
});
