// The house document style, as the style guide states it.
//
// "How our letters, proposals, quotes, and reports should look" - Sierra
// Spectra Document Style Guide v1.0, September 2026. Everything a generated
// document needs to follow it is here in one place: the palette, the page,
// the wordmark, the header tag, the footer, the file name. The two renderers
// (lib/docxRender for Word, lib/pdfRender for the PDF a client is sent) read
// these and nothing else, so the Word file and the PDF cannot drift apart,
// and a change to the guide is a change to one file.
//
// These are DOCUMENT colours, not the app's. The screen palette in
// globals.css is the product; this is the paper, and the guide fixes it to
// the hex values below. They are deliberately not tokens.
//
// Pure.

import type { ProposalBlock } from "@/lib/proposal";

export const DOC_COLOR = {
  /** All body text, document titles, H2 headings, the wordmark. */
  ink: "1E2035",
  /** H1 section headings, the header document tag, callouts. The one accent. */
  coral: "E8756A",
  /** Subtitles, captions, secondary contact lines, table notes. */
  slate: "64748B",
  /** Footer text only. */
  mist: "94A3B8",
  /** Table header text and field labels. */
  sky: "7BAFD4",
  /** Table header row fill, label cells. */
  paper: "F8F7F5",
  /** The recommended option in a comparison. */
  blush: "FDF2F1",
  /** Table borders and rules. Always hairline. */
  line: "E2E8F0",
} as const;

/** Five equal segments, 3pt tall, under the header. The only place these appear. */
export const SPECTRUM = ["E8756A", "E8A370", "C5D44A", "7BAFD4", "9B8EB8"] as const;

/** US Letter, in points. 0.75" sides, 1.0" top (clears the header), 0.625" bottom. */
export const PAGE = {
  width: 612, height: 792,
  left: 54, right: 54, top: 72, bottom: 45,
  /** Header and footer offset from the edge: 0.43" and 0.35". */
  headerFromEdge: 31, footerFromEdge: 25,
  /** The spectrum bar: 3pt tall. */
  barHeight: 3,
} as const;

/** The sizes the guide fixes, in points. Never scaled to fit; cut words instead. */
export const SIZE = {
  title: 18, subtitle: 10, h1: 12, h2: 10, body: 10, table: 9.5, lead: 9.5,
  wordmark: 8, tag: 7, footer: 6.5,
} as const;

export type DocType = "Proposal" | "Quote" | "Letter" | "Report";

/** Everything a renderer needs: the words, and the frame around them. */
export type DocSpec = {
  type: DocType;
  /** The header tag, right side, coral, all caps: "LABZEN PROPOSAL", "QUOTE 030215". */
  tag: string;
  /** The client's name, for the confidentiality line. Blank for an internal document. */
  client: string;
  number: string;
  /** Who we are, typed as the wordmark. */
  operatorName: string;
  /** Footer line 1: who we are and how to reach us. */
  contactLine: string;
  blocks: ProposalBlock[];
};

/**
 * The document in sections: a heading and everything under it, up to the next
 * heading. Whatever comes before the first heading - a title, the summary
 * block - is the opening section.
 *
 * A section is the unit a reader takes in at once, so it is also the unit that
 * should not be torn in half by a page break. All three renderers (PDF, Word,
 * the print page) group by this one function, so what stays together in the
 * PDF stays together in the others.
 */
export function sectionsOf(blocks: ProposalBlock[]): ProposalBlock[][] {
  const out: ProposalBlock[][] = [];
  for (const b of blocks) {
    if (b.kind === "head" || !out.length) out.push([b]);
    else out[out.length - 1].push(b);
  }
  return out;
}

/**
 * The wordmark, typed: S I E R R A  •  S P E C T R A. Capital letters, one
 * space between each, a bullet between the words. Never the logo image.
 */
export function wordmark(operatorName: string): string {
  const words = operatorName.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  return words.map((w) => [...w].join(" ")).join("  \u2022  ");
}

/**
 * The header tag: the document type and, for a client document, the client.
 * A proposal is named for the client ("AVANCE BIO PROPOSAL"); a quote for its
 * number ("QUOTE 030215"), which is what a purchasing desk files it under.
 */
export function docTag(type: DocType, opts: { client?: string; number?: string }): string {
  // The number is carried as issued - 030304_In1 stays In1 - because it is
  // what the client's purchasing desk will type back; only the words are caps.
  if (type === "Quote" && opts.number) return `QUOTE ${opts.number.trim()}`;
  return [opts.client, type].filter(Boolean).join(" ").toUpperCase();
}

/**
 * How a table's width is shared between its columns.
 *
 * A "#" column is a number under ten and takes half a share; the first text
 * column carries the description or the feature label and takes two; the
 * rest one each. Both renderers ask here, so the Word file and the PDF set
 * the same column at the same width.
 */
export function columnShares(head: string[]): number[] {
  const firstText = head.findIndex((h) => h.trim() !== "#");
  return head.map((h, i) => (h.trim() === "#" ? 0.5 : head.length >= 3 && i === firstText ? 2 : 1));
}

/**
 * A cell that opens with spaces is a detail under the row above it - the
 * modules a system covers, under the system - and prints indented and in
 * Slate. The spaces themselves are the mark and are not printed.
 */
export function cellIndent(text: string): { text: string; indent: boolean } {
  const m = /^\s{2,}(\S.*)$/s.exec(text);
  return m ? { text: m[1], indent: true } : { text, indent: false };
}

/** "CONFIDENTIAL – Prepared for LabZen  |  Page N". Internal documents say Page N only. */
export function footerLine2(client: string, page: number | string): string {
  return client.trim()
    ? `CONFIDENTIAL \u2013 Prepared for ${client.trim()}  |  Page ${page}`
    : `Page ${page}`;
}

/**
 * Type_QuoteNumber_Client.ext - "Proposal_030215_Ar3_AvanceBio.docx".
 *
 * The revision the guide asks for is already inside the quote number the shop
 * issues (030215_Ar3), so the number is carried as typed, with anything that
 * is not a word character made an underscore. The client is the short name
 * with the spaces taken out.
 */
export function docFileName(type: DocType, number: string, client: string, ext: "pdf" | "docx"): string {
  const num = number.trim().replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "") || "draft";
  const who = client.replace(/[^A-Za-z0-9]+/g, "") || "Client";
  return `${type}_${num}_${who}.${ext}`;
}

/** The download headers for a generated document. */
export function docHeaders(fileName: string, ext: "pdf" | "docx"): Record<string, string> {
  return {
    "Content-Type": ext === "pdf"
      ? "application/pdf"
      : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "Content-Disposition": `attachment; filename="${fileName}"`,
  };
}

/**
 * The characters a PDF's standard fonts can draw. Helvetica and Courier are
 * WinAnsi; a right arrow or a tick pasted from a web page is not, and pdf-lib
 * throws on it rather than drawing a box. Word has no such limit, so this is
 * the PDF renderer's concern alone, but it lives here beside the rest of the
 * paper rules.
 */
export function winAnsi(s: string): string {
  return s
    .replace(/\u2192/g, "->").replace(/\u2190/g, "<-")
    .replace(/[\u2713\u2714]/g, "yes").replace(/[\u2717\u2718]/g, "no")
    .replace(/\u2265/g, ">=").replace(/\u2264/g, "<=").replace(/\u2260/g, "!=").replace(/\u2212/g, "-")
    .replace(/\u00A0/g, " ")
    .replace(/[^ -\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u20AC\u2122]/g, "");
}
