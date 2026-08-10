// Dollars-as-text to integer cents and back. The `cost` people type stays the
// display value ("1,240", "$95.50", "call for quote"); this is the summable
// copy reports read. Parsing is deliberately conservative: anything not
// unambiguously money-shaped is null, never a guess - "$1.2k" summed as $1.20
// is worse than not summing it at all.

const MONEY = /^\$?\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\$?\d+(\.\d{1,2})?$/;

export function parseMoney(input: string): number | null {
  const s = input.trim();
  if (!s || !MONEY.test(s)) return null;
  const n = parseFloat(s.replace(/^\$/, "").replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/**
 * Cents back into the shape someone would have typed into a cost field -
 * no "$", commas kept, ".00" dropped. Round-trips through parseMoney, so a
 * value the server fills in (price-book autofill) re-parses to the same cents
 * on the next edit.
 */
export function centsToInput(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function formatCents(cents: number): string {
  const dollars = cents / 100;
  return dollars.toLocaleString("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}
