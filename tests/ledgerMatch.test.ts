// Reconciliation: what a bank line could be, in order of confidence. Pure.
import { describe, expect, it } from "vitest";
import { bankBalance, memoFromDescription, POST_AS, suggestFor, type CashEntry, type OpenInvoice } from "@/lib/ledger/match";

const line = (amountCents: number, on = "2026-09-10") => ({ id: 1, on, description: "ACH", amountCents, matchedEntryId: null });
const entry = (o: Partial<CashEntry>): CashEntry => ({ id: 7, on: "2026-09-08", memo: "Payment on INV-1", bankCents: 282000, matched: false, refType: "invoice", ...o });
const inv = (o: Partial<OpenInvoice>): OpenInvoice => ({ id: 3, number: "INV-3", balanceCents: 282000, orgId: 1, ...o });

describe("suggestFor", () => {
  it("prefers a live, unmatched cash entry of the same signed amount inside the week", () => {
    expect(suggestFor(line(282000), [entry({})], [inv({})])).toEqual([{ kind: "entry", entryId: 7, memo: "Payment on INV-1", on: "2026-09-08" }]);
  });

  it("skips entries already matched, the opening balance, and anything outside the window", () => {
    expect(suggestFor(line(282000), [entry({ matched: true })], [])).toEqual([{ kind: "invoice", invoiceId: 3, number: "INV-3" }].slice(0, 0).concat([{ kind: "income" }] as never));
    expect(suggestFor(line(282000), [entry({ refType: "opening" })], [])).toEqual([{ kind: "income" }]);
    expect(suggestFor(line(282000, "2026-09-20"), [entry({ on: "2026-09-08" })], [])).toEqual([{ kind: "income" }]);
  });

  it("offers an open invoice with exactly that balance when money in has no entry", () => {
    expect(suggestFor(line(282000), [], [inv({}), inv({ id: 4, number: "INV-4", balanceCents: 1 })]))
      .toEqual([{ kind: "invoice", invoiceId: 3, number: "INV-3" }]);
  });

  it("offers the four cost accounts for money out nobody posted", () => {
    expect(suggestFor(line(-6120), [], [inv({})])).toEqual([{ kind: "post", accounts: POST_AS.map((p) => p.account) }]);
  });

  it("never matches money out to money in", () => {
    expect(suggestFor(line(-282000), [entry({})], [])).toEqual([{ kind: "post", accounts: POST_AS.map((p) => p.account) }]);
  });
});

describe("the small helpers", () => {
  it("reads a bank description as a name", () => {
    expect(memoFromDescription("SHELL OIL 57210 FRESNO CA")).toBe("Shell Oil");
    expect(memoFromDescription("ACH CREDIT CASCADE ENV LABS")).toBe("Ach Credit Cascade Env Labs");
    expect(memoFromDescription("")).toBe("");
  });

  it("puts the opening balance under the feed", () => {
    expect(bankBalance([{ amountCents: 100 }, { amountCents: -30 }], 5000)).toBe(5070);
  });
});
