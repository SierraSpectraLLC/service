// The contract, and what is left of it.
//
// A service agreement says three things a shop has to be able to answer on the
// phone: is this still in force, how many visits are left, and how much of their
// parts allowance have they spent. The first is a date comparison. The second
// and third are the interesting ones, because the honest way to answer them is
// to NOT store them.
//
// Nothing here holds a balance. Drawdown is summed from the work - parts.
// cost_cents for parts installed on their systems inside the term, closed work
// orders for visits - so the answer is always what the ledger actually says. A
// stored balance is a second copy of a number the ledger already has, free to
// drift from it, and the drift is always discovered in front of the customer.
// The cost of that choice is a slightly heavier query once a page; the benefit
// is never having to explain why two screens disagree about the same money.
//
// Pure. Callers hand in the sums; the rules and the arithmetic live here.

import { addDays } from "@/lib/pm";

export const AGREEMENT_KINDS = ["contract", "po", "quote", "invoice"] as const;
export type AgreementKind = (typeof AGREEMENT_KINDS)[number];

export const KIND_LABEL: Record<string, string> = {
  contract: "Service contract",
  po: "Purchase order",
  quote: "Quote",
  invoice: "Invoice",
};

export const AGREEMENT_STATES = ["draft", "active", "expired", "cancelled"] as const;

export type AgreementLike = {
  kind: string;
  status: string;
  startsOn: string;   // YYYY-MM-DD, blank = no start recorded
  endsOn: string;     // blank = open-ended
  renewNoticeDays: number;
  visitsIncluded: number;
  partsAllowanceCents: number;
  laborIncludedMinutes: number;
  /** Unlimited beats any cap: a full-service contract has no number to burn. */
  visitsUnlimited?: boolean;
  partsUnlimited?: boolean;
};

/** draft | cancelled | expired | expiring | active - what it is TODAY. */
export type Standing = "draft" | "cancelled" | "expired" | "expiring" | "active";

export const STANDING_LABEL: Record<Standing, string> = {
  draft: "Draft",
  cancelled: "Cancelled",
  expired: "Expired",
  expiring: "Up for renewal",
  active: "Active",
};

export const STANDING_COLOR: Record<Standing, { bg: string; fg: string }> = {
  draft: { bg: "#EEF1F5", fg: "#475569" },
  cancelled: { bg: "#F4F6F9", fg: "#94A3B8" },
  expired: { bg: "#FBE9E9", fg: "#A32D2D" },
  expiring: { bg: "#FAF0DC", fg: "#8A5410" },
  active: { bg: "#E8F3EC", fg: "#2E6B2E" },
};

/**
 * Where an agreement stands today.
 *
 * What somebody SET wins over what the calendar says in one direction only:
 * draft and cancelled are decisions and stay put, but an "active" agreement
 * whose end date has passed is expired whatever the column says. Nobody
 * remembers to go and flip a status field, and a contract that ran out in March
 * still showing "Active" in August is exactly the failure this is for.
 */
export function standing(a: Pick<AgreementLike, "status" | "endsOn" | "renewNoticeDays">, today: string): Standing {
  if (a.status === "draft") return "draft";
  if (a.status === "cancelled") return "cancelled";
  if (a.status === "expired") return "expired";
  if (!a.endsOn) return "active";               // open-ended
  if (a.endsOn < today) return "expired";
  const notice = Math.max(0, a.renewNoticeDays);
  if (notice > 0 && a.endsOn <= addDays(today, notice)) return "expiring";
  return "active";
}

