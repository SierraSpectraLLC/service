// The quote, as a document.
//
// The shop had three ways to hand a client a price: the Excel off the
// template, the proposal, and the client's link. What it did not have was the
// quote itself as paper in the house style - "Service Quote", the summary
// block, what is included, the pricing table, the terms - which is the thing
// a purchasing desk actually files. The style guide names the document type
// and its sections (Covered Systems, Pricing, Terms); this assembles it as
// blocks, the same blocks the proposal is made of, so the two renderers
// (Word, PDF) draw both documents with one set of rules.
//
// Pure. The route hands in the rows.

import { formatCents } from "@/lib/money";
import type { ProposalBlock } from "@/lib/proposal";
import type { SpecRow } from "@/lib/quotes";

export type QuoteDocLine = {
  description: string;
  detail: string;
  partNumber: string;
  /** Real units, already resolved from thousandths. */
  qty: number;
  unit: string;
  unitCents: number;
  covered: boolean;
  coveredBy: string;
};

export type QuoteDocInput = {
  number: string;
  /** The quote's own title: "12mo Full Service Contract Renewal". */
  title: string;
  customer: string;
  contact: string;
  /** Long form, "May 10, 2026". */
  date: string;
  /** "Quote good through May 30, 2026", or blank. */
  pricingValid: string;
  /** The line at the top, addressed to a person where there is one. */
  greeting: string;
  /** The specifics block, two columns of headings and points. */
  specs: { left: SpecRow[]; right: SpecRow[] };
  /** The machine the quote is for, when it is for one. */
  systems: { name: string; model: string; tag: string }[];
  lines: QuoteDocLine[];
  subtotalCents: number;
  discountCents: number;
  discountLabel: string;
  totalCents: number;
  depositPct: number;
  depositCents: number;
  note: string;
  expiresOn: string;
};

/** "3 h", "1 trip", "2" - the quantity with its unit, as the table shows it. */
const qtyText = (l: QuoteDocLine): string => {
  const q = Number.isInteger(l.qty) ? String(l.qty) : l.qty.toFixed(2).replace(/\.?0+$/, "");
  return l.unit ? `${q} ${l.unit}` : q;
};

/**
 * A spec column: a heading row is a sub-heading, the points under it a list.
 * The Excel prints the same rows bold and indented; here they are words.
 */
function specBlocks(rows: SpecRow[]): ProposalBlock[] {
  const out: ProposalBlock[] = [];
  let items: string[] = [];
  const flush = () => { if (items.length) out.push({ kind: "list", items }); items = []; };
  for (const r of rows) {
    const text = r.text.trim();
    if (!text) continue;
    if (r.sub) { items.push(text); continue; }
    flush();
    out.push({ kind: "sub", text });
  }
  flush();
  return out;
}

export function quoteDocument(q: QuoteDocInput): ProposalBlock[] {
  const out: ProposalBlock[] = [
    { kind: "title", text: "Service Quote", sub: [q.title.trim(), q.customer.trim()].filter(Boolean).join(" · ") },
    {
      kind: "facts",
      rows: ([
        ["Customer", q.customer],
        ["Date", q.date],
        ["Contact", q.contact],
        ["Quote #", q.number],
        ["System", q.systems.map((s) => s.model || s.name).filter(Boolean).join(" + ")],
        ["Pricing Valid", q.pricingValid],
      ] as [string, string][]).filter(([, v]) => v.trim()),
    },
  ];
  if (q.greeting.trim()) out.push({ kind: "para", text: q.greeting.trim() });

  // What is included: the specifics block, left column then right. The
  // guide leads with the answer, and for a quote the answer is the scope.
  const specs = [...specBlocks(q.specs.left), ...specBlocks(q.specs.right)];
  if (specs.length) {
    out.push({ kind: "head", text: "What Is Included" });
    out.push(...specs);
  }

  if (q.systems.length) {
    out.push({ kind: "head", text: "Covered Systems" });
    out.push({
      kind: "table",
      head: ["#", "Instrument", "Model", "Tag"],
      rows: q.systems.map((s, i) => [String(i + 1), s.name, s.model || "—", s.tag]),
      mono: [2, 3],
    });
  }

  // Pricing. A covered line keeps its place and prices at nothing, with the
  // agreement that pays for it named - the same rule the Excel follows. A
  // description that runs to several lines becomes the charge and its detail
  // rows under it, priced on the first.
  const rows: string[][] = [];
  for (const l of q.lines) {
    const amount = l.covered ? "—" : formatCents(Math.round(l.qty * l.unitCents));
    rows.push([
      l.description.split(/\r?\n/)[0]?.trim() || "(line)",
      l.partNumber, qtyText(l),
      l.covered ? `covered by ${l.coveredBy || "agreement"}` : formatCents(l.unitCents),
      amount,
    ]);
    const detail = [...l.description.split(/\r?\n/).slice(1), ...l.detail.split(/\r?\n/)]
      .map((s) => s.trim()).filter(Boolean);
    for (const d of detail) rows.push([`    ${d}`, "", "", "", ""]);
  }
  const foot: string[][] = [];
  if (q.discountCents > 0) {
    foot.push(["Subtotal", "", "", "", formatCents(q.subtotalCents)]);
    foot.push([q.discountLabel.trim() || "Adjustment", "", "", "", `-${formatCents(q.discountCents)}`]);
  }
  foot.push(["Total", "", "", "", formatCents(q.totalCents)]);
  out.push({ kind: "head", text: "Pricing" });
  out.push({
    kind: "table",
    head: ["Description", "Part no.", "Qty", "Unit price", "Amount"],
    rows, foot, align: ["l", "l", "r", "r", "r"], mono: [1],
  });

  // Terms: what happens on approval, how long the price holds, and anything
  // the shop wrote on the quote itself.
  const terms: string[] = [];
  if (q.depositPct > 0) {
    terms.push(`${q.depositPct}% deposit${q.depositCents > 0 ? ` (${formatCents(q.depositCents)})` : ""} due on approval; the balance is invoiced as the work is done.`);
  }
  if (q.expiresOn) terms.push(`Pricing is valid through ${q.expiresOn}.`);
  const noteLines = q.note.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (terms.length || noteLines.length) {
    out.push({ kind: "head", text: "Terms" });
    if (terms.length) out.push({ kind: "list", items: terms });
    for (const n of noteLines) out.push({ kind: "para", text: n });
  }
  return out;
}
