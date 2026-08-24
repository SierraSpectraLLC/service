// The parts store, as the CLIENT sees it - which is the whole point of this
// module existing. A store item is built here, on the server, from staff data
// (the catalog, the price book, the markup) and carries only what a client may
// read: the part, its resale price, and whether it fits their equipment. No
// vendor name, no cost, no margin survives the trip - the type has no field to
// put them in, which beats remembering not to.
//
// Prices are the same resale the invoice would charge: best cost times the
// org's parts markup, the one formula lib/invoiceData bills with. A store that
// quotes one number and invoices another is how a client's first order becomes
// their last.
//
// Pure. Callers hand in the rows.

import { sellPrice } from "@/lib/billing";
import { matchesQuery } from "@/lib/search";

export type StorePart = {
  id: number;
  partNumber: string;
  name: string;
  manufacturer: string;
  kind: string; // part | consumable | kit
  photoUrl: string;
  /** Resale in cents, markup applied. Null = priced on request. */
  priceCents: number | null;
  /**
   * The genuine article vs the equivalent - the ONE sourcing fact a client
   * gets to choose on, because it is a spec, not a supplier. Null = that
   * class has no offer. When both exist and the part must be sourced, the
   * store shows both and the choice rides the order line.
   */
  oemCents: number | null;
  altCents: number | null;
  /** Matches a model or module type on this client's own systems. */
  fitsYours: boolean;
  /** What it suits, for the card's quiet line. */
  fitsLabel: string;
  /** On our shelf right now - orders ship immediately. A yes/no on purpose:
      the count is shop information, the availability is the client's. */
  inStock: boolean;
  /** Sourcing estimate in days when not on the shelf. Null = special order. */
  etaDays: number | null;
};

const lc = (s: string) => s.trim().toLowerCase();

/**
 * Build the shelf. `bestCostByPn` is the price book's best offer per part
 * number (cost side, staff data) - it enters here and leaves only as resale.
 * A part with no offer is still on the shelf: "priced on request" sells more
 * honestly than hiding half the catalog.
 */
export function buildStore(
  catalog: {
    id: number; partNumber: string; name: string; manufacturer: string;
    kind: string; assetTypes: string[]; models: string[]; archived: boolean;
  }[],
  opts: {
    /** Best COST per class per PN - staff data in, resale out, as ever. */
    oemCostByPn: Map<string, number>;
    altCostByPn: Map<string, number>;
    markupBps: number;
    yours: { models: string[]; types: string[] };
    photoByCatalogId?: Map<number, string>;
    /** On-hand across the house's own rooms, keyed by lowercased PN. */
    stockByPn?: Map<string, number>;
    /** Fastest door-to-door days per PN, for the not-on-the-shelf estimate. */
    etaByPn?: Map<string, number>;
    /** lowercased model -> the client's own unit label ("LZ-001 · 7890B"). */
    unitByModel?: Map<string, string>;
  },
): StorePart[] {
  const myModels = new Set(opts.yours.models.map(lc).filter(Boolean));
  const myTypes = new Set(opts.yours.types.map(lc).filter(Boolean));
  const photos = opts.photoByCatalogId ?? new Map<number, string>();
  const units = opts.unitByModel ?? new Map<string, string>();
  const stock = opts.stockByPn ?? new Map<string, number>();
  const eta = opts.etaByPn ?? new Map<string, number>();
  return catalog
    .filter((c) => !c.archived && c.partNumber.trim())
    .map((c) => {
      const oemCost = opts.oemCostByPn.get(lc(c.partNumber));
      const altCost = opts.altCostByPn.get(lc(c.partNumber));
      const oemCents = oemCost !== undefined && oemCost > 0 ? sellPrice(oemCost, opts.markupBps) : null;
      const altCents = altCost !== undefined && altCost > 0 ? sellPrice(altCost, opts.markupBps) : null;
      const fits = c.models.some((m) => myModels.has(lc(m)))
        || c.assetTypes.some((t) => myTypes.has(lc(t)));
      const inStock = (stock.get(lc(c.partNumber)) ?? 0) > 0;
      return {
        id: c.id,
        partNumber: c.partNumber,
        name: c.name || c.partNumber,
        manufacturer: c.manufacturer,
        kind: c.kind,
        photoUrl: photos.get(c.id) ?? "",
        // The "from" price: the better of whatever classes exist.
        priceCents: oemCents !== null && altCents !== null ? Math.min(oemCents, altCents)
          : oemCents ?? altCents,
        oemCents, altCents,
        fitsYours: fits,
        // Fitting THEIR unit is said by name; a generic fit stays generic.
        fitsLabel: (() => {
          const mine = c.models.map((m) => units.get(lc(m))).find(Boolean);
          if (mine) return `fits your ${mine}`;
          if (c.models.length) {
            return `Fits ${c.models.slice(0, 3).join(", ")}${c.models.length > 3 ? ` +${c.models.length - 3}` : ""}`;
          }
          return c.assetTypes.length ? `For ${c.assetTypes.slice(0, 3).join(", ")}` : "";
        })(),
        inStock,
        etaDays: inStock ? null : eta.get(lc(c.partNumber)) ?? null,
      };
    })
    .sort((a, b) =>
      Number(b.fitsYours) - Number(a.fitsYours)
      || Number(b.inStock) - Number(a.inStock)
      || a.name.localeCompare(b.name));
}

