// Should we open new work for somebody who owes us money?
//
// Pure, like lib/agreements, and for the same reason: the answer has to be
// computable from rows at the moment somebody asks, on the work order page, in
// the dispatch list, and in the action that opens the job - three places that
// must not be able to disagree.
//
// The check is deliberately blunt: an oldest invoice past N days, or a balance
// past $X. Nothing clever, because the person reading it is about to drive two
// hours and needs to know before they load the van, not a risk score.
//
// A hold is never a refusal. The owner can override it with a written reason,
// and the reason is the point - "they are good for it, the PO is stuck in
// their AP system" is a decision somebody made and can be asked about later.

import { formatCents } from "@/lib/money";
import type { BillingPolicy } from "@/lib/billingPolicy";
import type { Tone } from "@/lib/tones";

export type HoldReasonKind = "age" | "amount" | "both";

export type CreditStanding = {
  /** New work opens on hold. */
  onHold: boolean;
  /** Why, in one sentence somebody can read on a phone. */
  line: string;
  kind: HoldReasonKind | null;
  /** The open balance the check was made on. */
  balanceCents: number;
  /** Days past due on the oldest open invoice. */
  oldestDaysLate: number;
  /** An owner's override, when one is in force. */
  override: { reason: string; grantedBy: string; untilOn: string } | null;
  tone: Tone;
};

export const CLEAR: CreditStanding = {
  onHold: false, line: "", kind: null, balanceCents: 0, oldestDaysLate: 0,
  override: null, tone: "good",
};

export type OverrideRow = {
  reason: string; grantedBy: string; untilOn: string;
  /** Lifted by hand. A lifted override is not in force whatever its date. */
  lifted: boolean;
};

/** The override in force today, if any. */
export function activeOverride(rows: OverrideRow[], today: string): OverrideRow | null {
  return rows.find((r) => !r.lifted && (!r.untilOn || r.untilOn >= today)) ?? null;
}

/**
 * Where this client stands.
 *
 * `openInvoices` is what lib/statement already computed - balance and days
 * late per invoice - so there is exactly one definition of "past due" in the
 * codebase and this is not a second one.
 */
export function creditStanding(input: {
  policy: BillingPolicy;
  openInvoices: { balanceCents: number; daysLate: number }[];
  overrides?: OverrideRow[];
  today: string;
}): CreditStanding {
  const balance = input.openInvoices.reduce((n, i) => n + i.balanceCents, 0);
  const oldest = input.openInvoices.reduce((n, i) => Math.max(n, i.daysLate), 0);
  const byAge = input.policy.holdDays > 0 && oldest >= input.policy.holdDays;
  const byAmount = input.policy.holdAmountCents > 0 && balance >= input.policy.holdAmountCents;
  const override = activeOverride(input.overrides ?? [], input.today);

  if (!byAge && !byAmount) {
    return { ...CLEAR, balanceCents: balance, oldestDaysLate: oldest, tone: oldest > 0 ? "warn" : "good" };
  }

  const kind: HoldReasonKind = byAge && byAmount ? "both" : byAge ? "age" : "amount";
  const n = input.openInvoices.length;
  const reasons = [
    byAge ? `the oldest open invoice is ${oldest} days past due (policy holds at ${input.policy.holdDays})` : "",
    byAmount ? `${formatCents(balance)} is open across ${n} invoice${n === 1 ? "" : "s"} (policy holds at ${formatCents(input.policy.holdAmountCents)})` : "",
  ].filter(Boolean);

  return {
    onHold: override === null,
    line: override
      ? `Would be on hold - ${reasons.join(", and ")} - but ${override.grantedBy || "the owner"} overrode it: ${override.reason}`
      : `On credit hold: ${reasons.join(", and ")}.`,
    kind,
    balanceCents: balance,
    oldestDaysLate: oldest,
    override: override ? { reason: override.reason, grantedBy: override.grantedBy, untilOn: override.untilOn } : null,
    tone: override ? "warn" : "bad",
  };
}

/**
 * What clearing the hold would take: enough to drop under BOTH triggers.
 *
 * The age trigger cannot be paid down partially - an invoice is either settled
 * or it is still forty-one days old - so an age hold asks for the oldest
 * invoice in full. That is also the honest ask on the phone.
 */
export function depositToClear(input: {
  policy: BillingPolicy;
  openInvoices: { balanceCents: number; daysLate: number }[];
}): number {
  const byAge = [...input.openInvoices]
    .filter((i) => input.policy.holdDays > 0 && i.daysLate >= input.policy.holdDays)
    .reduce((n, i) => n + i.balanceCents, 0);
  const balance = input.openInvoices.reduce((n, i) => n + i.balanceCents, 0);
  const byAmount = input.policy.holdAmountCents > 0
    ? Math.max(0, balance - input.policy.holdAmountCents + 1)
    : 0;
  return Math.max(byAge, byAmount);
}
