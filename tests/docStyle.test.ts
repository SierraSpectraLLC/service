// The house document style, as the style guide states it. Pure, no DB.
import { describe, expect, it } from "vitest";
import { docFileName, docTag, footerLine2, sectionsOf, winAnsi, wordmark } from "@/lib/docStyle";
import type { ProposalBlock } from "@/lib/proposal";

describe("the header", () => {
  it("types the wordmark: capitals, a space between each letter, a bullet between the words", () => {
    expect(wordmark("Sierra Spectra")).toBe("S I E R R A  •  S P E C T R A");
    expect(wordmark("  ridgeline ")).toBe("R I D G E L I N E");
    expect(wordmark("")).toBe("");
  });

  it("tags a proposal for the client and a quote for its number, all caps", () => {
    expect(docTag("Proposal", { client: "Avance Bio" })).toBe("AVANCE BIO PROPOSAL");
    expect(docTag("Quote", { number: "030215", client: "LabZen" })).toBe("QUOTE 030215");
    expect(docTag("Letter", {})).toBe("LETTER");
  });
});

describe("the footer", () => {
  it("is confidential and prepared for the client, or Page N alone for an internal document", () => {
    expect(footerLine2("LabZen", 3)).toBe("CONFIDENTIAL – Prepared for LabZen  |  Page 3");
    expect(footerLine2("", 3)).toBe("Page 3");
  });
});

describe("the file name", () => {
  it("is Type_QuoteNumber_Client.ext, with the revision carried inside the number", () => {
    expect(docFileName("Proposal", "030215_Ar3", "Avance Bio", "docx")).toBe("Proposal_030215_Ar3_AvanceBio.docx");
    expect(docFileName("Quote", "030304_In1", "UCSF", "pdf")).toBe("Quote_030304_In1_UCSF.pdf");
    expect(docFileName("Quote", " Q-12/3 ", "", "pdf")).toBe("Quote_Q_12_3_Client.pdf");
  });
});

describe("what a PDF's standard fonts can draw", () => {
  it("swaps the arrows and ticks people paste, and drops what has no glyph", () => {
    expect(winAnsi("Findings → Work ✓ done — “quoted”")).toBe("Findings -> Work yes done — “quoted”");
    expect(winAnsi("a\u{1F600}b c")).toBe("ab c");
  });
});

describe("the sections a document is kept together in", () => {
  const blocks: ProposalBlock[] = [
    { kind: "title", text: "Service Contract Proposal", sub: "" },
    { kind: "facts", rows: [["Customer", "LabZen"]] },
    { kind: "head", text: "One" },
    { kind: "para", text: "Under one." },
    { kind: "sub", text: "A sub-heading, not a section" },
    { kind: "head", text: "Two" },
  ];

  it("starts a section at every heading, and opens with whatever comes before the first", () => {
    expect(sectionsOf(blocks).map((s) => s.map((b) => b.kind))).toEqual([
      ["title", "facts"],
      ["head", "para", "sub"],
      ["head"],
    ]);
  });

  it("has no sections at all in an empty document, and one in a document with no headings", () => {
    expect(sectionsOf([])).toEqual([]);
    expect(sectionsOf([{ kind: "para", text: "A note." }, { kind: "para", text: "Another." }])).toHaveLength(1);
  });
});
