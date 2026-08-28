import { describe, expect, it } from "vitest";
import {
  PO_OUTCOMES, backfillTotal, invoiceProblem, openingStatus, poProblem,
  quoteProblem, usableLines, usablePoLines,
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

describe("a purchase order that was already placed", () => {
  const line = (over: Partial<{ partNumber: string; name: string; qty: number; unitCents: number }> = {}) =>
    ({ partNumber: "G1311-60001", name: "Quaternary pump seal kit", qty: 2, unitCents: 18400, ...over });
  const ok = (over: Record<string, unknown> = {}) => ({
    vendor: "Agilent", orderedOn: "2025-11-04", outcome: "received", lines: [line()], ...over,
  });

  it("accepts a plain received order", () => {
    expect(poProblem(ok())).toBeNull();
  });

  it("insists on a part number on every line", () => {
    /*
     * The whole value of typing an old order in is that a part on a shelf can
     * be traced back to what was paid for it. A line with a description and no
     * part number is a receipt, not an order, and it makes the record look
     * complete while answering nothing.
     */
    expect(poProblem(ok({ lines: [line({ partNumber: "" })] })))
      .toContain("Every line needs a part number");
    expect(poProblem(ok({ lines: [line(), line({ partNumber: "  " })] })))
      .toContain("Every line needs a part number");
  });

  it("insists on a vendor, a date and an outcome", () => {
    expect(poProblem(ok({ vendor: "  " }))).toBe("Say who it was ordered from");
    expect(poProblem(ok({ orderedOn: "last November" }))).toBe("Pick the day it was ordered");
    expect(poProblem(ok({ outcome: "posted" }))).toBe("Say how it ended");
  });

  it("refuses an order for nothing", () => {
    expect(poProblem(ok({ lines: [] }))).toContain("at least one line");
    expect(poProblem(ok({ lines: [line({ qty: 0 })] }))).toBe("A line with no quantity is not an order");
  });

  it("keeps only the lines somebody actually filled in", () => {
    // The form ships a blank row to type into; an untouched one is not a line.
    const rows = [line(), { partNumber: "", name: "", qty: 1, unitCents: 0 }];
    expect(usablePoLines(rows)).toHaveLength(1);
  });

  it("offers cancelled as an outcome, because a spent number is still spent", () => {
    expect([...PO_OUTCOMES]).toEqual(["received", "sent", "cancelled"]);
    expect(poProblem(ok({ outcome: "cancelled" }))).toBeNull();
    expect(poProblem(ok({ outcome: "sent" }))).toBeNull();
  });
});
