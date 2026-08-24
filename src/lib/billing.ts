// An invoice, composed from the work that was actually done.
//
// The rule this file exists to keep is lib/agreements' rule, one level up:
// NOTHING HERE IS STORED. An invoice's total, what the contract covered, what
// is left to pay - all of it is summed from rows when somebody looks. A stored
// total is a second copy of a number the lines already carry, free to drift
// from them, and the drift is always found in front of the client.
//
// Coverage is not decided here either. lib/agreements already answers "is this
// covered, and how much is left"; this file ASKS it and labels the lines. A
// second implementation of drawdown is how the invoice and the contract page
// start disagreeing about the same agreement.
//
// The covered line is the interesting case: it renders at zero, keeps its list
// price on the row, and names the agreement. A $0 invoice is a feature - it
// puts the visit on the record, shows the client the contract working, and
// gives next year's renewal quote something to cite.
//
// Pure. Callers hand in the rows.

import { formatCents } from "@/lib/money";
import { priceTime, type RateCard } from "@/lib/rates";

/** What kind of out-of-pocket it was. Drives nothing but the label. */
export const EXPENSE_KINDS = ["mileage", "shipping", "per_diem", "other"] as const;
export type ExpenseKind = (typeof EXPENSE_KINDS)[number];

export const EXPENSE_LABEL: Record<string, string> = {
  mileage: "Mileage", shipping: "Shipping", per_diem: "Per diem", other: "Other",
};

export const LINE_KINDS = ["part", "labor", "travel", "expense", "tax", "fee_ref"] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export type DraftLine = {
  kind: LineKind;
  description: string;
  /** Hours for labor, units for parts, 1 for a single charge. */
  qty: number;
  unitCents: number;
  /**
   * Covered by an agreement: the line prints at $0 with its list price still
   * shown, and says which paper covered it.
   */
  covered: boolean;
  /** The agreement that covered it, for the label. */
  coveredBy?: string;
  /** The row this came from - part id, time entry id, expense id. */
  sourceId: number | null;
};

/** What a line adds to the bill. Covered lines add nothing, by definition. */
export const lineAmount = (l: Pick<DraftLine, "qty" | "unitCents" | "covered">): number =>
  l.covered ? 0 : Math.round(l.qty * l.unitCents);

/** What the lines add up to. The only place an invoice total comes from. */
export const linesTotal = (lines: DraftLine[]): number =>
  lines.reduce((n, l) => n + lineAmount(l), 0);

/** The list value of what the agreement absorbed - the burn-down figure. */
export const coveredValue = (lines: DraftLine[]): number =>
  lines.filter((l) => l.covered).reduce((n, l) => n + Math.round(l.qty * l.unitCents), 0);

export type CoverageAnswer = {
  /** The agreement covering this work, if any. Its number labels the lines. */
  agreementNumber: string;
  agreementId: number | null;
  /** Labor is inside the retainer. */
  labor: boolean;
  /** Parts draw from the allowance rather than being billed. */
  parts: boolean;
  /**
   * The allowance is spent. Work still bills - at the rate card, labelled
   * "beyond contract" - because silently doing it for free is how a retainer
   * turns into an unpriced obligation.
   */
  exhausted: boolean;
};

export const NO_COVERAGE: CoverageAnswer = {
  agreementNumber: "", agreementId: null, labor: false, parts: false, exhausted: false,
};

/**
 * Which agreement, if any, is answering for this work today.
 *
 * The decision of what a paper covers belongs to lib/agreements; this picks
 * the paper. In force, for this client, covering this system (an empty
 * instrument list covers all of theirs) - and among several, the one that ends
 * soonest, because that is the entitlement being spent first.
 */
