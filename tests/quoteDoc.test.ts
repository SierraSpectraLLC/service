// The quote, as a document. Pure, no DB.
//
// What is pinned: the sections the style guide names for a quote, in its
// order; a covered line that keeps its place and prices at nothing; detail
// rows under their charge; the total bold with the discount above it only
// when there is one; and nothing printed over an empty section.
import { describe, expect, it } from "vitest";
import { quoteDocument, type QuoteDocInput } from "@/lib/quoteDoc";

const quote = (over: Partial<QuoteDocInput> = {}): QuoteDocInput => ({
  number: "030304_In1", title: "12mo Full Service Contract Renewal", customer: "LabZen", contact: "Dr. Ada Park",
  date: "September 16, 2026", pricingValid: "through October 16, 2026",
  greeting: "Thank you for considering us. Here are the specifics of the job:",
  specs: {
    left: [{ text: "Coverage", sub: false }, { text: "Two PM visits a year", sub: true }, { text: "Remote support, business hours", sub: true }],
    right: [{ text: "Response", sub: false }, { text: "Next business day", sub: true }],
  },
  systems: [{ name: "Sciex TripleTOF", model: "6600", tag: "T-003" }],
  lines: [
    { description: "Full service contract\nCovers the source and the vacuum train", detail: "", partNumber: "SVC-12", qty: 12, unit: "mo", unitCents: 200_000, covered: false, coveredBy: "" },
    { description: "Source cleaning kit", detail: "", partNumber: "K-401", qty: 1, unit: "", unitCents: 42_000, covered: true, coveredBy: "AGR-2026-01" },
  ],
  subtotalCents: 2_400_000, discountCents: 0, discountLabel: "", totalCents: 2_400_000,
  depositPct: 100, depositCents: 2_400_000, note: "Renews on the same terms unless either party gives 30 days notice.",
  expiresOn: "October 16, 2026",
  ...over,
});

const heads = (blocks: ReturnType<typeof quoteDocument>) =>
  blocks.filter((b) => b.kind === "head").map((b) => (b as { text: string }).text);

describe("quoteDocument", () => {
  it("opens with the title, the summary block and the greeting, then the guide's sections in order", () => {
    const blocks = quoteDocument(quote());
    expect(blocks[0]).toEqual({ kind: "title", text: "Service Quote", sub: "12mo Full Service Contract Renewal · LabZen" });
    expect(blocks[1].kind).toBe("facts");
    expect((blocks[1] as { rows: [string, string][] }).rows.map(([k]) => k))
      .toEqual(["Customer", "Date", "Contact", "Quote #", "System", "Pricing Valid"]);
    expect(blocks[2]).toEqual({ kind: "para", text: "Thank you for considering us. Here are the specifics of the job:" });
    expect(heads(blocks)).toEqual(["What Is Included", "Covered Systems", "Pricing", "Terms"]);
  });

  it("prices the lines with the covered one at nothing, its agreement named, and detail under the charge", () => {
    const table = quoteDocument(quote()).find((b) => b.kind === "table" && b.head[0] === "Description") as Extract<ReturnType<typeof quoteDocument>[number], { kind: "table" }>;
    expect(table.rows).toEqual([
      ["Full service contract", "SVC-12", "12 mo", "$2,000", "$24,000"],
      ["    Covers the source and the vacuum train", "", "", "", ""],
      ["Source cleaning kit", "K-401", "1", "covered by AGR-2026-01", "—"],
    ]);
    expect(table.foot).toEqual([["Total", "", "", "", "$24,000"]]);
    expect(table.align).toEqual(["l", "l", "r", "r", "r"]);
    expect(table.mono).toEqual([1]);
  });

  it("shows the subtotal and the concession only when something came off", () => {
    const table = quoteDocument(quote({ discountCents: 240_000, discountLabel: "Loyalty discount (10%)", totalCents: 2_160_000 }))
      .find((b) => b.kind === "table" && b.head[0] === "Description") as Extract<ReturnType<typeof quoteDocument>[number], { kind: "table" }>;
    expect(table.foot).toEqual([
      ["Subtotal", "", "", "", "$24,000"],
      ["Loyalty discount (10%)", "", "", "", "-$2,400"],
      ["Total", "", "", "", "$21,600"],
    ]);
  });

  it("drops the sections that have nothing in them rather than heading over silence", () => {
    const blocks = quoteDocument(quote({
      greeting: "", specs: { left: [], right: [] }, systems: [], depositPct: 0, depositCents: 0, note: "", expiresOn: "",
    }));
    expect(heads(blocks)).toEqual(["Pricing"]);
    expect(blocks.some((b) => b.kind === "para")).toBe(false);
  });

  it("spells the terms out: the deposit with its figure, and how long the price holds", () => {
    const list = quoteDocument(quote()).find((b) => b.kind === "list" && b.items.some((i) => i.includes("deposit"))) as { items: string[] };
    expect(list.items).toEqual([
      "100% deposit ($24,000) due on approval; the balance is invoiced as the work is done.",
      "Pricing is valid through October 16, 2026.",
    ]);
  });
});
