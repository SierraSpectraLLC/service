// Getting paid for handing a client over.
//
// Two shapes, and they are not variants of each other.
//
//   FLAT. "$2,000 to accept this client." Owed the moment somebody accepts,
//   known exactly, and settled once. The referrer's risk is nil and the
//   recipient is buying a lead sight-unseen, which is why the whole list is
//   shown before the button.
//
//   PERCENT. "5% of what you bill them in the first twelve months." Owed as
//   the work happens, worth nothing if the client never spends, and worth a
//   great deal if they do. It is the fairer instrument and the harder one,
//   because the number it is a percentage OF lives in somebody else's
//   database.
//
// WHICH IS THE HONEST PROBLEM AT THE HEART OF THIS FILE. The referrer cannot
// see the recipient's books and must not: that is the line the whole
// application is built along. So the aggregate is computed inside the payer's
// own workspace, from their own invoices against that client, and ONE NUMBER
// crosses - never an invoice, never a line, never a date.
//
// And where that number came from is itself a fact worth carrying. 'invoices'
// means it was summed from rows in the payer's ledger; 'reported' means a
// person typed it. Both are legitimate - a shop that bills outside Ridgeline
// can only self-report - but they are different kinds of claim, and a screen
// that showed them identically would be inviting somebody to read the second
// as the first. Every surface here says which one it is.
//
// Pure. Callers hand in the rows.

export const FEE_KINDS = ["none", "flat", "percent", "either"] as const;
export type FeeKind = (typeof FEE_KINDS)[number];

export const FEE_LABEL: Record<FeeKind, string> = {
  none: "No fee",
  flat: "A fee to accept",
  percent: "A share of what they bill",
  either: "Either - they choose",
};

/**
 * "5% of the first year, OR $2,000 up front - your choice."
 *
 * Not a discount and not a haggle: it is an offer of two DIFFERENT RISKS, and
 * whoever takes it is choosing which one they want. Flat is certainty - they
 * know the cost before they know the client. Percent is pay-as-you-earn - it
 * costs nothing if the account goes nowhere and more than the flat fee if it
 * goes well. Neither side can know at acceptance which turns out cheaper,
 * which is exactly what makes the choice worth offering rather than a trap.
 *
 * The choice is recorded on the FEE, not on the share: the share says what was
 * offered and stays true afterwards, and the fee says what was agreed.
 */
export function resolveChoice(t: FeeTerms, choice: string): FeeTerms {
  if (t.kind !== "either") return t;
  /*
   * Each side drops what belongs to the other, so the agreed row carries one
   * answer to one question. A floor and a cap belong to the percentage -
   * taking the flat side means taking a single number, and a "minimum"
   * alongside it would be a second answer. Equally, a percent that kept the
   * flat amount would sit there reading like a price nobody agreed to.
   */
  return choice === "flat"
    ? { ...t, kind: "flat", feeBps: 0, minCents: 0, maxCents: 0 }
    : { ...t, kind: "percent", feeCents: 0 };
}

/** Which kinds an offer actually lets somebody pick between. */
export const choicesFor = (kind: string): FeeKind[] =>
  (kind === "either" ? ["percent", "flat"] : []);

/** What the referrer is asking, as written on the offer. */
export type FeeTerms = {
  kind: string;
  feeCents: number;
  feeBps: number;
  windowMonths: number;
  /** percent only: never less than this once they have billed anything. 0 = no floor. */
  minCents: number;
  /** percent only: never more than this, however well the account goes. 0 = no cap. */
  maxCents: number;
  note: string;
};

export type FeeRow = {
  kind: string;
  feeCents: number;
  feeBps: number;
  minCents: number;
  maxCents: number;
  startsOn: string;
  endsOn: string;
  billedCents: number;
  billedFrom: string;
  paidCents: number;
  status: string;
};

export const MAX_WINDOW_MONTHS = 60;
/** Half of what somebody bills is not a referral fee, it is a partnership. */
export const MAX_FEE_BPS = 5000;

