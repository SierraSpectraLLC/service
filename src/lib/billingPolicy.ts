// How a client is billed when the invoice goes late.
//
// One shape, two homes: the workspace defaults live in app_settings and each
// client may override any field on orgs.billing_policy - the same
// defaults-then-per-org layering the digest schedule uses, so there is exactly
// one place to change "what we do by default" and one place per client to say
// "except them".
//
// Parsed tolerantly, like lib/procedures does with its JSON: a hand-edited or
// half-migrated row degrades to the default for that field rather than
// throwing in the middle of rendering somebody's invoice. Nothing here decides
// anything - lib/dunning and lib/credit read these numbers.
//
// Pure: one import, for rendering money, and no database.

import { formatCents } from "@/lib/money";

export const FEE_TYPES = ["none", "flat", "interest"] as const;
export type FeeType = (typeof FEE_TYPES)[number];

/** Who gets the letter at each rung past the first. */
export type EscalationContact = { name: string; role: string; email?: string };

export type BillingPolicy = {
  /** Days after the due date before a fee may be posted. */
  graceDays: number;
  feeType: FeeType;
  /** Simple interest per month, in basis points. 150 = 1.5%/month. */
  rateBpsMonthly: number;
  /** Flat charge per late period, when feeType is "flat". */
  flatCents: number;
  /** Which part of the balance a fee is computed on. */
  appliesTo: "parts" | "all";
  /** New work goes on hold when the oldest open invoice passes this age. */
  holdDays: number;
  /** ...or when the open balance passes this. Zero means no amount trigger. */
  holdAmountCents: number;
  /** Off makes every rung of the ladder a task somebody has to press. */
  dunningAuto: boolean;
  /** Rung 2 and up address a new person, never the one already ignoring you. */
  escalation: EscalationContact[];
  /** Draw the parts-only sales tax line, at the site's rate. */
  taxParts: boolean;
  /**
   * What a part sells for over what it landed at, in basis points. 3000 is the
   * usual 30%. Lives with the policy rather than in a settings column because
   * a client on a retainer is often the client who negotiated the markup down,
   * and that is a per-client fact.
   */
  partsMarkupBps: number;
};

/**
 * What a workspace does before anybody configures anything.
 *
 * 1.5% a month after ten days is the ordinary commercial ceiling, and the hold
 * numbers are deliberately loose: a policy that holds work at thirty days
 * catches a client whose AP simply runs slow, and the first thing an operator
 * learns from that is to distrust the feature.
 */
export const DEFAULT_POLICY: BillingPolicy = {
  graceDays: 10,
  feeType: "interest",
  rateBpsMonthly: 150,
  flatCents: 0,
  appliesTo: "all",
  holdDays: 45,
  holdAmountCents: 150000,
  dunningAuto: true,
  escalation: [],
  taxParts: true,
  partsMarkupBps: 3000,
};

const int = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
};

const contacts = (v: unknown): EscalationContact[] => {
  if (!Array.isArray(v)) return [];
  return v
    .map((c: Record<string, unknown>) => ({
      name: String(c?.name ?? "").trim(),
      role: String(c?.role ?? "").trim(),
      ...(String(c?.email ?? "").trim() ? { email: String(c.email).trim() } : {}),
    }))
    .filter((c) => c.name);
};

/**
 * The policy in force for one client: the workspace defaults, with whatever
 * that client's own row overrides. Either argument may be null, absent, or
 * nonsense - the answer is always a complete, usable policy.
 */
export function resolvePolicy(defaults: unknown, orgOverride: unknown): BillingPolicy {
  const base = merge(DEFAULT_POLICY, defaults);
  return merge(base, orgOverride);
}

function merge(base: BillingPolicy, raw: unknown): BillingPolicy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return base;
  const v = raw as Record<string, unknown>;
  return {
    graceDays: int(v.graceDays, base.graceDays),
    feeType: (FEE_TYPES as readonly string[]).includes(String(v.feeType)) ? (v.feeType as FeeType) : base.feeType,
    rateBpsMonthly: int(v.rateBpsMonthly, base.rateBpsMonthly),
    flatCents: int(v.flatCents, base.flatCents),
    appliesTo: v.appliesTo === "parts" || v.appliesTo === "all" ? v.appliesTo : base.appliesTo,
    holdDays: int(v.holdDays, base.holdDays),
    holdAmountCents: int(v.holdAmountCents, base.holdAmountCents),
    dunningAuto: typeof v.dunningAuto === "boolean" ? v.dunningAuto : base.dunningAuto,
    escalation: v.escalation === undefined ? base.escalation : contacts(v.escalation),
    taxParts: typeof v.taxParts === "boolean" ? v.taxParts : base.taxParts,
    partsMarkupBps: int(v.partsMarkupBps, base.partsMarkupBps),
  };
}

/**
 * The sentence that prints on the quote and the invoice.
 *
 * It prints because a late fee is only collectable if the terms rode the
 * paper: a fee assessed under a policy the client never saw is a number in an
 * argument, not a term of the deal.
 */
export function feeClause(p: BillingPolicy): string {
  if (p.feeType === "none") return "";
  const what = p.appliesTo === "parts" ? "the parts balance" : "the unpaid balance";
  const charge = p.feeType === "flat"
    ? `a late charge of ${formatCents(p.flatCents)} applies`
    : `a late charge of ${(p.rateBpsMonthly / 100).toFixed(2)}% per month applies`;
  const grace = p.graceDays > 0 ? ` after ${p.graceDays} days` : "";
  return `Payable per the terms above; ${charge} on ${what}${grace}.`;
}
