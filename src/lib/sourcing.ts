// Which vendor gets this order - decided at order time, on facts, not memory.
//
// The price book knows three things per (part, vendor): what it costs, how
// many business days the vendor takes to ship, and how it can travel (drop-
// ship to the client's site, or via our dock; overnight on request, or not).
// This module turns those into the two answers a person placing an order
// actually wants - "cheapest" and "fastest" - plus the honest fine print:
// an unknown lead time never beats a known one, and a vendor who cannot
// drop-ship pays the cross-dock toll before their speed is compared.
//
// Pure. Callers hand in the rows.

import type { PriceEntry } from "@/lib/priceBook";
import { normalizePn, rankPrices } from "@/lib/priceBook";

export type Offer = PriceEntry & {
  leadDays: number | null;
  dropShips: boolean;
  expediteOk: boolean;
};

export type SourcingMode = "cheapest" | "fastest";

/** A price nobody has confirmed in this long is a rumor, not a price. */
export const STALE_PRICE_DAYS = 90;

export function priceAgeDays(updatedAt: Date | string, today: string): number {
  const then = typeof updatedAt === "string" ? Date.parse(updatedAt) : updatedAt.getTime();
  const now = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.floor((now - then) / 86400000));
}

export const isStalePrice = (updatedAt: Date | string, today: string): boolean =>
  priceAgeDays(updatedAt, today) > STALE_PRICE_DAYS;

/**
 * Door-to-door days for one offer: the vendor's lead, plus the cross-dock
 * days when the box has to land on our dock and go out again. Null means the
 * lead time was never recorded - the caller sorts that as slower than any
 * number, because "we don't know" losing to "eight days" is the truthful
 * outcome.
 */
export function effectiveDays(
  offer: Pick<Offer, "leadDays" | "dropShips">, crossDockDays: number,
): number | null {
  if (offer.leadDays === null) return null;
  return offer.leadDays + (offer.dropShips ? 0 : Math.max(0, crossDockDays));
}

/**
 * The urgent lanes. Ridgeline paperwork is non-negotiable, so there are only
 * two ways a rush can travel: a vendor VERIFIED to blind-ship under our name
 * overnights straight to the door (1 day), and everyone else overnights to
 * our dock, where the box is turned around the same day under our packing
 * slip and overnighted out (2 days). A vendor who cannot expedite at all has
 * no urgent lane, whatever their standard lead time says.
 */
export const URGENT_DIRECT_DAYS = 1;
export const URGENT_VIA_SHOP_DAYS = 2;

export const canExpedite = (o: Pick<Offer, "expediteOk">): boolean => o.expediteOk;

/** Door-to-door days for a rush, by whichever lane this vendor has. */
export const urgentDays = (o: Pick<Offer, "expediteOk" | "dropShips">): number | null =>
  !o.expediteOk ? null : o.dropShips ? URGENT_DIRECT_DAYS : URGENT_VIA_SHOP_DAYS;

/**
 * Every offer for one part, ranked for the chosen mode.
 *
 * cheapest: price, OEM breaking ties (rankPrices' order), speed last.
 * fastest: door-to-door days first (unknown last), then price. Urgent
 * narrows to offers with an urgent lane at all (see urgentDays) and ranks
 * blind-ship-to-the-door ahead of overnight-via-the-shop; if nothing can be
 * rushed, the list comes back empty and the caller says so instead of
 * quietly booking ground freight on an emergency.
 */
export function rankOffers<T extends Offer>(
  offers: T[],
  opts: { mode: SourcingMode; urgent?: boolean; crossDockDays: number },
): T[] {
  const pool = opts.urgent ? offers.filter(canExpedite) : offers;
  if (opts.mode === "cheapest" && !opts.urgent) return rankPrices(pool);
  const days = (o: T) => (opts.urgent ? urgentDays(o) : effectiveDays(o, opts.crossDockDays));
  return [...pool].sort((a, b) => {
    if (opts.mode === "fastest" || opts.urgent) {
      const da = days(a), db = days(b);
      if (da !== db) return (da ?? Infinity) - (db ?? Infinity);
      return a.priceCents - b.priceCents || Number(b.isOem) - Number(a.isOem)
        || a.vendor.localeCompare(b.vendor);
    }
    return a.priceCents - b.priceCents || Number(b.isOem) - Number(a.isOem)
      || a.vendor.localeCompare(b.vendor);
  });
}

/** The book's offers for one part number, ranked for the mode. */
export function offersFor<T extends Offer>(
  book: T[], pn: string,
  opts: { mode: SourcingMode; urgent?: boolean; crossDockDays: number },
): T[] {
  const key = normalizePn(pn);
  if (!key) return [];
  return rankOffers(book.filter((r) => normalizePn(r.partNumber) === key), opts);
}

/** "$118 · 3d door to door · blind-ships · overnight ok" - a vendor's fine print. */
export function offerSummary(o: Offer, crossDockDays: number): string {
  const d = effectiveDays(o, crossDockDays);
  return [
    d === null ? "lead time unknown" : `${d}d door to door`,
    o.dropShips ? "blind-ships" : "via the shop",
    o.expediteOk ? "overnight ok" : "",
  ].filter(Boolean).join(" · ");
}

/**
 * The instruction a drop-ship vendor gets, word for word. The client's parts
 * relationship is with the brand, so the vendor's paperwork stays home: no
 * vendor invoice in the box, no vendor pricing, packing slip under our name.
 */
export function blindShipNote(brand: string, siteLabel: string): string {
  return `Blind ship to ${siteLabel}. Packing slip to read "${brand}" only - `
    + `no vendor invoice, pricing or branding in the box.`;
}