export function coverageFor(input: {
  agreements: {
    id: number; number: string; orgId: number; status: string;
    startsOn: string; endsOn: string; instrumentIds: number[];
    laborCovered: boolean; partsCovered: boolean;
  }[];
  orgId: number | null;
  instrumentId: number | null;
  today: string;
  /** True when the visit or parts allowance this paper carries is spent. */
  exhausted?: boolean;
}): CoverageAnswer {
  if (input.orgId === null) return NO_COVERAGE;
  const live = input.agreements
    .filter((a) => a.orgId === input.orgId && a.status === "active")
    .filter((a) => (!a.startsOn || a.startsOn <= input.today) && (!a.endsOn || a.endsOn >= input.today))
    .filter((a) => a.instrumentIds.length === 0 || (input.instrumentId !== null && a.instrumentIds.includes(input.instrumentId)))
    .sort((a, b) => (a.endsOn || "9999").localeCompare(b.endsOn || "9999"));
  const a = live[0];
  if (!a) return NO_COVERAGE;
  return {
    agreementNumber: a.number, agreementId: a.id,
    labor: a.laborCovered, parts: a.partsCovered,
    exhausted: input.exhausted ?? false,
  };
}

/**
 * What a part sells for: what it landed at, plus the markup, rounded to the
 * cent. A part with no recorded cost sells for nothing rather than for a
 * guess - a $0 line on the draft is a question somebody answers before send,
 * where an invented price is one nobody notices.
 */
export const sellPrice = (costCents: number | null, markupBps: number): number =>
  costCents === null || costCents <= 0 ? 0 : Math.round((costCents * (10000 + Math.max(0, markupBps))) / 10000);

export type PartRow = {
  id: number; name: string; partNumber: string; qty: number | null;
  /** What it cost us. The sell price comes from the price book. */
  costCents: number | null;
};
export type TimeRow = {
  id: number; minutes: number; category: string; billable: boolean;
  person: string; date: string; note: string;
};
export type ExpenseRow = {
  id: number; kind: string; description: string; amountCents: number;
};

/** "beyond contract" is a label a client should read before the number. */
const BEYOND = "beyond contract";

/**
 * Every line an invoice for this work order would carry, in reading order:
 * parts, labor, travel, expenses, then tax on the parts.
 *
 * `sellCents` prices a part - the price book's number, markup already applied
 * by the caller, falling back to what it cost us when the book has never heard
 * of it. Handing it in keeps the price book's own resolution (vendor, OEM
 * preference, staleness) out of here.
 */
export function buildInvoiceLines(input: {
  parts: PartRow[];
  time: TimeRow[];
  expenses: ExpenseRow[];
  rate: RateCard;
  coverage: CoverageAnswer;
  sellCents: (p: PartRow) => number;
  /** Basis points on the parts subtotal. Zero draws no line. */
  taxRateBps?: number;
  taxLabel?: string;
}): DraftLine[] {
  const { coverage: cov } = input;
  const lines: DraftLine[] = [];
  const partsCovered = cov.parts && !cov.exhausted;
  const laborCovered = cov.labor && !cov.exhausted;
  const beyond = cov.exhausted && (cov.parts || cov.labor) ? ` - ${BEYOND}` : "";

  for (const p of input.parts) {
    const qty = Math.max(1, Math.round(p.qty ?? 1));
    lines.push({
      kind: "part",
      description: `${p.partNumber ? `${p.partNumber} ` : ""}${p.name}`.trim() + beyond,
      qty, unitCents: input.sellCents(p),
      covered: partsCovered,
      ...(partsCovered ? { coveredBy: cov.agreementNumber } : {}),
      sourceId: p.id,
    });
  }

  // Hours group by category so the invoice reads "9 h on site", not nine
  // one-hour lines - and travel prices at its own rate on its own line.
  for (const category of ["onsite", "remote", "travel"]) {
    const rows = input.time.filter((t) => t.billable && t.category === category);
    if (!rows.length) continue;
    const minutes = rows.reduce((n, t) => n + t.minutes, 0);
    const priced = priceTime(minutes, category, input.rate);
    if (priced.minutes === 0) continue;
    const who = [...new Set(rows.map((t) => t.person).filter(Boolean))].join(", ");
    lines.push({
      kind: category === "travel" ? "travel" : "labor",
      description: (category === "travel" ? "Travel" : category === "remote" ? "Labor, remote" : "Labor, on site")
        + (who ? ` - ${who}` : "") + beyond,
      qty: priced.hours, unitCents: priced.hourlyCents,
      covered: laborCovered,
      ...(laborCovered ? { coveredBy: cov.agreementNumber } : {}),
      sourceId: null,
    });
  }

  for (const e of input.expenses) {
    lines.push({
      kind: "expense",
      description: e.description || e.kind,
      qty: 1, unitCents: e.amountCents,
      covered: false,
      sourceId: e.id,
    });
  }

  // Tax rides on the parts that are actually being billed: a part the contract
  // absorbed was not sold, so it is not taxed.
  const bps = input.taxRateBps ?? 0;
  if (bps > 0) {
    const partsBase = lines.filter((l) => l.kind === "part").reduce((n, l) => n + lineAmount(l), 0);
    const tax = Math.round((partsBase * bps) / 10000);
    if (tax > 0) {
      lines.push({
        kind: "tax",
        description: input.taxLabel || `Sales tax, parts only (${(bps / 100).toFixed(2)}%)`,
        qty: 1, unitCents: tax, covered: false, sourceId: null,
      });
    }
  }
  return lines;
}