/**
 * The three availability states, one vocabulary everywhere. Unpriced forces
 * special-order however the shelf looks: a part nobody has priced cannot be
 * invoiced, so it quotes first, and the row must say so.
 */
export type Availability = "now" | "sourced" | "special";

export const availabilityOf = (i: Pick<StorePart, "inStock" | "etaDays" | "priceCents">): Availability =>
  i.priceCents === null ? "special" : i.inStock ? "now" : i.etaDays !== null ? "sourced" : "special";

export const availabilityLabel = (i: Pick<StorePart, "inStock" | "etaDays" | "priceCents">): string => {
  const a = availabilityOf(i);
  return a === "now" ? "In stock · ships today"
    : a === "sourced" ? `Sourced for you · ~${i.etaDays} d`
    : "Special order · quoted first";
};

/** The quieter second line under the availability, per state. */
export const availabilityHint = (i: Pick<StorePart, "inStock" | "etaDays" | "priceCents">): string => {
  const a = availabilityOf(i);
  return a === "sourced" ? "invoiced when it ships"
    : a === "special" ? "price confirmed before anything moves" : "";
};

/**
 * The checkout split, three ways. Priced lines ride the ORDER whatever the
 * shelf says - on it now (ships today) or sourced first (invoiced when it
 * ships); only an UNPRICED line becomes a quote, because a price nobody has
 * confirmed is the one thing a client must approve before anything moves.
 * A chosen class is a sourcing request, so it never ships from the shelf.
 */
export function splitCart(cart: CartLine[], items: StorePart[]): {
  now: CartLine[]; sourced: CartLine[]; quoted: CartLine[];
} {
  const now: CartLine[] = [], sourced: CartLine[] = [], quoted: CartLine[] = [];
  for (const line of cart) {
    const item = items.find((i) => lc(i.partNumber) === lc(line.partNumber));
    if (!item || line.qty <= 0) continue;
    if (linePrice(item, line.source) === null) quoted.push(line);
    else if (item.inStock && line.source === undefined) now.push(line);
    else sourced.push(line);
  }
  return { now, sourced, quoted };
}

/** Per-bucket money, for the cart's Ships-now / Sourced / Total rows. */
export function bucketTotals(cart: CartLine[], items: StorePart[]): {
  nowCents: number; sourcedCents: number; quotedLines: number; count: number;
} {
  const { now, sourced, quoted } = splitCart(cart, items);
  const sum = (lines: CartLine[]) => lines.reduce((n, l) => {
    const item = items.find((i) => lc(i.partNumber) === lc(l.partNumber));
    return n + (item ? (linePrice(item, l.source) ?? 0) * l.qty : 0);
  }, 0);
  return {
    nowCents: sum(now), sourcedCents: sum(sourced), quotedLines: quoted.length,
    count: [...now, ...sourced, ...quoted].reduce((n, l) => n + l.qty, 0),
  };
}

export type StoreFacet = "all" | "yours" | "part" | "consumable" | "kit";

export function filterStore(items: StorePart[], facet: StoreFacet, q: string): StorePart[] {
  return items.filter((i) =>
    (facet === "all"
      || (facet === "yours" ? i.fitsYours : i.kind === facet))
    && (!q.trim() || matchesQuery(q, [i.partNumber, i.name, i.manufacturer, i.fitsLabel])));
}

export type CartLine = {
  partNumber: string; qty: number;
  /** Genuine or equivalent, when the client chose. Absent = no choice offered. */
  source?: "oem" | "alt";
};

/** What one cart line costs, honoring the class the client picked. */
export const linePrice = (item: StorePart, source?: "oem" | "alt"): number | null =>
  source === "oem" ? item.oemCents : source === "alt" ? item.altCents : item.priceCents;

/** Offer the genuine/equivalent choice only where it is real: both classes
    priced, and the part not already sitting on the shelf as whatever it is. */
export const hasChoice = (i: StorePart): boolean =>
  !i.inStock && i.oemCents !== null && i.altCents !== null;

/** The quiet tag beside a single price, naming which class it is. */
export const sourceTag = (i: StorePart, source?: "oem" | "alt"): string =>
  source === "oem" ? `Genuine ${i.manufacturer}`.trim()
  : source === "alt" ? "OEM-equivalent"
  : i.oemCents !== null && i.altCents === null ? `Genuine ${i.manufacturer}`.trim()
  : i.altCents !== null && i.oemCents === null ? "OEM-equivalent"
  : "";

/** The cart's arithmetic: priced subtotal plus how many lines await a price. */
export function cartTotals(cart: CartLine[], items: StorePart[]): {
  subtotalCents: number; unpriced: number; count: number;
} {
  let subtotal = 0, unpriced = 0, count = 0;
  for (const line of cart) {
    const item = items.find((i) => lc(i.partNumber) === lc(line.partNumber));
    if (!item || line.qty <= 0) continue;
    count += line.qty;
    const cents = linePrice(item, line.source);
    if (cents === null) unpriced++;
    else subtotal += cents * line.qty;
  }
  return { subtotalCents: subtotal, unpriced, count };
}

/** What a client's order reads as, per invoice status, in store language. */
export const ORDER_LABEL: Record<string, string> = {
  draft: "Being confirmed",
  sent: "Awaiting payment",
  paid: "Paid",
  void: "Cancelled",
};
