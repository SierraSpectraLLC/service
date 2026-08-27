/**
 * The rules for entering paper that was already resolved elsewhere.
 *
 * Pure, and separate from the actions that write the rows, because these are
 * the checks that decide whether a migration produces a faithful ledger or a
 * quietly wrong one. Two of them earn their keep on their own:
 *
 *   NOTHING IN THE FUTURE. History is behind us. A future issue date is a
 *   typo, and a typo that puts a phantom receivable on the books - which then
 *   shows up in a balance, an aging bucket and a dunning ladder.
 *
 *   NOTHING PAID BEFORE IT WAS ISSUED. Same for a quote answered before it was
 *   sent. Both are how a fat-fingered year lands in the data, and both are
 *   invisible afterwards: the invoice looks fine, the dates just do not make
 *   sense to anybody who reads them later.
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (s: string): boolean => ISO.test(s.trim());

export type BackfillLine = { kind: string; description: string; qty: number; unitCents: number };

export const INVOICE_OUTCOMES = ["paid", "open", "void"] as const;
export const QUOTE_OUTCOMES = ["approved", "declined", "expired"] as const;
/**
 * How a past purchase order ended.
 *
 * Received is the ordinary one - the parts arrived, which is the whole reason
 * anybody types an old PO in. Cancelled is kept because a cancelled order is
 * part of the vendor conversation and its number is spent either way; "sent"
 * exists for the order that is genuinely still outstanding when the shop
 * migrates mid-flight.
 */
export const PO_OUTCOMES = ["received", "sent", "cancelled"] as const;

/** What the lines come to, in cents. Quantities are whole units here, not thousandths. */
export const backfillTotal = (lines: BackfillLine[]): number =>
  lines.reduce((n, l) => n + Math.round((Number.isFinite(l.qty) ? l.qty : 0) * Math.round(l.unitCents)), 0);

/** Lines worth keeping: something said, or something charged. */
export const usableLines = (lines: BackfillLine[]): BackfillLine[] =>
  lines.filter((l) => l.description.trim() || Math.round(l.unitCents));

/**
 * Why this historical invoice cannot be recorded, or "" when it can.
 *
 * One string rather than a thrown error or a field map: the dialog shows one
 * problem at a time, and the action returns one, so having one author for both
 * is what keeps them from drifting into different answers.
 */
export function invoiceProblem(
  d: { issuedOn: string; outcome: string; paidOn: string; lines: BackfillLine[] },
  today: string,
): string {
  const issued = d.issuedOn.trim();
  if (!isDay(issued)) return "Pick the date it was issued";
  if (issued > today) return "That date is in the future - this is for paper already issued";

  const lines = usableLines(d.lines);
  if (!lines.length) return "Add at least one line - an invoice with nothing on it says nothing";

  if (d.outcome === "paid") {
    // Blank means it was settled the day it went out, which is the common case
    // for the counter sale somebody is typing in from a receipt book.
    const paid = d.paidOn.trim() || issued;
    if (!isDay(paid)) return "Pick the date the money arrived";
    if (paid > today) return "The payment date is in the future";
    if (paid < issued) return "It cannot have been paid before it was issued";
    if (backfillTotal(lines) <= 0) return "A paid invoice needs an amount";
  }
  return "";
}

/** Why this historical quote cannot be recorded, or "" when it can. */
export function quoteProblem(
  d: { title: string; sentOn: string; answeredOn: string; lines: BackfillLine[] },
  today: string,
): string {
  if (!d.title.trim()) return "Say what the quote was for";
  const sent = d.sentOn.trim();
  if (!isDay(sent)) return "Pick the date it went out";
  if (sent > today) return "That date is in the future - this is for paper already sent";

  if (!usableLines(d.lines).length) return "Add at least one line";

  const answered = d.answeredOn.trim() || sent;
  if (!isDay(answered)) return "Pick the date they answered";
  if (answered < sent) return "They cannot have answered before it was sent";
  if (answered > today) return "The answer date is in the future";
  return "";
}

/**
 * The invoice status a recorded outcome lands on BEFORE payments are counted.
 *
 * "paid" opens at sent on purpose: the payment is then written as a real
 * payments row and the balance is summed from it, the same as every other
 * invoice in the app. Setting the status directly would make history the one
 * place where a balance is asserted rather than derived - and the day those
 * two disagree is the day somebody stops trusting the ledger.
 */
export const openingStatus = (outcome: string): string => (outcome === "void" ? "void" : "sent");

export type BackfillPoLine = { partNumber: string; name: string; qty: number; unitCents: number };

/** The lines a past purchase order can actually be written from. */
export const usablePoLines = (lines: BackfillPoLine[]): BackfillPoLine[] =>
  lines.filter((l) => l.partNumber.trim() || l.name.trim());

/**
 * What is wrong with a past purchase order, or null.
 *
 * A part NUMBER is the required thing rather than a name, because a PO whose
 * lines cannot be matched to a part number is a receipt, not an order - the
 * whole value of typing an old one in is that a part on a shelf can be traced
 * back to what was paid for it.
 */
export function poProblem(input: {
  vendor: string;
  orderedOn: string;
  outcome: string;
  lines: BackfillPoLine[];
}): string | null {
  if (!input.vendor.trim()) return "Say who it was ordered from";
  if (!isDay(input.orderedOn)) return "Pick the day it was ordered";
  if (!(PO_OUTCOMES as readonly string[]).includes(input.outcome)) return "Say how it ended";
  const lines = usablePoLines(input.lines);
  if (!lines.length) return "Add at least one line with a part number";
  if (lines.some((l) => !l.partNumber.trim())) {
    return "Every line needs a part number - a line without one cannot be traced back to a part";
  }
  if (lines.some((l) => l.qty <= 0)) return "A line with no quantity is not an order";
  return null;
}
