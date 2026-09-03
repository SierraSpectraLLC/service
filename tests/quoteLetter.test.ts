// The letter a quote is, around the table it carries.
//
// Asked for with last year's quote in hand: "Add full client address. Address
// someone personally by name. Multiple lines & formatting inside the
// description. Discounts. Comments or Special Instructions." Every one of those
// was on the document the shop actually sends and none of them was in the
// record - the greeting was a fixed sentence baked into the Excel template, the
// adjustment row was a literal zero nobody wrote to, and the rest was retyped
// into the exported file after every send.
//
// These pin the RULES. The document itself is pinned in xlsxDocs.test.ts.
import { describe, expect, it } from "vitest";
import {
  addressBlock, addressedTo, commentRows, discountLabel, discountOf, greetingLine,
  netCents, specOverflow, specRows, HOUSE_GREETING, SPEC_ROWS,
} from "@/lib/quotes";
import { descriptionLines } from "@/lib/billing";
import { invoiceLinesForXlsx } from "@/lib/xlsxDocData";

describe("the line at the top", () => {
  it("names the person, using the name they are called by", () => {
    expect(greetingLine({ attn: "Hideaki Nakamura" }))
      .toBe("Hideaki, thank you for considering us! Here are the specifics of your quote:");
    // A name typed "Nakamura, Hideaki" is still a person to greet.
    expect(greetingLine({ attn: "Nakamura, Hideaki" })).toMatch(/^Nakamura, thank you/);
  });

  it("falls back to the house sentence when nobody is named", () => {
    expect(greetingLine({})).toBe(HOUSE_GREETING);
    expect(greetingLine({ attn: "   " })).toBe(HOUSE_GREETING);
  });

  it("lets somebody write their own line, which beats both", () => {
    expect(greetingLine({ attn: "Hideaki", greeting: "Per our call this morning:" }))
      .toBe("Per our call this morning:");
  });

  it("is composed, never stored - so changing the house sentence changes them all", () => {
    // The proof is that the same input gives the same line every time and no
    // caller passes one in. If this ever needs a stored copy, the quotes that
    // went out before the change are the ones that would silently reword.
    expect(greetingLine({ attn: "Dana" })).toBe(greetingLine({ attn: "Dana" }));
  });
});

describe("where the quote is addressed", () => {
  const org = { name: "UCSF Hair Analytical Lab", billingAddress: "513 Parnassus Ave.\nSan Francisco, CA 94143" };

  it("uses the client's billing address when the quote does not say otherwise", () => {
    const to = addressedTo({ attn: "Hideaki" }, org);
    expect(to).toMatchObject({ name: org.name, attn: "Hideaki", address: org.billingAddress, ownAddress: false });
  });

  it("takes the quote's own address when it has one - a lab is not accounts payable", () => {
    const to = addressedTo({ clientAddress: "Box 41, Bldg 3\nRichmond, CA 94804" }, org);
    expect(to.address).toBe("Box 41, Bldg 3\nRichmond, CA 94804");
    expect(to.ownAddress).toBe(true);
  });

  it("survives a client with nothing on file", () => {
    expect(addressedTo({}, null)).toMatchObject({ name: "", address: "" });
  });

  it("prints as the lines it has, blanks dropped", () => {
    expect(addressBlock("513 Parnassus Ave.\n\n  San Francisco, CA 94143 \n"))
      .toEqual(["513 Parnassus Ave.", "San Francisco, CA 94143"]);
  });
});

describe("what comes off the price", () => {
  it("takes a percentage of the subtotal", () => {
    expect(discountOf(3_600_000, { discountPct: 10 })).toBe(360_000);
    expect(netCents(3_600_000, { discountPct: 10 })).toBe(3_240_000);
  });

  it("takes a flat amount - the way a pooled allocation is actually written", () => {
    // The reference quote: $36,000 of lines, $12,000 off, $24,000 due.
    expect(discountOf(3_600_000, { discountCents: 1_200_000 })).toBe(1_200_000);
    expect(netCents(3_600_000, { discountCents: 1_200_000 })).toBe(2_400_000);
  });

  it("lets the percentage win when a row somehow holds both", () => {
    // One rule, written here, rather than two screens each guessing. The action
    // clears the other on save; this is what a row that predates that reads as.
    expect(discountOf(1_000_000, { discountPct: 10, discountCents: 900_000 })).toBe(100_000);
  });

  it("never exceeds the quote, and never goes negative", () => {
    // A discount larger than the quote is a typo, and a negative total is not
    // an offer anybody can accept.
    expect(discountOf(100_000, { discountCents: 500_000 })).toBe(100_000);
    expect(netCents(100_000, { discountCents: 500_000 })).toBe(0);
    expect(discountOf(100_000, { discountPct: -5 })).toBe(0);
    expect(discountOf(0, { discountPct: 50 })).toBe(0);
  });

  it("says what it is called, because a number with no reason is a phone call", () => {
    expect(discountLabel({ discountPct: 10 })).toBe("Discount (10%)");
    expect(discountLabel({ discountCents: 1_200_000 })).toBe("Discount");
    expect(discountLabel({ discountCents: 1_200_000, discountLabel: "Pooled repair part allocation" }))
      .toBe("Pooled repair part allocation");
    expect(discountLabel({ discountPct: 10, discountLabel: "Volume" })).toBe("Volume (10%)");
  });
});

