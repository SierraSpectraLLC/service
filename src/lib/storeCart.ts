// The client's cart, as it survives a page change.
//
// It lives in this one module because the shelf and the part page both write
// it: a part added from its own page has to land in the same cart the shelf's
// rows fill, and two copies of "what the key is called" would drift the first
// time one of them changed. The cart is a per-browser convenience, never a
// record - nothing here is money, and the server re-reads every price and
// every part number when the order is actually placed.

import type { CartLine } from "@/lib/store";

export const CART_KEY = "ridgeline-store-cart";

/** Same identity rule as the order: a part number PLUS the class chosen. */
export const sameLine = (l: CartLine, partNumber: string, source?: "oem" | "alt") =>
  l.partNumber.toLowerCase() === partNumber.toLowerCase() && (l.source ?? "") === (source ?? "");

/** The cart survives navigation, not failure: storage that throws is empty. */
export function loadCart(): CartLine[] {
  try {
    const raw = localStorage.getItem(CART_KEY);
    const parsed = raw ? (JSON.parse(raw) as CartLine[]) : [];
    return Array.isArray(parsed) ? parsed.filter((l) => l && l.partNumber && l.qty > 0) : [];
  } catch { return []; }
}

export function saveCart(cart: CartLine[]): void {
  try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* per-browser nicety only */ }
}

/** Add n of a part (in its chosen class), merging with a line already there. */
export function addToCart(
  cart: CartLine[], partNumber: string, qty: number, source?: "oem" | "alt",
): CartLine[] {
  const line = cart.find((l) => sameLine(l, partNumber, source));
  const next = line
    ? cart.map((l) => (l === line ? { ...l, qty: Math.min(999, l.qty + qty) } : l))
    : [...cart, { partNumber, qty: Math.min(999, qty), ...(source ? { source } : {}) }];
  saveCart(next);
  return next;
}