/**
 * What a client owes on an invoice right now: its lines, plus any fees posted
 * against it, less what has been paid.
 *
 * Fees are their own rows and never edit a line - an invoice that changed
 * after it was sent is one nobody can reconcile against the copy in their
 * inbox. Disputed lines still count toward the total; what they change is what
 * the reminders ASK for, which is `payableNow`.
 */
export function invoiceBalance(input: {
  lines: Pick<DraftLine, "qty" | "unitCents" | "covered">[];
  feeCents?: number[];
  paidCents?: number[];
}): { linesCents: number; feesCents: number; paidCents: number; balanceCents: number } {
  const linesCents = input.lines.reduce((n, l) => n + lineAmount(l), 0);
  const feesCents = (input.feeCents ?? []).reduce((n, c) => n + c, 0);
  const paid = (input.paidCents ?? []).reduce((n, c) => n + c, 0);
  return { linesCents, feesCents, paidCents: paid, balanceCents: linesCents + feesCents - paid };
}

/**
 * What the reminders may ask for: the balance, less anything under dispute.
 *
 * The undisputed remainder keeps aging and keeps being asked for. A dispute
 * over one $340 cartridge must not buy a client ninety quiet days on the other
 * $840, and quoting the whole number at somebody who has raised a real
 * question is how the rest of the invoice stops getting paid too.
 */
export function payableNow(input: {
  balanceCents: number;
  disputedCents: number;
}): number {
  return Math.max(0, input.balanceCents - Math.max(0, input.disputedCents));
}

/**
 * The two silent AP rejections, caught at the desk instead of at day 45: an
 * invoice with no PO to quote, and one that would overrun the PO it quotes.
 *
 * Always a warning, never a block. The work is done; refusing to draft the
 * invoice does not un-do it, and a shop that cannot invoice without a PO
 * number on file is a shop that stops invoicing.
 */
export function poCheck(org: { poNumber: string; poBalanceCents: number }, totalCents: number): string {
  const po = (org.poNumber ?? "").trim();
  if (!po) return "No PO on file for this client - AP will likely bounce the invoice. Ask for one before you send.";
  if (org.poBalanceCents > 0 && totalCents > org.poBalanceCents) {
    return `${po} has ${formatCents(org.poBalanceCents)} remaining, short of this invoice - the balance will be rejected.`;
  }
  return "";
}

/**
 * Margin on a job, while the invoice is still in front of somebody.
 *
 * Loaded labor rather than the wage: an hour costs the shop its share of the
 * van, the phone and the insurance whether or not it was sold. Costing against
 * the raw wage is how a shop concludes every job is profitable.
 */
export function jobCost(input: {
  lines: DraftLine[];
  partsCostCents: number;
  billedMinutes: number;
  loadedLaborCents: number;
  expensesCents: number;
}): { billedCents: number; costCents: number; marginCents: number; marginPct: number } {
  const billed = linesTotal(input.lines);
  const labor = Math.round((input.loadedLaborCents * input.billedMinutes) / 60);
  const cost = input.partsCostCents + labor + input.expensesCents;
  const margin = billed - cost;
  return {
    billedCents: billed, costCents: cost, marginCents: margin,
    marginPct: billed > 0 ? Math.round((margin / billed) * 100) : 0,
  };
}