/** Everything wrong with the terms on an offer. Empty means they can go out. */
export function termsProblems(t: FeeTerms): string[] {
  const out: string[] = [];
  if (t.kind === "none") return out;
  if (!FEE_KINDS.includes(t.kind as FeeKind)) return ["Pick a fee, or none"];
  if ((t.kind === "flat" || t.kind === "either") && t.feeCents <= 0) {
    out.push("Say what it costs to accept");
  }
  if (t.kind === "percent" || t.kind === "either") {
    if (t.feeBps <= 0) out.push("Say what share you are asking for");
    if (t.feeBps > MAX_FEE_BPS) out.push(`Keep it under ${MAX_FEE_BPS / 100}%`);
    if (t.windowMonths <= 0) out.push("Say how long it runs for");
    if (t.windowMonths > MAX_WINDOW_MONTHS) out.push(`Keep the window under ${MAX_WINDOW_MONTHS} months`);
    if (t.minCents < 0 || t.maxCents < 0) out.push("A floor and a cap cannot be negative");
    if (t.minCents > 0 && t.maxCents > 0 && t.minCents > t.maxCents) {
      // Otherwise the cap silently wins on every single fee and the floor is a
      // number somebody typed that can never do anything.
      out.push("The floor is above the cap");
    }
  }
  return out;
}

/** The last day of the window. A flat fee has none. */
export function windowEnd(startsOn: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startsOn.trim());
  if (!m || months <= 0) return "";
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const total = (mo - 1) + Math.round(months);
  const year = y + Math.floor(total / 12);
  const month = (total % 12) + 1;
  // Clamp into the month, so a window opened on the 31st ends on the 30th
  // rather than sliding into the next month - same rule as a billing cycle.
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = new Date(Date.UTC(year, month - 1, Math.min(d, last)));
  // The last day INSIDE the window, so a twelve-month window opened on Sep 29
  // closes on Sep 28 - the day before the anniversary, like a contract period.
  return new Date(end.getTime() - 86_400_000).toISOString().slice(0, 10);
}

/**
 * What is owed in total, so far.
 *
 * A flat fee is its own amount from the moment it exists. A percent is a share
 * of whatever has been billed - which is zero until somebody bills something,
 * and that zero is a real answer rather than a missing one.
 */
export function accruedCents(f: FeeRow): number {
  if (f.status === "waived") return 0;
  if (f.kind === "flat") return Math.max(0, Math.round(f.feeCents));
  if (f.kind !== "percent") return 0;

  const billed = Math.max(0, f.billedCents);
  const share = Math.round((billed * Math.max(0, f.feeBps)) / 10000);
  /*
   * THE FLOOR ONLY APPLIES ONCE THEY HAVE BILLED SOMETHING, and that is the
   * one judgement in this file worth arguing about.
   *
   * A minimum that applied from day one would be a guaranteed payment wearing
   * a percentage's clothes - and the whole reason somebody takes the percent
   * side is to avoid paying for a referral that goes nowhere. Charging a floor
   * on a client who never spent a dollar is charging for nothing, and it is
   * exactly the case where the recipient would feel cheated and be right.
   *
   * So: nothing billed, nothing owed. A dollar billed, and the floor is the
   * fee. The label says so out loud rather than leaving it to be discovered.
   */
  const floored = billed > 0 ? Math.max(share, Math.max(0, f.minCents)) : share;
  const cap = Math.max(0, f.maxCents);
  return cap > 0 ? Math.min(floored, cap) : floored;
}

/** What is still owed. Never negative: an overpayment is a credit, not a debt. */
export const outstandingCents = (f: FeeRow): number =>
  Math.max(0, accruedCents(f) - Math.max(0, f.paidCents));

/**
 * What is owed once an invoice may exist for it.
 *
 * ONCE IT IS ON AN INVOICE, THE INVOICE IS THE ANSWER. The fee stops keeping
 * its own count the moment one is raised: payments, credits, partial
 * settlement and write-offs all land on the invoice, and a second tally beside
 * it would be free to drift - and would drift in front of whoever was being
 * chased. Same rule lib/agreements states about stored balances.
 *
 * Structural rather than typed to the ledger row, so this stays pure and the
 * client bundle can reach it. lib/referralData does the fetching.
 */
export const feeOutstanding = (f: FeeRow & { invoice?: { balanceCents: number } | null }): number =>
  (f.invoice ? f.invoice.balanceCents : outstandingCents(f));

