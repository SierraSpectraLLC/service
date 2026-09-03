// The long document, assembled.
//
// Sent as a Word file with the ask: "this is a longer SLA-style service
// agreement I want to template out into a format we can use / add systems,
// etc." It was written by copying last year's and editing every paragraph -
// so the parts that are the same every time got re-proofread, and the parts
// that must change got missed.
//
// What these pin is the shape of the thing: sections in the order somebody put
// them, four kinds that render the proposal's own rows in their place, a
// comparison table built from the tiers rather than typed beside them, and
// nothing printed over an empty section.
import { describe, expect, it } from "vitest";
import {
  HOUSE_SECTIONS, HOUSE_TIERS, houseTemplate, parseBody, parseBullets, parseFeatures,
  proposalBlocks, proposalValueCents, SECTION_KINDS, systemSummary, tierMatrix,
  type ProposalInput, type Tier,
} from "@/lib/proposal";

const tier = (over: Partial<Tier> = {}): Tier => ({
  key: "essential", name: "Essential", annualCents: 3_200_000,
  bestFor: "labs supporting GMP work", includes: "Two PM visits\nRemote support",
  notIncluded: "", features: "Preventive Maintenance | 2 / year\nRemote Support | Business hours",
  ...over,
});

const input = (over: Partial<ProposalInput> = {}): ProposalInput => ({
  title: "Service Contract Proposal",
  subtitle: "Sciex TripleTOF 6600 + Shimadzu UHPLC - Avance Biosciences, Houston TX",
  customer: "Avance Biosciences Inc.", contact: "James Otto Jr.",
  date: "May 10, 2026", quoteNumber: "030215_Ar1", pricingValid: "30 days from issue",
  systems: [
    { name: "Sciex TripleTOF Mass Spectrometer", model: "TripleTOF 6600", note: "ESI source" },
    { name: "Shimadzu UHPLC", model: "LC-30AD", note: "Coupled to the 6600" },
  ],
  tiers: [tier(), tier({ key: "premium", name: "Premium", annualCents: 4_600_000, features: "Preventive Maintenance | 2 / year\nOn-Site Escalation | Unlimited" })],
  recommendedTier: "essential",
  sections: [
    { kind: "prose", heading: "Executive Summary", body: "We are pleased to propose coverage." },
    { kind: "systems", heading: "Scope of Coverage", body: "# Covered Systems" },
    { kind: "tiers", heading: "Coverage Tier Comparison", body: "All tiers include semi-annual PMs." },
    { kind: "tier_detail", heading: "Tier Detail", body: "" },
    { kind: "recommendation", heading: "Our Recommendation", body: "GMP Select fits the December deadline." },
  ],
  ...over,
});

const kinds = (bs: ReturnType<typeof proposalBlocks>) => bs.map((b) => b.kind);

describe("the three marks a section body understands", () => {
  it("reads a subheading, a bullet run and a paragraph", () => {
    expect(parseBody("# Parts Sourcing\n- OEM where available\n- Third party where not\n\nAll parts documented."))
      .toEqual([
        { kind: "sub", text: "Parts Sourcing" },
        { kind: "list", items: ["OEM where available", "Third party where not"] },
        { kind: "para", text: "All parts documented." },
      ]);
  });

  it("takes a bullet however somebody marked it", () => {
    // A service engineer typing between visits reaches for whichever of these
    // their keyboard offers. All three are the same instruction.
    expect(parseBody("- one\n• two\n* three")[0]).toEqual({ kind: "list", items: ["one", "two", "three"] });
    expect(parseBullets("- one\n• two\n  three  ")).toEqual(["one", "two", "three"]);
  });

  it("ends a run at a blank line rather than swallowing the next paragraph", () => {
    expect(kinds(parseBody("- a\n\nb\n- c"))).toEqual(["list", "para", "list"]);
  });

  it("says nothing about an empty body", () => {
    expect(parseBody("")).toEqual([]);
    expect(parseBody("   \n\n  ")).toEqual([]);
  });
});

describe("the comparison table", () => {
  it("builds itself from the tiers, price first", () => {
    const m = tierMatrix([tier(), tier({ key: "premium", name: "Premium", annualCents: 4_600_000 })]);
    expect(m.head).toEqual(["Feature", "Essential", "Premium"]);
    // Generated, never typed: a matrix row that could disagree with the tier's
    // own detail section is a document quoting two prices for one thing.
    expect(m.rows[0]).toEqual(["Annual Investment", "$32,000", "$46,000"]);
  });

  it("keeps the labels in the order somebody typed them, left to right", () => {
    const m = tierMatrix([
      tier({ features: "PM | 2 / year\nRemote | Business hours" }),
      tier({ key: "b", name: "B", features: "Remote | Extended\nEscalation | Unlimited" }),
    ]);
    expect(m.rows.slice(1).map((r) => r[0])).toEqual(["PM", "Remote", "Escalation"]);
  });

  it("dashes a feature a tier says nothing about", () => {
    // Not blank, which reads as an oversight, and not "No", which is a claim
    // the shop did not make.
    const m = tierMatrix([
      tier({ features: "Escalation | 5 days" }),
      tier({ key: "b", name: "B", features: "" }),
    ]);
    expect(m.rows.find((r) => r[0] === "Escalation")).toEqual(["Escalation", "5 days", "-"]);
  });

  it("dashes a tier nobody has priced yet", () => {
    expect(tierMatrix([tier({ annualCents: 0 })]).rows[0]).toEqual(["Annual Investment", "-"]);
  });

  it("reads a feature line with no value as included", () => {
    expect(parseFeatures("PM Travel & Logistics")).toEqual([
      { label: "PM Travel & Logistics", value: "Included" },
    ]);
  });
});

