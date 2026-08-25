import { describe, expect, it } from "vitest";
import {
  backfillTotal, invoiceProblem, openingStatus, quoteProblem, usableLines,
} from "@/lib/backfill";

/**
 * The checks that decide whether a migration produces a faithful ledger.
 *
 * Every one of these failures is invisible after the fact: the invoice looks
 * fine, the dates just stop making sense to whoever reads them a year later,
 * and a phantom receivable is already sitting in an aging bucket.
 */

const TODAY = "2026-08-25";
const line = (desc: string, qty = 1, unitCents = 45000) => ({ kind: "part", description: desc, qty, unitCents });
const inv = (p: Partial<Parameters<typeof invoiceProblem>[0]> = {}) =>
  invoiceProblem({ issuedOn: "2026-03-04", outcome: "paid", paidOn: "2026-04-02", lines: [line("PM")], ...p }, TODAY);
const quo = (p: Partial<Parameters<typeof quoteProblem>[0]> = {}) =>
  quoteProblem({ title: "Relocate the GC", sentOn: "2026-03-04", answeredOn: "2026-03-19", lines: [line("Move")], ...p }, TODAY);

describe("lines", () => {
  it("keeps a line that says something or charges something", () => {
    expect(usableLines([line("PM"), line("", 1, 0), line("", 1, 500)])).toHaveLength(2);
  });

  it("totals quantity against unit price", () => {
    expect(backfillTotal([line("PM", 1, 45000), line("Travel", 2.5, 10000)])).toBe(70000);
    expect(backfillTotal([])).toBe(0);
  });
});

describe("a historical invoice", () => {
  it("records cleanly when the dates make sense", () => {
    expect(inv()).toBe("");
    expect(inv({ outcome: "open", paidOn: "" })).toBe("");
    expect(inv({ outcome: "void", paidOn: "" })).toBe("");
  });

  it("refuses a date in the future", () => {
    // A phantom receivable: it lands in a balance, an aging bucket and a
    // dunning ladder, and nothing about it looks wrong afterwards.
    expect(inv({ issuedOn: "2027-01-01" })).toContain("in the future");
    expect(inv({ paidOn: "2027-01-01" })).toContain("in the future");
  });

  it("refuses money that arrived before the bill did", () => {
    expect(inv({ issuedOn: "2026-04-02", paidOn: "2026-03-04" }))
      .toContain("cannot have been paid before it was issued");
  });

  it("takes a blank payment date as the day it was issued", () => {
    expect(inv({ paidOn: "" })).toBe("");
  });

  it("refuses a paid invoice with no money on it", () => {
    expect(inv({ lines: [line("Goodwill visit", 1, 0)] })).toContain("needs an amount");
    // ...but an unpaid one at zero is a real thing: a fully covered visit.
    expect(inv({ outcome: "open", paidOn: "", lines: [line("Covered by contract", 1, 0)] })).toBe("");
  });

  it("refuses one with nothing on it at all", () => {
    expect(inv({ lines: [] })).toContain("at least one line");
    expect(inv({ lines: [line("", 1, 0)] })).toContain("at least one line");
  });

  it("wants a real day, not an empty box or a typo", () => {
    expect(inv({ issuedOn: "" })).toContain("Pick the date it was issued");
    expect(inv({ issuedOn: "March 2026" })).toContain("Pick the date it was issued");
  });
});

describe("a historical quote", () => {
  it("records cleanly when the dates make sense", () => {
    expect(quo()).toBe("");
    expect(quo({ answeredOn: "" })).toBe("");
  });

  it("refuses an answer that came before the quote went out", () => {
    expect(quo({ sentOn: "2026-03-19", answeredOn: "2026-03-04" }))
      .toContain("cannot have answered before it was sent");
  });

  it("refuses the future on either date", () => {
    expect(quo({ sentOn: "2027-02-01", answeredOn: "2027-03-01" })).toContain("in the future");
    expect(quo({ answeredOn: "2027-03-01" })).toContain("in the future");
  });

  it("insists on knowing what it was for", () => {
    expect(quo({ title: "  " })).toContain("what the quote was for");
  });
});

describe("the status a recorded invoice opens on", () => {
  it("is sent, so the balance is summed from payments like every other invoice", () => {
    // Never "paid" directly: history must not be the one place in the app
    // where a balance is asserted instead of derived.
    expect(openingStatus("paid")).toBe("sent");
    expect(openingStatus("open")).toBe("sent");
    expect(openingStatus("void")).toBe("void");
  });
});