export const FEE_STANDINGS = ["due", "accruing", "settled", "waived", "closed"] as const;
export type FeeStanding = (typeof FEE_STANDINGS)[number];

export const STANDING_LABEL: Record<FeeStanding, string> = {
  due: "Due",
  accruing: "Accruing",
  settled: "Settled",
  waived: "Waived",
  closed: "Window closed",
};

/**
 * Where a fee stands today.
 *
 * ACCRUING and CLOSED are the two the percent case needs and the flat case has
 * no use for: a percent with nothing outstanding is not settled, it is waiting
 * for the other shop to do some work, and saying "settled" would tell both
 * sides the arrangement was over when it has not started.
 */
export function feeStanding(f: FeeRow, today: string): FeeStanding {
  if (f.status === "waived") return "waived";
  if (outstandingCents(f) > 0) return "due";
  if (f.kind === "percent") {
    if (f.endsOn && f.endsOn < today) return accruedCents(f) > 0 ? "settled" : "closed";
    return "accruing";
  }
  return "settled";
}

/** The sentence on the offer: what accepting costs. */
export function termsLine(t: FeeTerms, fmt: (c: number) => string): string {
  const tail = t.note ? ` - ${t.note}` : "";
  const pct = (t.feeBps / 100).toFixed(t.feeBps % 100 === 0 ? 0 : 1);
  const months = Math.round(t.windowMonths);
  const bounds = boundsPhrase(t, fmt);
  const share = `${pct}% of what you bill them in the first ${months} month${months === 1 ? "" : "s"}${bounds}`;
  if (t.kind === "flat") return `${fmt(t.feeCents)} to accept${tail}`;
  if (t.kind === "percent") return `${share}${tail}`;
  // The choice leads with the share, because that is the one somebody has to
  // think about; the flat figure is the thing they already understand.
  if (t.kind === "either") return `${share}, or ${fmt(t.feeCents)} to accept - your choice${tail}`;
  return "No fee";
}

/**
 * "at least $1,500 once they bill anything, and never over $10,000".
 *
 * Spelled out rather than shortened to "min/max" because the floor's condition
 * is the part people get wrong, and a phrase that hides it would be the wrong
 * kind of concise.
 */
export function boundsPhrase(
  t: Pick<FeeTerms, "minCents" | "maxCents">, fmt: (c: number) => string,
): string {
  const parts: string[] = [];
  if (t.minCents > 0) parts.push(`at least ${fmt(t.minCents)} once they bill anything`);
  if (t.maxCents > 0) parts.push(`never over ${fmt(t.maxCents)}`);
  return parts.length ? ` - ${parts.join(", ")}` : "";
}

/**
 * The line on a ledger, and it always says where the number came from.
 *
 * "on $48,000 billed" and "on $48,000 reported" are different claims and the
 * difference is the whole integrity of the percent case.
 */
export function feeLine(f: FeeRow, fmt: (c: number) => string): string {
  if (f.kind === "flat") {
    const left = outstandingCents(f);
    return left > 0 ? `${fmt(left)} due` : `${fmt(f.feeCents)} settled`;
  }
  const basis = f.billedFrom === "reported" ? "reported" : "billed";
  const pct = (f.feeBps / 100).toFixed(f.feeBps % 100 === 0 ? 0 : 1);
  const raw = Math.round((Math.max(0, f.billedCents) * Math.max(0, f.feeBps)) / 10000);
  const got = accruedCents(f);
  // Say WHICH bound moved the number. "5% of $10,000 = $1,500" reads as an
  // arithmetic error unless the line admits the floor did it.
  const why = f.status === "waived" || got === raw ? ""
    : got > raw ? " (the floor)"
      : " (the cap)";
  return `${pct}% of ${fmt(f.billedCents)} ${basis} = ${fmt(got)}${why}`
    + (f.paidCents > 0 ? `, ${fmt(f.paidCents)} paid` : "")
    + (outstandingCents(f) > 0 ? `, ${fmt(outstandingCents(f))} due` : "");
}

/** Is this day inside the window work counts in? */
export const inWindow = (f: Pick<FeeRow, "startsOn" | "endsOn">, day: string): boolean =>
  (!f.startsOn || day >= f.startsOn) && (!f.endsOn || day <= f.endsOn);
