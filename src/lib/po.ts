// Purchase-order math and the reorder-to-PO composer. Pure: callers hand in
// rows, tests hand in literals.
import { normalizePn, rankPrices, type PriceEntry } from "@/lib/priceBook";
import { needsReorder, shortBy, type StockLine } from "@/lib/stock";
import type { Tone } from "@/lib/tones";

export const PO_STATES = ["draft", "sent", "partial", "received", "cancelled"] as const;

export const PO_LABEL: Record<string, string> = {
  draft: "Draft",
  sent: "Ordered",
  partial: "Part-received",
  received: "Received",
  cancelled: "Cancelled",
};

export const PO_TONE: Record<string, Tone> = {
  draft: "neutral",
  sent: "info",
  partial: "warn",
  received: "good",
  cancelled: "faint",
};

/** A PO stops accepting edits once it's been sent to the vendor. */
export const poEditable = (status: string) => status === "draft";
/** ...but a sent or part-received PO is exactly what you receive against. */
export const poReceivable = (status: string) => status === "sent" || status === "partial";

export type PoLine = { qtyOrdered: number; qtyReceived: number; unitCents: number | null };

export function lineTotalCents(line: PoLine): number | null {
  return line.unitCents === null ? null : line.unitCents * line.qtyOrdered;
}

/**
 * What the order comes to, and how much of it is priced. Unpriced lines are
 * reported rather than treated as free - the same honesty the parts-spend
 * report uses, because a total that silently omits lines is worse than none.
 */
export function poTotals(lines: PoLine[]): {
  cents: number; priced: number; unpriced: number; ordered: number; received: number; outstanding: number;
} {
  let cents = 0, priced = 0, unpriced = 0, ordered = 0, received = 0;
  for (const l of lines) {
    const t = lineTotalCents(l);
    if (t === null) unpriced++; else { cents += t; priced++; }
    ordered += l.qtyOrdered;
    received += Math.min(l.qtyReceived, l.qtyOrdered);
  }
  return { cents, priced, unpriced, ordered, received, outstanding: Math.max(0, ordered - received) };
}

/** Still owed on one line, never negative even if the vendor over-shipped. */
export const lineOutstanding = (l: PoLine) => Math.max(0, l.qtyOrdered - l.qtyReceived);

/**
 * The status a PO should be in given its lines: fully settled once nothing is
 * outstanding, part-received once anything has landed. Derived rather than
 * stored-and-hoped, so receiving can't leave a PO stuck in the wrong state.
 */
export function statusAfterReceipt(lines: PoLine[]): "sent" | "partial" | "received" {
  const anyReceived = lines.some((l) => l.qtyReceived > 0);
  const allSettled = lines.every((l) => lineOutstanding(l) === 0);
  if (allSettled) return "received";
  return anyReceived ? "partial" : "sent";
}

export type SuggestedLine = {
  partNumber: string; name: string; qty: number;
  vendor: string; unitCents: number | null; isOem: boolean;
};

/**
 * Turn a room's short lines into draft orders, one per vendor, priced from the
 * price book's best offer (cheapest, OEM breaking ties). A part nobody prices
 * still gets suggested under a blank vendor - "we don't know what this costs"
 * is a thing to go find out, not a reason to let the shelf run empty.
 */
export function suggestOrders<T extends StockLine & { partNumber: string; name: string }>(
  lines: T[],
  book: PriceEntry[],
): { vendor: string; lines: SuggestedLine[] }[] {
  const byVendor = new Map<string, SuggestedLine[]>();
  for (const line of lines) {
    if (!needsReorder(line)) continue;
    const offers = rankPrices(book.filter((p) => normalizePn(p.partNumber) === normalizePn(line.partNumber)));
    const best = offers[0];
    const vendor = best?.vendor ?? "";
    const entry: SuggestedLine = {
      partNumber: line.partNumber, name: line.name, qty: shortBy(line),
      vendor, unitCents: best?.priceCents ?? null, isOem: best?.isOem ?? false,
    };
    const list = byVendor.get(vendor);
    if (list) list.push(entry); else byVendor.set(vendor, [entry]);
  }
  // Named vendors first (they're actionable), unpriced last.
  return [...byVendor.entries()]
    .map(([vendor, lines]) => ({ vendor, lines }))
    .sort((a, b) => (a.vendor === "" ? 1 : b.vendor === "" ? -1 : a.vendor.localeCompare(b.vendor)));
}

/**
 * Next PO number. Sequential on the highest number already used rather than a
 * count, so a cancelled or deleted order never lets a number be handed out
 * twice - the vendor's copy of PO-1042 has to stay unambiguous.
 */
export function nextPoNumber(existing: string[], prefix = "PO-"): string {
  let top = 1000;
  for (const n of existing) {
    const m = n.match(/(\d+)\s*$/);
    if (m) top = Math.max(top, parseInt(m[1], 10));
  }
  return `${prefix}${top + 1}`;
}
