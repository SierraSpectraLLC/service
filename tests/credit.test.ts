// Whether new work opens for somebody who owes money, and what clearing it
// would take. Pure, no DB.
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type BillingPolicy } from "@/lib/billingPolicy";
import { activeOverride, creditStanding, depositToClear, HELD_ACTIONS, holdRefusal } from "@/lib/credit";

const policy = (over: Partial<BillingPolicy> = {}): BillingPolicy => ({ ...DEFAULT_POLICY, ...over });
const today = "2026-08-22";

describe("creditStanding", () => {
  it("is clear when nothing trips either threshold", () => {
    const s = creditStanding({
      policy: policy(), today,
      openInvoices: [{ balanceCents: 45000, daysLate: 0 }],
    });
    expect(s.onHold).toBe(false);
    expect(s.line).toBe("");
    expect(s.balanceCents).toBe(45000);
    expect(s.tone).toBe("good");
  });

  it("warns without holding when something is merely late", () => {
    const s = creditStanding({
      policy: policy(), today,
      openInvoices: [{ balanceCents: 45000, daysLate: 12 }],
    });
    expect(s.onHold).toBe(false);
    expect(s.tone).toBe("warn");
    expect(s.oldestDaysLate).toBe(12);
  });

  it("holds on age, and says which policy number it tripped", () => {
    const s = creditStanding({
      policy: policy({ holdDays: 30, holdAmountCents: 0 }), today,
      openInvoices: [{ balanceCents: 395800, daysLate: 41 }],
    });
    expect(s.onHold).toBe(true);
    expect(s.kind).toBe("age");
    expect(s.line).toContain("41 days past due (policy holds at 30)");
    expect(s.tone).toBe("bad");
  });

  it("holds on amount alone", () => {
    const s = creditStanding({
      policy: policy({ holdDays: 0, holdAmountCents: 150000 }), today,
      openInvoices: [{ balanceCents: 200000, daysLate: 1 }],
    });
    expect(s.kind).toBe("amount");
    expect(s.line).toContain("$2,000 is open across 1 invoice (policy holds at $1,500)");
  });

  it("names both reasons when both trip", () => {
    const s = creditStanding({
      policy: policy({ holdDays: 30, holdAmountCents: 150000 }), today,
      openInvoices: [{ balanceCents: 200000, daysLate: 41 }, { balanceCents: 100000, daysLate: 3 }],
    });
    expect(s.kind).toBe("both");
    expect(s.line).toContain("41 days past due");
    expect(s.line).toContain("across 2 invoices");
  });

  it("a zeroed threshold is off, not a hold on everything", () => {
    const s = creditStanding({
      policy: policy({ holdDays: 0, holdAmountCents: 0 }), today,
      openInvoices: [{ balanceCents: 900000, daysLate: 200 }],
    });
    expect(s.onHold).toBe(false);
  });

  it("an override lifts the hold and keeps the reason in the sentence", () => {
    const s = creditStanding({
      policy: policy({ holdDays: 30 }), today,
      openInvoices: [{ balanceCents: 395800, daysLate: 41 }],
      overrides: [{ reason: "PO stuck in their AP system", grantedBy: "joe", untilOn: "", lifted: false }],
    });
    expect(s.onHold).toBe(false);
    expect(s.tone).toBe("warn");
    expect(s.line).toContain("Would be on hold");
    expect(s.line).toContain("joe overrode it: PO stuck in their AP system");
    expect(s.override?.reason).toBe("PO stuck in their AP system");
  });

  it("an expired or lifted override is no override at all", () => {
    const rows = [
      { reason: "a", grantedBy: "joe", untilOn: "2026-08-01", lifted: false },
      { reason: "b", grantedBy: "joe", untilOn: "", lifted: true },
    ];
    expect(activeOverride(rows, today)).toBeNull();
    const s = creditStanding({
      policy: policy({ holdDays: 30 }), today,
      openInvoices: [{ balanceCents: 395800, daysLate: 41 }],
      overrides: rows,
    });
    expect(s.onHold).toBe(true);
  });

  it("a dated override still in its window holds good", () => {
    expect(activeOverride([{ reason: "a", grantedBy: "joe", untilOn: "2026-09-01", lifted: false }], today)?.reason)
      .toBe("a");
  });
});

describe("depositToClear", () => {
  it("asks for the aged invoices in full, because age cannot be part-paid", () => {
    expect(depositToClear({
      policy: policy({ holdDays: 30, holdAmountCents: 0 }),
      openInvoices: [{ balanceCents: 395800, daysLate: 41 }, { balanceCents: 50000, daysLate: 2 }],
    })).toBe(395800);
  });

  it("asks for just enough to drop under an amount trigger", () => {
    expect(depositToClear({
      policy: policy({ holdDays: 0, holdAmountCents: 150000 }),
      openInvoices: [{ balanceCents: 200000, daysLate: 1 }],
    })).toBe(50001);
  });

  it("takes the larger ask when both triggers are in play", () => {
    expect(depositToClear({
      policy: policy({ holdDays: 30, holdAmountCents: 150000 }),
      openInvoices: [{ balanceCents: 395800, daysLate: 41 }],
    })).toBe(395800);
  });

  it("asks for nothing when nothing is tripped", () => {
    expect(depositToClear({
      policy: policy({ holdDays: 30, holdAmountCents: 150000 }),
      openInvoices: [{ balanceCents: 45000, daysLate: 1 }],
    })).toBe(0);
  });
});

describe("holdRefusal - what a hold actually refuses", () => {
  const held = creditStanding({
    policy: policy({ holdDays: 30 }), today,
    openInvoices: [{ balanceCents: 395800, daysLate: 41 }],
  });
  const clear = creditStanding({
    policy: policy(), today,
    openInvoices: [{ balanceCents: 45000, daysLate: 2 }],
  });

  it("refuses both moves that commit somebody to a drive", () => {
    for (const action of HELD_ACTIONS) {
      expect(holdRefusal(held, action, "Coastal")).not.toBe("");
    }
    expect(holdRefusal(held, "dispatch", "Coastal"))
      .toContain("Cannot assign somebody to this job while Coastal is on credit hold");
    expect(holdRefusal(held, "start", "Coastal"))
      .toContain("Cannot start this job while Coastal is on credit hold");
  });

  it("says why, and says an override will clear it", () => {
    const why = holdRefusal(held, "dispatch", "Coastal");
    expect(why).toContain("41 days past due");
    expect(why).toContain("An owner can override the hold with a reason");
  });

  it("refuses nothing when the account is clear", () => {
    for (const action of HELD_ACTIONS) expect(holdRefusal(clear, action)).toBe("");
  });

  it("refuses nothing once an override is in force", () => {
    // This is the whole reason the reason is worth demanding. An override that
    // did not let the work proceed would be theatre.
    const overridden = creditStanding({
      policy: policy({ holdDays: 30 }), today,
      openInvoices: [{ balanceCents: 395800, daysLate: 41 }],
      overrides: [{ reason: "PO stuck in their AP", grantedBy: "joe", untilOn: "", lifted: false }],
    });
    expect(overridden.onHold).toBe(false);
    for (const action of HELD_ACTIONS) expect(holdRefusal(overridden, action)).toBe("");
  });

  it("covers exactly two actions - filing and closing are deliberately absent", () => {
    // A job that cannot be recorded is a down instrument nobody knows about,
    // and one that cannot be closed is work with no close-out. Both are worse
    // failures than the debt. If somebody adds a third action here, they
    // should have to change this line and think about which it is.
    expect([...HELD_ACTIONS]).toEqual(["dispatch", "start"]);
  });
});
