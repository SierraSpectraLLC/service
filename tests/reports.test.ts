import { describe, expect, it } from "vitest";
import { pmCompliance, shippedTurnaround, minutesBy, spendBy } from "@/lib/reports";

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("pmCompliance", () => {
  const W = "2026-07-01", TODAY = "2026-08-10";
  const pm = (over: object) => ({ origin: "pm", dueDate: "2026-07-15", completedAt: null, state: "Open", ...over });

  it("buckets on-time, late, overdue-open and not-yet-due", () => {
    const out = pmCompliance([
      pm({ state: "Done", completedAt: at("2026-07-15") }),           // on the day = on time
      pm({ state: "Done", completedAt: at("2026-07-20") }),           // late
      pm({}),                                                          // open, past due
      pm({ dueDate: "2026-08-20" }),                                   // open, not due... but outside window
      pm({ dueDate: "2026-08-10" }),                                   // open, due today = not overdue
    ], W, TODAY, dayOf);
    expect(out).toEqual({ onTime: 1, late: 1, openOverdue: 1, openNotDue: 1 });
  });

  it("ignores hand-made tasks, undated PM, and work outside the window", () => {
    const out = pmCompliance([
      pm({ origin: "" }),
      pm({ origin: "checkout" }),
      pm({ dueDate: "" }),
      pm({ dueDate: "2026-06-30" }), // before window
    ], W, TODAY, dayOf);
    expect(out).toEqual({ onTime: 0, late: 0, openOverdue: 0, openNotDue: 0 });
  });

  it("a reopened task counts as open again - the work is not done", () => {
    const out = pmCompliance([pm({ state: "Open", completedAt: null })], W, TODAY, dayOf);
    expect(out.openOverdue).toBe(1);
  });
});

describe("shippedTurnaround", () => {
  it("measures creation to FIRST ship, only for ships inside the window", () => {
    const insts = [
      { id: 1, createdAt: at("2026-06-01") },
      { id: 2, createdAt: at("2026-05-01") },
      { id: 3, createdAt: at("2026-07-01") }, // never shipped
    ];
    const ev = (instrumentId: number, stage: string, kind: string, iso: string) =>
      ({ instrumentId, stage, kind, at: at(iso) });
    const days = shippedTurnaround(insts, [
      ev(1, "Shipped", "add", "2026-07-11"),      // 40 days, in window
      ev(1, "Shipped", "add", "2026-08-01"),      // re-ship: ignored, first wins
      ev(1, "Shipped", "remove", "2026-07-20"),
      ev(2, "Shipped", "add", "2026-06-01"),      // before window: out
      ev(3, "Checkout", "add", "2026-07-05"),     // not a ship
    ], at("2026-07-01"));
    expect(days).toEqual([40]);
  });
});

describe("minutesBy / spendBy", () => {
  it("sums minutes per key inside the window and skips junk", () => {
    const m = minutesBy([
      { minutes: 90, date: "2026-08-01", key: "T-001" },
      { minutes: 30, date: "2026-08-05", key: "T-001" },
      { minutes: 60, date: "2026-06-01", key: "T-001" }, // outside window
      { minutes: 0, date: "2026-08-05", key: "T-002" },  // nothing logged
    ], "2026-07-01");
    expect(m.get("T-001")).toBe(120);
    expect(m.has("T-002")).toBe(false);
  });

  it("spend counts parsed costs and reports the unpriced honestly", () => {
    const s = spendBy([
      { costCents: 124000, createdAt: at("2026-08-01"), key: "Acme" },
      { costCents: null, createdAt: at("2026-08-02"), key: "Acme" },   // "call for quote"
      { costCents: 5000, createdAt: at("2026-06-01"), key: "Acme" },   // outside window
    ], at("2026-07-01"));
    expect(s.get("Acme")).toEqual({ cents: 124000, counted: 1, unpriced: 1 });
  });
});