/** Days until it ends. Null when it is open-ended; negative once it has passed. */
export function daysLeft(endsOn: string, today: string): number | null {
  if (!endsOn) return null;
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${endsOn}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Is this day inside the term - i.e. does work done on it draw down?
 *
 * A blank start means "since forever" and a blank end means "until further
 * notice", because that is what a contract with those fields left empty is. The
 * alternative - treating a blank as excluding everything - would silently report
 * zero spend against a live allowance, which reads as good news.
 */
export const inTerm = (a: Pick<AgreementLike, "startsOn" | "endsOn">, day: string): boolean =>
  (!a.startsOn || day >= a.startsOn) && (!a.endsOn || day <= a.endsOn);

export type Usage = {
  /** What draws down the allowance - PM parts already removed when covered. */
  partsCents: number;
  visits: number;
  laborMinutes: number;
  /** Parts fitted on an included PM. Reported always; drawn down only when the
      contract does NOT include its PM's parts. */
  pmPartsCents?: number;
};

export type Allowance = {
  /** Is this entitlement part of the agreement at all? */
  tracked: boolean;
  /** No cap to draw down - usage is information, never "over". */
  unlimited: boolean;
  included: number;
  used: number;
  remaining: number;
  /** 0-100, clamped, for a bar. 0 when untracked or unlimited. */
  pct: number;
  over: boolean;
};

/**
 * One entitlement, drawn down.
 *
 * Zero included means the entitlement is NOT PART of this agreement, not that
 * zero is allowed. An unlimited-visits contract and a no-visits contract are
 * both real things, and the one nobody filled in must not be reported as the
 * second - so an untracked allowance reports `tracked: false` and the UI leaves
 * it out rather than drawing an instantly-full bar.
 *
 * Unlimited is the third state: covered with no number to burn. Usage still
 * reports (it is real work), but there is no bar, no remaining, and no "over".
 */
export function allowance(included: number, used: number, unlimited = false): Allowance {
  const cap = Math.max(0, included);
  const spent = Math.max(0, used);
  if (unlimited) {
    return { tracked: true, unlimited: true, included: 0, used: spent, remaining: 0, pct: 0, over: false };
  }
  if (cap === 0) {
    return { tracked: false, unlimited: false, included: 0, used: spent, remaining: 0, pct: 0, over: false };
  }
  return {
    tracked: true,
    unlimited: false,
    included: cap,
    used: spent,
    remaining: cap - spent,          // negative when over, which is the point
    pct: Math.min(100, Math.round((spent / cap) * 100)),
    over: spent > cap,
  };
}

/** All three entitlements at once, in the order a person reads them. */
export function drawdown(a: AgreementLike, used: Usage) {
  return {
    parts: allowance(a.partsAllowanceCents, used.partsCents, a.partsUnlimited),
    visits: allowance(a.visitsIncluded, used.visits, a.visitsUnlimited),
    labor: allowance(a.laborIncludedMinutes, used.laborMinutes),
  };
}

/**
 * Agreements that need somebody to do something about them, worst first.
 *
 * Expired before expiring, then soonest first. Draft and cancelled never appear:
 * a draft nobody signed is not a renewal risk, and chasing a cancelled contract
 * is how a customer gets an email about a service they cancelled.
 */
export function needsAttention<T extends AgreementLike>(list: T[], today: string): T[] {
  const rank = (a: T) => (standing(a, today) === "expired" ? 0 : 1);
  return list
    .filter((a) => ["expired", "expiring"].includes(standing(a, today)))
    .sort((x, y) => rank(x) - rank(y) || x.endsOn.localeCompare(y.endsOn));
}

/**
 * The renewal sentence, for an email or a chip.
 *
 * Says the date as well as the count, because "expires in 14 days" is the sort
 * of thing somebody reads on a Friday and acts on the following Thursday.
 */
export function renewalLine(a: Pick<AgreementLike, "endsOn" | "renewNoticeDays" | "status">, today: string): string {
  const s = standing(a, today);
  if (s === "draft") return "Not in force yet.";
  if (s === "cancelled") return "Cancelled.";
  if (!a.endsOn) return "Open-ended - no renewal date.";
  const d = daysLeft(a.endsOn, today);
  if (d === null) return "";
  if (d < 0) return `Expired ${-d} day${d === -1 ? "" : "s"} ago, on ${a.endsOn}.`;
  if (d === 0) return `Expires today, ${a.endsOn}.`;
  return `Expires in ${d} day${d === 1 ? "" : "s"}, on ${a.endsOn}.`;
}

/**
 * Which closed work orders count as a "visit" against an agreement.
 *
 * A question answered over the phone is not a visit, and counting it as one is
 * how a client burns their fourth call of the year on nothing. Everything else
 * that reached a closed state counts - including one that was resolved without
 * anybody travelling, because the entitlement is the shop's attention rather
 * than its mileage.
 */
export const countsAsVisit = (wo: { severity: string; state: string }): boolean =>
  wo.state === "closed" && wo.severity.trim().toLowerCase() !== "question";
