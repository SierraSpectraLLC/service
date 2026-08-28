// Selling an enquiry you are never going to drive to.
//
// Somebody writes to you about four triple quads on the east coast. It is real
// work and it is not your work, and today the choice is to turn it down or to
// forward an email and hope. A lead is that enquiry, put in front of a few
// shops who WOULD drive to it, for a finder's fee.
//
// Not a client share. A share hands over somebody you already service - there
// are records, a fleet, a history, and a client organization behind it. A lead
// has none of that, and must not be given one: putting a prospect into the
// client list in order to sell them on would foul the one table every tenancy
// rule in this application reads.
//
// TWO RULES, and both are about the lab at the other end as much as the money.
//
// BLIND UNTIL CLAIMED. What is published is the WORK - what equipment, roughly
// where, what they asked for. The name, the address and the person to call are
// held back, because a finder's fee is only worth anything while the finder is
// the only route to them. This is the same rule lib/clientShare redactPayload
// applies to a client, arrived at from the other direction.
//
// FIRST TO CLAIM WINS. An enquiry offered to four shops that all take it is
// four shops telephoning one lab in a week, which is worse for the lab than
// never having been referred. So it is a race with one winner, the losers are
// told plainly that it is gone, and nobody is left believing they have it.
//
// Pure. Callers hand in the rows.

import { termsLine, termsProblems, type FeeTerms } from "@/lib/referral";

/** One line of what they say they have. Nobody has verified any of it. */
export type LeadSystem = { category: string; model: string; count: number };

export const LEAD_STATES = ["open", "claimed", "withdrawn"] as const;
export type LeadState = (typeof LEAD_STATES)[number];

export const LEAD_LABEL: Record<LeadState, string> = {
  open: "Open",
  claimed: "Claimed",
  withdrawn: "Withdrawn",
};

/** Everything about a lead that is published from the start. */
export type LeadPublic = {
  region: string;
  blurb: string;
  systems: LeadSystem[];
  terms: FeeTerms;
};

/** And what only the finder, and the shop that claims it, ever see. */
export type LeadPrivate = {
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  orgName: string;
  address: string;
};

export const MAX_LEAD_SYSTEMS = 20;

/** Tolerant parse of the equipment list. Bad JSON is no list, never a crash. */
export function parseSystems(raw: string): LeadSystem[] {
  if (!raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.slice(0, MAX_LEAD_SYSTEMS).map((x) => ({
      category: String(x?.category ?? "").trim().slice(0, 60),
      model: String(x?.model ?? "").trim().slice(0, 60),
      count: Math.max(1, Math.min(999, Math.round(Number(x?.count) || 1))),
    })).filter((x) => x.category || x.model);
  } catch {
    return [];
  }
}

export const serializeSystems = (list: LeadSystem[]): string =>
  (list.length ? JSON.stringify(list) : "");

/** "4 × API 5000, 1 × 1260 LC". What a shop decides on. */
export function equipmentLine(list: LeadSystem[]): string {
  if (!list.length) return "Equipment not listed";
  return list
    .map((s) => `${s.count > 1 ? `${s.count} × ` : ""}${[s.model, s.category].filter(Boolean)[0] ?? "system"}`)
    .join(", ");
}

/** How many machines are in it, which is the number people sort on. */
export const systemCount = (list: LeadSystem[]): number =>
  list.reduce((n, s) => n + Math.max(1, s.count), 0);

/**
 * The headline: what it is and where, and never who.
 *
 * Region is free text the finder types rather than a state parsed out of an
 * address, because the address is exactly what must not be published and
 * "Boston metro" is more use to a shop than "MA" anyway.
 */
export function leadSummary(p: Pick<LeadPublic, "region" | "systems">): string {
  const n = systemCount(p.systems);
  const kit = n > 0 ? `${n} system${n === 1 ? "" : "s"}` : "Equipment not listed";
  return p.region.trim() ? `${kit} · ${p.region.trim()}` : kit;
}

/** Everything wrong with a lead somebody is trying to offer. */
export function leadProblems(input: {
  region: string; systems: LeadSystem[]; terms: FeeTerms;
  contactEmail: string; contactPhone: string; orgName: string;
}): string[] {
  const out: string[] = [];
  if (!input.region.trim()) out.push("Say roughly where it is, or nobody can tell if it is theirs");
  if (input.systems.length === 0) out.push("Say what equipment they have");
  /*
   * A lead with no way to reach anybody is not a lead, it is a rumour - and
   * the shop that pays for it would have bought nothing. Checked here rather
   * than left to the buyer, who cannot see these fields until they have paid.
   */
  if (!input.contactEmail.trim() && !input.contactPhone.trim()) {
    out.push("Give an email or a phone number - it is what they are buying");
  }
  if (!input.orgName.trim()) out.push("Give the company's name - it is held back until somebody claims it");
  // A lead offered for nothing is a forwarded email, which needs no software.
  if (input.terms.kind === "none") out.push("Say what your finder's fee is");
  return [...out, ...termsProblems(input.terms)];
}

/** May this be taken? Open, and not by the shop that posted it. */
export const mayClaim = (lead: { status: string; tenantOrgId: number | null }, byOrgId: number): boolean =>
  lead.status === "open" && lead.tenantOrgId !== byOrgId;

/** May the finder pull it? Only while nobody has taken it. */
export const mayWithdrawLead = (status: string): boolean => status === "open";

/** The sentence a shop reads before deciding. */
export function leadLine(p: LeadPublic, fmt: (c: number) => string): string {
  return `${leadSummary(p)} · ${equipmentLine(p.systems)} · ${termsLine(p.terms, fmt)}`;
}

/**
 * What somebody who has NOT claimed it may see.
 *
 * The private half is not merely hidden by a screen - it is not in the object
 * that reaches one. Same discipline as the fleet brief: a renderer cannot leak
 * a field it was never handed.
 */
export const publicOnly = <T extends LeadPublic>(lead: T & Partial<LeadPrivate>): LeadPublic => ({
  region: lead.region, blurb: lead.blurb, systems: lead.systems, terms: lead.terms,
});