describe("the comments block", () => {
  const terms = ["25% deposit due on approval", "Quote good through 2026-10-30"];

  it("puts the shop's own words first and the standing terms after them", () => {
    expect(commentRows("HPLC included\nDedicated CA-based engineer", terms, 5))
      .toEqual(["HPLC included", "Dedicated CA-based engineer", ...terms]);
  });

  it("holds room for the terms rather than letting a long note push them off", () => {
    // The deposit is money the client owes on approval. It must survive a note
    // longer than the paper - the note is what gets truncated, and says so.
    const rows = commentRows("a\nb\nc\nd\ne\nf", terms, 5);
    expect(rows).toHaveLength(5);
    expect(rows.slice(3)).toEqual(terms);
    expect(rows[2]).toBe("c ...");
  });

  it("gives the whole block to the note when there are no terms", () => {
    expect(commentRows("a\nb\nc\nd\ne", [], 5)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("drops blank lines rather than printing blank rows", () => {
    expect(commentRows("a\n\n\nb", [], 5)).toEqual(["a", "b"]);
    expect(commentRows("", [], 5)).toEqual([]);
  });
});

describe("a description with more than one line in it", () => {
  it("is a charge and then its detail", () => {
    const { head, rest } = descriptionLines(
      "LC-10 HPLC | Full-Service Unlimited 12mo\n- Shimadzu LC-10 AS\n- Waters 717 Plus");
    expect(head).toBe("LC-10 HPLC | Full-Service Unlimited 12mo");
    expect(rest).toEqual(["- Shimadzu LC-10 AS", "- Waters 717 Plus"]);
  });

  it("behaves exactly as it always did with no newlines in it", () => {
    expect(descriptionLines("Rotor seal")).toEqual({ head: "Rotor seal", rest: [] });
    expect(descriptionLines("")).toEqual({ head: "", rest: [] });
  });

  it("treats the blank lines somebody typed as spacing, not content", () => {
    // A blank row on a spreadsheet costs a row of the table; on screen it costs
    // nothing. Dropping them keeps the two surfaces the same shape.
    expect(descriptionLines("Head\n\n  - one  \n\n- two\n").rest).toEqual(["- one", "- two"]);
  });
});

describe("what the spreadsheet gets", () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    kind: "part", description: "Rotor seal", detail: "", partNumber: "G6303-80060",
    qty: 1, unitCents: 14000, covered: false, coveredBy: "", ...over,
  });

  it("turns one multi-line charge into a row per line, priced on the first", () => {
    const out = invoiceLinesForXlsx([stored({
      description: "LC-10 HPLC | Full-Service Unlimited 12mo\n- Shimadzu LC-10 AS\n- Waters 717 Plus",
      partNumber: "FSC-LC10-UNL", unitCents: 800000,
    })]);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      description: "LC-10 HPLC | Full-Service Unlimited 12mo",
      partNumber: "FSC-LC10-UNL", qty: 1, unitPrice: 8000,
    });
    // No quantity and no price on the detail rows: the charge is stated once,
    // or the table stops adding up in the one way a client checks.
    expect(out[1]).toEqual({ description: "- Shimadzu LC-10 AS", continuation: true });
    expect(out[2]).toEqual({ description: "- Waters 717 Plus", continuation: true });
  });

  it("leaves a one-line charge exactly as it was", () => {
    const out = invoiceLinesForXlsx([stored()]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ description: "Rotor seal", partNumber: "G6303-80060", unitPrice: 140 });
  });

  it("keeps the covered rule: real quantity, priced at zero, agreement named", () => {
    const out = invoiceLinesForXlsx([stored({ covered: true, coveredBy: "AGR-2026-11", qty: 2 })]);
    expect(out[0].unitPrice).toBe(0);
    expect(out[0].description).toContain("covered by AGR-2026-11");
    expect(out[0].qty).toBe(2);
  });
});

/**
 * The specifics block: the shape of the offer, under the greeting.
 *
 * Fourteen cells in the template - rows 17 to 23, two columns - of which
 * exactly one was ever written to. The rest is where the shop said what the
 * contract covers, and it was typed into the exported file by hand every time.
 */
describe("the specifics block", () => {
  it("reads a heading and the points under it", () => {
    expect(specRows("Full-Service Unlimited Contract for:\n- System A (Quattro Ultima & LC-10 LC)\n- System B (LC-20 LC System)"))
      .toEqual([
        { text: "Full-Service Unlimited Contract for:", sub: false },
        { text: "System A (Quattro Ultima & LC-10 LC)", sub: true },
        { text: "System B (LC-20 LC System)", sub: true },
      ]);
  });

  it("takes a point however somebody marked it, and drops the blank lines", () => {
    // The same two marks the proposal's sections use: somebody typing into one
    // box should not have to remember which box they are in.
    expect(specRows("Head\n- a\n• b\n* c\n\n  \n").map((r) => r.sub))
      .toEqual([false, true, true, true]);
  });

  it("stops at the seven rows the paper has", () => {
    // Row 24 is the table's header. An eighth line would print on top of
    // "Description | Part Num. | Quantity", not wrap.
    const nine = Array.from({ length: 9 }, (_, i) => `Line ${i + 1}`).join("\n");
    expect(specRows(nine)).toHaveLength(SPEC_ROWS);
    expect(specRows(nine).at(-1)).toEqual({ text: "Line 7", sub: false });
  });

  it("counts what will not fit, so the editor can say so", () => {
    // Said out loud rather than silently dropped: what does not fit is still
    // what somebody wrote.
    expect(specOverflow("a\nb\nc")).toBe(0);
    expect(specOverflow(Array.from({ length: 10 }, (_, i) => `L${i}`).join("\n"))).toBe(3);
  });

  it("says nothing about an empty column", () => {
    expect(specRows("")).toEqual([]);
    expect(specRows("   \n\n  ")).toEqual([]);
  });
});
