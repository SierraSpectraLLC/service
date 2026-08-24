// The client's Orders surface: their invoices and quotes, read as orders.
//
// Same rows the billing rails own - nothing here is a new money object. What
// this module adds is the client's reading of them: an order's status in
// store language, whether it is waiting on THEM (the orange-edge rule the
// rest of the portal uses), and the step rail derived from the fields the
// row already carries. Derived, never stored: a step rail that could
// disagree with the invoice would be worse than none.
//
// Pure. Callers hand in the rows.

import type { Tone } from "@/lib/tones";

export type OrderStatus = { label: string; tone: Tone; needsYou: boolean };

/** An invoice, read as an order of parts. */
export function invoiceOrderStatus(
  row: { status: string }, view: { balanceCents: number; daysLate: number },
): OrderStatus {
  if (row.status === "void") return { label: "Cancelled", tone: "faint", needsYou: false };
  if (row.status === "draft") return { label: "Being confirmed", tone: "info", needsYou: false };
  if (view.balanceCents <= 0) return { label: "Paid", tone: "good", needsYou: false };
  return {
    label: view.daysLate > 0 ? "Invoice overdue" : "Open invoice",
    tone: view.daysLate > 0 ? "bad" : "info",
    needsYou: true,
  };
}

/** A quote, read as a special order waiting to become one. */
export function quoteOrderStatus(row: { status: string }, standing: string): OrderStatus {
  if (row.status === "draft") return { label: "Quote being prepared", tone: "info", needsYou: false };
  if (standing === "awaiting") return { label: "Awaiting your approval", tone: "warn", needsYou: true };
  if (standing === "approved") return { label: "Approved", tone: "good", needsYou: false };
  if (standing === "declined") return { label: "Declined", tone: "faint", needsYou: false };
  return { label: "Expired", tone: "faint", needsYou: false };
}

export type Step = { label: string; sub: string; state: "done" | "on" | "todo" };

/**
 * The invoice's life as four steps. "on" is where it stands; everything the
 * row's own dates prove has happened is "done".
 */
export function invoiceSteps(
  row: { status: string; issuedOn: string },
  view: { balanceCents: number; paidCents: number },
  placedOn: string,
): Step[] {
  const paid = row.status !== "draft" && row.status !== "void" && view.balanceCents <= 0;
  const sent = row.status === "sent" || paid;
  return [
    { label: "Placed", sub: placedOn, state: "done" },
    { label: "Confirmed", sub: "", state: sent ? "done" : "on" },
    { label: "Invoiced", sub: row.issuedOn, state: paid ? "done" : sent ? "on" : "todo" },
    { label: "Paid", sub: "", state: paid ? "done" : "todo" },
  ];
}

/** The quote's life as four steps, ending where it becomes an order. */
export function quoteSteps(
  row: { status: string; sentOn: string | null; answeredOn: string | null },
  standing: string,
  placedOn: string,
): Step[] {
  const sent = row.status !== "draft";
  const approved = standing === "approved";
  return [
    { label: "Placed", sub: placedOn, state: "done" },
    { label: "Priced & sent", sub: row.sentOn ?? "", state: sent ? "done" : "on" },
    { label: "Approved", sub: row.answeredOn ?? "", state: approved ? "done" : sent ? "on" : "todo" },
    { label: "Ordered", sub: "", state: approved ? "on" : "todo" },
  ];
}

export type OrderFacet = "open" | "needsyou" | "settled" | "all";

export function facetMatches(f: OrderFacet, s: OrderStatus): boolean {
  if (f === "all") return true;
  if (f === "needsyou") return s.needsYou;
  const settled = ["Paid", "Cancelled", "Declined", "Expired"].includes(s.label);
  return f === "settled" ? settled : !settled;
}