describe("the document, in order", () => {
  it("opens with the title and the facts table", () => {
    const bs = proposalBlocks(input());
    expect(bs[0]).toMatchObject({ kind: "title", text: "Service Contract Proposal" });
    const facts = bs[1] as { kind: "facts"; rows: [string, string][] };
    expect(facts.rows).toContainEqual(["Customer", "Avance Biosciences Inc."]);
    expect(facts.rows).toContainEqual(["Quote #", "030215_Ar1"]);
    expect(facts.rows).toContainEqual(["Contact", "James Otto Jr."]);
    // The systems, as one line - the header table has room for a phrase.
    expect(facts.rows).toContainEqual(["System", "TripleTOF 6600 + LC-30AD"]);
  });

  it("renders the systems table where the systems section sits", () => {
    const bs = proposalBlocks(input());
    const table = bs.find((b) => b.kind === "table" && b.head[0] === "#");
    expect(table).toMatchObject({
      head: ["#", "Instrument", "Model", "Notes"],
      rows: [
        ["1", "Sciex TripleTOF Mass Spectrometer", "TripleTOF 6600", "ESI source"],
        ["2", "Shimadzu UHPLC", "LC-30AD", "Coupled to the 6600"],
      ],
    });
  });

  it("marks a placeholder section's words as a caption, and prose as prose", () => {
    /*
     * "Tiers structured to fit different risk profiles" is a note about the
     * table under it, and the document sets it smaller and italic to say so.
     * The executive summary's first paragraph is a paragraph. A renderer that
     * decided this by noticing what came before it got the summary wrong.
     */
    const bs = proposalBlocks(input());
    const caption = bs.find((b) => b.kind === "para" && b.text.startsWith("All tiers"));
    expect(caption).toMatchObject({ lead: true });
    const prose = bs.find((b) => b.kind === "para" && b.text.startsWith("We are pleased"));
    expect(prose).toEqual({ kind: "para", text: "We are pleased to propose coverage." });
  });

  it("tints the comparison's price row, the figure the others are read against", () => {
    const table = proposalBlocks(input()).find((b) => b.kind === "table" && b.head[0] === "Feature");
    expect(table).toMatchObject({ lead: true });
    expect((table as { rows: string[][] }).rows[0][0]).toBe("Annual Investment");
  });

  it("follows the order the sections are in, not an order baked into the code", () => {
    // The whole reason the placeholders are rows: somebody can put the tier
    // comparison first without a code change.
    const flipped = input({
      sections: [
        { kind: "tiers", heading: "Coverage Tier Comparison", body: "" },
        { kind: "systems", heading: "Scope of Coverage", body: "" },
      ],
    });
    const tables = proposalBlocks(flipped).filter((b) => b.kind === "table");
    expect(tables[0].head[0]).toBe("Feature");
    expect(tables[1].head[0]).toBe("#");
  });

  it("writes each tier out in full where the detail section sits", () => {
    const bs = proposalBlocks(input());
    const heads = bs.filter((b) => b.kind === "head").map((b) => b.text);
    expect(heads).toContain("Tier Detail: Essential");
    expect(heads).toContain("Tier Detail: Premium");
    const i = bs.findIndex((b) => b.kind === "head" && b.text === "Tier Detail: Essential");
    // Bold: the price is the line a reader skips to, among sentences.
    expect(bs[i + 1]).toEqual({ kind: "para", text: "Annual Investment: $32,000", strong: true });
    expect(bs[i + 2]).toMatchObject({ kind: "para", text: "Best for: labs supporting GMP work" });
    expect(bs[i + 3]).toEqual({ kind: "sub", text: "Includes" });
  });

  it("names the recommended tier and its price in the callout", () => {
    const bs = proposalBlocks(input());
    expect(bs.find((b) => b.kind === "callout")).toMatchObject({
      text: "Recommended Tier: Essential ($32,000/year)",
      body: ["GMP Select fits the December deadline."],
    });
  });
});

