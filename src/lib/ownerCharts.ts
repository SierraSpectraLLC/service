// The shapes behind the owner view's charts.
//
// Pure, and separated from the page for the usual two reasons: a number an
// owner is about to act on should be arguable in a test without a database,
// and every one of these is derived from rows the page has already fetched
// rather than from a query of its own. There is one set of totals in this
// application and it lives in lib/financeData; nothing here goes back to the
// database to compute a second one.
//
// Cents throughout. Dates are YYYY-MM-DD in shop time and month keys are
// YYYY-MM, so both sort as strings and the arithmetic never touches a timezone.

/** An invoice, reduced to what a cash chart needs. */
export type CashInvoice = {
  /** Blank while draft - a draft has not been billed to anybody. */
  issuedOn: string;
  status: string;
  /** What it billed: uncovered lines plus live fees. */
  billedCents: number;
  payments: { receivedOn: string; amountCents: number }[];
};

/** The last `n` month keys ending at `today`'s month, oldest first. */
export function lastMonths(today: string, n: number): string[] {
  const [y, m] = today.split("-").map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/** "Aug", or "Jan 26" where the year turns - so a 12-month axis says which year. */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const name = new Date(Date.UTC(y, m - 1, 1))
    .toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return m === 1 ? `${name} ${String(y).slice(2)}` : name;
}

export type CashMonth = { ym: string; label: string; billedCents: number; collectedCents: number };

/**
 * What was billed and what arrived, month by month.
 *
 * TWO DIFFERENT DATES, deliberately. An invoice counts in the month it was
 * ISSUED and a payment in the month it was RECEIVED, so the gap between the two
 * lines is the collection lag - which is the whole reason an owner looks at
 * this. Counting a payment against its invoice's month would flatten that gap
 * to nothing and make the chart say the business is paid on time.
 *
 * Drafts and voids bill nothing: a draft has not been sent to anybody and a
 * void has been withdrawn. Their PAYMENTS still count, because money that
 * arrived, arrived.
 */
export function cashByMonth(invoices: CashInvoice[], months: string[]): CashMonth[] {
  const billed = new Map<string, number>();
  const collected = new Map<string, number>();
  const add = (m: Map<string, number>, key: string, cents: number) => {
    if (key) m.set(key, (m.get(key) ?? 0) + cents);
  };
  for (const inv of invoices) {
    if (inv.status !== "draft" && inv.status !== "void") {
      add(billed, inv.issuedOn.slice(0, 7), inv.billedCents);
    }
    for (const p of inv.payments) add(collected, p.receivedOn.slice(0, 7), p.amountCents);
  }
  return months.map((ym) => ({
    ym,
    label: monthLabel(ym),
    billedCents: billed.get(ym) ?? 0,
    collectedCents: collected.get(ym) ?? 0,
  }));
}

export type Debtor = { orgId: number; name: string; cents: number; invoices: number };

/**
 * Who owes the most, largest first.
 *
 * Capped, with the tail SUMMED rather than dropped: a list of five that quietly
 * omits £40,000 spread across eleven small accounts is a chart that answers
 * "who owes us" wrongly. The remainder comes back as its own row with a null
 * id, which the caller renders as context rather than as a client.
 */
export function topDebtors(
  open: { orgId: number; balanceCents: number }[],
  nameOf: (orgId: number) => string,
  limit = 6,
): { top: Debtor[]; restCents: number; restCount: number } {
  const by = new Map<number, { cents: number; invoices: number }>();
  for (const v of open) {
    if (v.balanceCents <= 0) continue;
    const cur = by.get(v.orgId) ?? { cents: 0, invoices: 0 };
    by.set(v.orgId, { cents: cur.cents + v.balanceCents, invoices: cur.invoices + 1 });
  }
  const all = [...by.entries()]
    .map(([orgId, v]) => ({ orgId, name: nameOf(orgId), cents: v.cents, invoices: v.invoices }))
    .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
  const top = all.slice(0, limit);
  const rest = all.slice(limit);
  return {
    top,
    restCents: rest.reduce((n, r) => n + r.cents, 0),
    restCount: rest.length,
  };
}

/**
 * A clean top-of-axis at or above `max`, and the ticks under it.
 *
 * Rounds up to 1, 2 or 5 times a power of ten so the axis reads 0 / 25,000 /
 * 50,000 rather than 0 / 23,817 / 47,634. An axis nobody can read at a glance
 * is chrome, and chrome that costs ink without paying for it should not be
 * drawn at all.
 */
export function niceTicks(max: number, steps = 4): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: 0, ticks: [0] };
  const rough = max / steps;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v));
  return { top, ticks };
}

export type Band = { key: string; label: string; cents: number };

/**
 * A ladder of bands, with the empty ones dropped and their share computed.
 *
 * An empty band is a segment nobody can see carrying a label nobody can read,
 * and on a stacked bar it is also a 2px gap with nothing between it and the
 * next gap. Dropping it is not hiding anything: the total is stated beside the
 * bar and the table view keeps every row.
 */
export function bands(rows: Band[]): { shown: (Band & { share: number })[]; totalCents: number } {
  const totalCents = rows.reduce((n, r) => n + r.cents, 0);
  const shown = rows
    .filter((r) => r.cents > 0)
    .map((r) => ({ ...r, share: totalCents > 0 ? r.cents / totalCents : 0 }));
  return { shown, totalCents };
}

/**
 * Whether a label fits inside a segment of a stacked bar.
 *
 * Measured, not guessed. A label that does not fit is not clipped and not
 * shrunk - it moves out or it goes to the legend and the tooltip, which is
 * lib/dataviz's rule and the reason this returns a boolean instead of a
 * truncated string. The estimate is deliberately conservative: about 6.2px per
 * character at the 11px meta size, plus 12px of padding either side.
 */
export const labelFits = (text: string, widthPx: number): boolean =>
  widthPx >= text.length * 6.2 + 24;