describe("a section with nothing to say prints nothing", () => {
  it("drops the systems table on a proposal with no systems", () => {
    const bs = proposalBlocks(input({ systems: [] }));
    expect(bs.some((b) => b.kind === "head" && b.text === "Scope of Coverage")).toBe(false);
  });

  it("drops the comparison when there is only one tier - a price is not a choice", () => {
    const bs = proposalBlocks(input({ tiers: [tier()] }));
    expect(bs.some((b) => b.kind === "head" && b.text === "Coverage Tier Comparison")).toBe(false);
    // The tier's own detail still prints: one tier is still an offer.
    expect(bs.some((b) => b.kind === "head" && b.text === "Tier Detail: Essential")).toBe(true);
  });

  it("drops the recommendation when nothing is recommended, or nothing is said", () => {
    expect(proposalBlocks(input({ recommendedTier: "" })).some((b) => b.kind === "callout")).toBe(false);
    const silent = input({
      sections: [{ kind: "recommendation", heading: "Our Recommendation", body: "" }],
    });
    expect(proposalBlocks(silent).some((b) => b.kind === "callout")).toBe(false);
  });

  it("drops an empty prose section rather than printing a heading over silence", () => {
    const bs = proposalBlocks(input({
      sections: [
        { kind: "prose", heading: "Executive Summary", body: "" },
        { kind: "prose", heading: "Parts & Materials", body: "Parts coverage is structured..." },
      ],
    }));
    const heads = bs.filter((b) => b.kind === "head").map((b) => b.text);
    expect(heads).toEqual(["Parts & Materials"]);
  });
});

describe("the house template a new proposal starts from", () => {
  it("ships the shop's four tiers, unpriced", () => {
    expect(HOUSE_TIERS.map((t) => t.key)).toEqual(["pm_tm", "essential", "gmp_select", "premium"]);
    // What an hour of coverage sells for is a decision per client. A seeded
    // guess would put a number nobody chose in front of somebody.
    expect(HOUSE_TIERS.every((t) => t.annualCents === 0)).toBe(true);
    expect(HOUSE_TIERS.every((t) => parseFeatures(t.features).length >= 5)).toBe(true);
  });

  it("ships the standing sections, and leaves the client-specific ones empty", () => {
    const byHeading = new Map(HOUSE_SECTIONS.map((s) => [s.heading, s]));
    // House policy: the same every time, and the whole reason to template this.
    expect(byHeading.get("Parts & Materials")?.body).toContain("Per-Incident Cap");
    expect(byHeading.get("Engagement Terms")?.body).toContain("60 days written notice");
    expect(byHeading.get("Compliance & Documentation")?.body).toContain("Service Report");
    // Client-specific: empty prompts, never last client's words. A paragraph
    // about the wrong company's December deadline is the worst thing that can
    // be in one of these.
    expect(byHeading.get("Executive Summary")?.body).toBe("");
    expect(HOUSE_SECTIONS.find((s) => s.kind === "recommendation")?.body).toBe("");
  });

  it("uses only kinds the renderer knows", () => {
    for (const s of HOUSE_SECTIONS) expect(SECTION_KINDS).toContain(s.kind);
  });

  it("hands out a fresh copy, so editing one proposal cannot touch another", () => {
    const a = houseTemplate();
    a.tiers[0].name = "Renamed";
    a.sections[0].body = "Typed over";
    const b = houseTemplate();
    expect(b.tiers[0].name).toBe("PM + T&M");
    expect(b.sections[0].body).toBe("");
  });

  it("renders end to end from the template alone", () => {
    const t = houseTemplate();
    const bs = proposalBlocks(input({ tiers: t.tiers, sections: t.sections, recommendedTier: "" }));
    const heads = bs.filter((b) => b.kind === "head").map((b) => b.text);
    expect(heads).toContain("Parts & Materials");
    expect(heads).toContain("Engagement Terms");
    expect(heads).toContain("Tier Detail: GMP Select");
    // Every tier is in the comparison, priced or not.
    const m = bs.find((b) => b.kind === "table" && b.head[0] === "Feature") as { head: string[] };
    expect(m.head).toEqual(["Feature", "PM + T&M", "Essential", "GMP Select", "Premium"]);
  });
});

describe("what the document is worth", () => {
  it("is the recommended tier where the shop named one", () => {
    expect(proposalValueCents([tier(), tier({ key: "p", name: "P", annualCents: 4_600_000 })], "p"))
      .toBe(4_600_000);
  });

  it("is the cheapest priced tier where it did not", () => {
    expect(proposalValueCents([tier(), tier({ key: "p", name: "P", annualCents: 4_600_000 })], ""))
      .toBe(3_200_000);
    expect(proposalValueCents([tier({ annualCents: 0 })], "")).toBe(0);
  });
});

describe("the systems, as one line", () => {
  it("joins two with a plus, the way the shop writes it", () => {
    expect(systemSummary([
      { name: "Sciex TripleTOF", model: "TripleTOF 6600", note: "" },
      { name: "Shimadzu UHPLC", model: "LC-30AD", note: "" },
    ])).toBe("TripleTOF 6600 + LC-30AD");
  });

  it("counts the rest rather than running off the header table", () => {
    expect(systemSummary(Array.from({ length: 5 }, (_, i) => ({ name: `S${i}`, model: `M${i}`, note: "" }))))
      .toBe("M0 + M1 +3 more");
  });

  it("falls back to the instrument's name where nobody typed a model", () => {
    expect(systemSummary([{ name: "Nitrogen Gas Generator", model: "", note: "" }]))
      .toBe("Nitrogen Gas Generator");
  });
});
